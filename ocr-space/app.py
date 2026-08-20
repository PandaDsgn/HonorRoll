# HonorRoll OCR Space — reads scanned handwritten answer sheets.
#
# TrOCR (microsoft/trocr-base-handwritten) is the actual recognizer: it's
# the only one of the candidates considered (Tesseract, EasyOCR, TrOCR)
# actually trained on handwriting (the IAM dataset). But TrOCR only reads
# text inside an already-cropped line/word image — it has no line-detection
# of its own. EasyOCR's built-in detector supplies that: its own recognized
# text is thrown away, only its bounding boxes are used, then each crop is
# handed to TrOCR for the real reading.
#
# Deployed as a Hugging Face Space on the Gradio SDK — Docker Spaces now
# require a paid HF plan (a policy change made after this was originally
# planned as a Docker/FastAPI app); Gradio Spaces still run on HF's free
# tier, which for Gradio specifically means ZeroGPU hardware (a shared GPU
# pool, attached only for the duration of a function decorated with
# @spaces.GPU below — HF's runtime refuses to even start a Gradio Space on
# this tier without at least one such function). This workload doesn't
# actually need GPU acceleration — the decorator exists to satisfy that
# startup check, not because anything here calls .cuda(). Gradio's own web
# UI is unused here — the backend calls this programmatically via its
# auto-generated API (see backend/ocrClient.js, which uses @gradio/client).
# Models load once at import time, not per-request, so the "slow first
# request" a caller sees is the Space itself waking from sleep, not model
# loading.
import os

import cv2
import easyocr
import fitz  # PyMuPDF
import gradio as gr
import numpy as np
import spaces
import torch
import torch.nn.functional as F
from PIL import Image
from transformers import TrOCRProcessor, VisionEncoderDecoderModel

SHARED_SECRET = os.environ.get("OCR_SHARED_SECRET", "")

# Loaded once at import time (module scope), shared across every request —
# reloading either model per-request would make a multi-page PDF take
# minutes instead of seconds.
print("Loading EasyOCR detector...")
_reader = easyocr.Reader(["en"], gpu=torch.cuda.is_available())

print("Loading TrOCR (microsoft/trocr-base-handwritten)...")
_processor = TrOCRProcessor.from_pretrained("microsoft/trocr-base-handwritten")
_model = VisionEncoderDecoderModel.from_pretrained("microsoft/trocr-base-handwritten")
_model.eval()

PDF_RENDER_DPI = 200  # rasterization resolution — legible for OCR without being excessive


def render_pdf_pages(pdf_bytes: bytes) -> list[np.ndarray]:
    """PDF bytes -> list of BGR numpy images, one per page."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pages = []
    zoom = PDF_RENDER_DPI / 72
    matrix = fitz.Matrix(zoom, zoom)
    for page in doc:
        pix = page.get_pixmap(matrix=matrix, alpha=False)
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        if pix.n == 3:
            img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        pages.append(img)
    doc.close()
    return pages


def order_boxes(boxes: list) -> list[int]:
    """Returns box indices in reading order (top-to-bottom, left-to-right),
    grouping boxes into lines by y-proximity rather than a pure y-sort —
    handwritten lines are rarely perfectly horizontal, and a pure sort would
    interleave words from adjacent lines whenever one dips slightly."""
    if not boxes:
        return []
    items = []
    for i, box in enumerate(boxes):
        ys = [p[1] for p in box]
        xs = [p[0] for p in box]
        items.append({"idx": i, "cy": sum(ys) / 4, "cx": sum(xs) / 4, "h": max(ys) - min(ys)})
    avg_h = sum(it["h"] for it in items) / len(items)
    line_thresh = max(avg_h * 0.6, 5)
    items.sort(key=lambda it: it["cy"])

    lines = [[items[0]]]
    for it in items[1:]:
        if abs(it["cy"] - lines[-1][-1]["cy"]) <= line_thresh:
            lines[-1].append(it)
        else:
            lines.append([it])

    ordered = []
    for line in lines:
        line.sort(key=lambda it: it["cx"])
        ordered.extend(it["idx"] for it in line)
    return ordered


def crop_box(image: np.ndarray, box: list, padding: int = 4) -> np.ndarray:
    xs = [p[0] for p in box]
    ys = [p[1] for p in box]
    x0, x1 = max(0, int(min(xs)) - padding), min(image.shape[1], int(max(xs)) + padding)
    y0, y1 = max(0, int(min(ys)) - padding), min(image.shape[0], int(max(ys)) + padding)
    if x1 <= x0 or y1 <= y0:
        return None
    return image[y0:y1, x0:x1]


def read_crop_with_trocr(crop_bgr: np.ndarray) -> tuple[str, float]:
    """Runs one cropped line/word image through TrOCR, returns (text, confidence).
    Confidence is the average max-softmax probability across generated
    tokens — a lightweight proxy, not a calibrated probability, but useful
    for flagging low-confidence reads for teacher attention."""
    pil_img = Image.fromarray(cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB)).convert("RGB")
    pixel_values = _processor(images=pil_img, return_tensors="pt").pixel_values
    with torch.no_grad():
        out = _model.generate(pixel_values, output_scores=True, return_dict_in_generate=True, max_new_tokens=64)
    text = _processor.batch_decode(out.sequences, skip_special_tokens=True)[0].strip()
    if out.scores:
        probs = [F.softmax(s, dim=-1).max().item() for s in out.scores]
        confidence = sum(probs) / len(probs)
    else:
        confidence = 0.0
    return text, confidence


def ocr_page(image_bgr: np.ndarray) -> tuple[str, float]:
    """Detects lines/words on one page (EasyOCR, detection only) and reads
    each with TrOCR, reassembled in reading order."""
    detections = _reader.readtext(image_bgr, detail=1)  # [(box, text, conf), ...] — text/conf discarded
    boxes = [d[0] for d in detections]
    order = order_boxes(boxes)

    texts = []
    confidences = []
    for idx in order:
        crop = crop_box(image_bgr, boxes[idx])
        if crop is None or crop.size == 0:
            continue
        text, confidence = read_crop_with_trocr(crop)
        if text:
            texts.append(text)
            confidences.append(confidence)

    page_text = "\n".join(texts)
    page_confidence = sum(confidences) / len(confidences) if confidences else 0.0
    return page_text, page_confidence


def compute_handwriting_features(image_bgr: np.ndarray) -> dict:
    """Stroke-width histogram, slant-angle histogram, ink density — pure
    OpenCV/numpy, no model. Deliberately hand-engineered rather than a
    trained writer-ID model (none is realistically available for free);
    this is a coarse style fingerprint, used only as a review-only signal
    (see scan_handwriting_flags — never auto-penalizes)."""
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    ink_density = float(np.count_nonzero(binary)) / binary.size

    dist = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
    stroke_widths = dist[binary > 0] * 2
    if stroke_widths.size > 0:
        hist, _ = np.histogram(stroke_widths, bins=8, range=(0, 20))
        stroke_hist = (hist / hist.sum()).tolist() if hist.sum() > 0 else [0.0] * 8
    else:
        stroke_hist = [0.0] * 8

    contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    angles = [cv2.minAreaRect(c)[2] for c in contours if cv2.contourArea(c) >= 20]
    if angles:
        hist, _ = np.histogram(angles, bins=12, range=(-90, 90))
        slant_hist = (hist / hist.sum()).tolist() if hist.sum() > 0 else [0.0] * 12
    else:
        slant_hist = [0.0] * 12

    return {
        "stroke_width_hist": stroke_hist,
        "slant_angle_hist": slant_hist,
        "ink_density": ink_density,
    }


# @spaces.GPU is required for this Space's tier to start at all (see the
# note at the top of this file) — duration=300 matches the timeout
# ocrClient.js uses on the Node side, generous enough for a multi-page PDF
# working through TrOCR line-by-line.
#
# gr.File defaults to handing the function a local filepath (Gradio saves
# the uploaded/transferred file to a temp path itself) — read as bytes here
# same as the old FastAPI version's `await file.read()` did.
@spaces.GPU(duration=300)
def run_ocr(pdf_file, shared_secret):
    if not SHARED_SECRET or shared_secret != SHARED_SECRET:
        return {"error": "Unauthorized"}
    if pdf_file is None:
        return {"error": "A PDF file is required"}

    with open(pdf_file, "rb") as f:
        pdf_bytes = f.read()

    try:
        page_images = render_pdf_pages(pdf_bytes)
    except Exception as exc:
        return {"error": f"Failed to read PDF: {exc}"}

    pages = []
    # Handwriting features are computed once per submission (first page is
    # representative enough for a coarse style fingerprint — averaging every
    # page adds cost for negligible signal gain at this granularity).
    handwriting_features = compute_handwriting_features(page_images[0]) if page_images else None

    for i, image in enumerate(page_images):
        text, confidence = ocr_page(image)
        pages.append({"page": i + 1, "text": text, "confidence": confidence})

    return {"pages": pages, "handwriting_features": handwriting_features}


# api_name="ocr" is what the backend's @gradio/client call targets
# (client.predict('/ocr', [...])) — the Gradio web UI this also renders is
# never actually used by anyone, it's just what hosting the function on
# Gradio's free tier requires.
demo = gr.Interface(
    fn=run_ocr,
    inputs=[
        gr.File(label="Scanned answer sheet (PDF)", file_types=[".pdf"], type="filepath"),
        gr.Textbox(label="Shared secret", type="password"),
    ],
    outputs=gr.JSON(label="Result"),
    api_name="ocr",
    title="HonorRoll OCR",
)

if __name__ == "__main__":
    demo.launch()
