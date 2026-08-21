# HonorRoll handwriting-features Space.
#
# Used to also be the OCR recognizer (EasyOCR detection + TrOCR reading),
# but TrOCR-base-handwritten is trained only on IAM — natural handwritten
# English prose — and produced confident nonsense on anything else: code,
# math notation, chemistry symbols, Greek letters. Text transcription moved
# to the Gemini API (see backend/ocrClient.js), which has broad multimodal
# training and actually handles that variety. What's left here is the one
# thing an LLM call can't produce: compute_handwriting_features() below is
# a pure pixel-statistics style fingerprint (stroke width, slant, ink
# density), used only as a review-only plagiarism/impersonation signal
# (see scan_handwriting_flags in backend/index.js) — never auto-penalizes,
# never touches text content at all.
#
# Deployed as a Hugging Face Space on the Gradio SDK — Docker Spaces now
# require a paid HF plan; Gradio Spaces still run on HF's free tier, which
# for Gradio specifically means ZeroGPU hardware (a shared GPU pool,
# attached only for the duration of a function decorated with @spaces.GPU
# below — HF's runtime refuses to even start a Gradio Space on this tier
# without at least one such function). This workload is pure CPU (cv2/
# numpy/pymupdf, no torch at all anymore) — the decorator is kept purely to
# satisfy that startup requirement, not because anything here needs a GPU.
# Gradio's own web UI is unused here — the backend calls this
# programmatically via its auto-generated API (see backend/ocrClient.js,
# which uses @gradio/client).
import os

import cv2
import fitz  # PyMuPDF
import gradio as gr
import numpy as np
import spaces

SHARED_SECRET = os.environ.get("OCR_SHARED_SECRET", "")

PDF_RENDER_DPI = 200  # rasterization resolution


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
# note at the top of this file) even though this function body never
# touches a GPU — duration kept low since there's nothing here that could
# ever run long.
#
# gr.File defaults to handing the function a local filepath (Gradio saves
# the uploaded/transferred file to a temp path itself) — read as bytes here
# same as the old FastAPI version's `await file.read()` did.
@spaces.GPU(duration=30)
def run_handwriting_features(pdf_file, shared_secret):
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

    if not page_images:
        return {"handwriting_features": None}

    # Computed from the first page only — a coarse style fingerprint, not
    # per-page detail; averaging every page adds cost for negligible signal
    # gain at this granularity.
    handwriting_features = compute_handwriting_features(page_images[0])
    return {"handwriting_features": handwriting_features}


# api_name="handwriting-features" is what the backend's @gradio/client call
# targets (client.predict('/handwriting-features', [...])) — the Gradio web
# UI this also renders is never actually used by anyone, it's just what
# hosting the function on Gradio's free tier requires.
demo = gr.Interface(
    fn=run_handwriting_features,
    inputs=[
        gr.File(label="Scanned answer sheet (PDF)", file_types=[".pdf"], type="filepath"),
        gr.Textbox(label="Shared secret", type="password"),
    ],
    outputs=gr.JSON(label="Result"),
    api_name="handwriting-features",
    title="HonorRoll Handwriting Features",
)

if __name__ == "__main__":
    demo.launch()
