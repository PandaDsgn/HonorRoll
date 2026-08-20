---
title: HonorRoll OCR
emoji: 📝
colorFrom: blue
colorTo: yellow
sdk: gradio
sdk_version: 5.50.0
app_file: app.py
---

# HonorRoll OCR Space

Reads scanned handwritten answer-sheet PDFs for [HonorRoll](https://pandadsgn.github.io/HonorRoll/). The Gradio web UI this renders is never actually used by a person — the backend calls the `ocr` function programmatically via Gradio's auto-generated API (see `backend/ocrClient.js`, using `@gradio/client`). Gradio SDK, not Docker: Docker Spaces now require a paid HF plan, Gradio Spaces still run on the free CPU tier.

Two layers of access control:
1. **Space visibility is Private** — calling it at all requires a Hugging Face access token for an account with access to this Space (the backend's `HF_TOKEN` env var).
2. **A shared secret**, passed as the function's second argument, checked against this Space's own `OCR_SHARED_SECRET` secret — a second gate in case visibility is ever flipped public.

Inputs: a PDF file, and the shared secret string. Returns:

```json
{
  "pages": [{ "page": 1, "text": "...", "confidence": 0.83 }],
  "handwriting_features": { "stroke_width_hist": [...], "slant_angle_hist": [...], "ink_density": 0.12 }
}
```

See `app.py` for the pipeline: EasyOCR's detector locates lines/words, TrOCR (`microsoft/trocr-base-handwritten`) reads each one.
