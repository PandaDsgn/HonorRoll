---
title: HonorRoll OCR
emoji: 📝
colorFrom: blue
colorTo: yellow
sdk: gradio
sdk_version: 5.50.0
app_file: app.py
---

# HonorRoll Handwriting-Features Space

Computes a pixel-statistics handwriting-style fingerprint (stroke width,
slant angle, ink density) from scanned answer-sheet PDFs for
[HonorRoll](https://pandadsgn.github.io/HonorRoll/) — used only as a
review-only plagiarism/impersonation signal, never to read or grade the
actual content. The Gradio web UI this renders is never actually used by a
person — the backend calls the `handwriting-features` function
programmatically via Gradio's auto-generated API (see
`backend/ocrClient.js`, using `@gradio/client`). Gradio SDK, not Docker:
Docker Spaces now require a paid HF plan, Gradio Spaces still run on the
free tier.

**Text transcription lives elsewhere now.** This Space used to also run
EasyOCR (line detection) + TrOCR (`microsoft/trocr-base-handwritten`) to
read the actual handwriting, but TrOCR-base-handwritten is trained only on
IAM — natural handwritten English prose — and produced confident nonsense
on anything else (code, math notation, chemistry symbols, Greek letters).
Text transcription moved to the Gemini API directly from `ocrClient.js`,
which has broad multimodal training and actually handles that variety.

Two layers of access control:
1. **Space visibility is Private** — calling it at all requires a Hugging Face access token for an account with access to this Space (the backend's `HF_TOKEN` env var).
2. **A shared secret**, passed as the function's second argument, checked against this Space's own `OCR_SHARED_SECRET` secret — a second gate in case visibility is ever flipped public.

Inputs: a PDF file, and the shared secret string. Returns:

```json
{
  "handwriting_features": { "stroke_width_hist": [...], "slant_angle_hist": [...], "ink_density": 0.12 }
}
```

See `app.py` — pure PyMuPDF (PDF rasterization) + OpenCV/numpy (the
fingerprint itself), no ML model, no torch.
