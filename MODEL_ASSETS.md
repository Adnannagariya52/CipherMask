# Model & Runtime Assets

All runtime ML models, WASM binaries, and language packs are provisioned **at build/setup time** via `npm run setup:assets` (`scripts/setup-assets.mjs`) and verified against SHA-256 digests recorded in `public/assets/manifest.json` via `npm run verify:assets`. No runtime downloads occur from external CDNs.

---

## Asset Summary

| Feature | Asset / Package | License | Destination | Provenance / Revision | Approximate Size |
| --- | --- | --- | --- | --- | --- |
| **OCR** | `tesseract.js` v7.0.0 worker & `tesseract.js-core` JS/WASM | Apache-2.0 | `public/assets/ocr/worker/`, `public/assets/ocr/core/` | Local `node_modules` | ~43.2 MiB (all SIMD/LSTM variants) |
| **OCR Lang** | English fast traineddata (`eng.traineddata.gz`) | Apache-2.0 | `public/assets/ocr/lang/eng.traineddata.gz` | `naptha/tessdata@4.0.0_fast` | 1.94 MiB |
| **Vision** | `@mediapipe/tasks-vision` v1.2.3 WASM | Apache-2.0 | `public/assets/vision/wasm/` | Local `node_modules` | ~28.6 MiB |
| **Face Detector** | `blaze_face_short_range.tflite` (float16) | Apache-2.0 | `public/assets/vision/models/blaze_face_short_range.tflite` | Google MediaPipe Models (`float16/1`) | 224.4 KiB |
| **Segmentation** | `selfie_segmenter.tflite` (float16) | Apache-2.0 | `public/assets/vision/models/selfie_segmenter.tflite` | Google MediaPipe Models (`float16/latest`) | 243.7 KiB |
| **Sample Fixture** | `portrait.jpg` | Apache-2.0 | `public/assets/samples/portrait.jpg` | Google MediaPipe testdata | 172.4 KiB |
| **NER Runtime** | `onnxruntime-web` WASM/MJS (`ort-wasm-simd-threaded*`) | MIT | `public/assets/ner/wasm/` | Local `node_modules` | ~37.3 MiB |
| **NER Model** | `Xenova/bert-base-NER` (`model_quantized.onnx` + tokenizer) | MIT | `public/assets/ner/models/Xenova/bert-base-NER/` | Hugging Face pinned commit `8e892123e8b7c2c0c2bd1dcb598b7d244c4e53aa` | ~106.7 MiB |

---

## Provisioning & Verification Commands

```bash
npm run setup:assets
npm run verify:assets
```

- `setup-assets.mjs` downloads to `.tmp` files, checks HTTP status, file size caps, and magic signatures (`gzip`, `json`, `wasm`), computes local SHA-256 digests, and writes `public/assets/manifest.json`.
- Note: SHA-256 digests in `manifest.json` are local integrity baselines computed at setup time, not upstream vendor-signed PGP attestations.
- **GitHub Large-File Exclusion**: `public/assets/ner/models/Xenova/bert-base-NER/onnx/model_quantized.onnx` (~103.9 MiB / 108,952,255 bytes) exceeds GitHub's 100 MiB file size limit and is excluded via `.gitignore`. Clone the repository and run `npm run setup:assets && npm run verify:assets` to provision and verify it locally.
- **Offline Usage**: After building (`npm run build`) and serving (`npm run preview`), open **Privacy Center** and click **Prepare All Offline Models** to precache all `/assets/` files into the versioned Service Worker cache (`ciphermask-models-v1`). Ensure at least ~250 MiB of browser cache quota is available if caching all optional NER weights.
