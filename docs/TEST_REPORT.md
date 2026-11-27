# CipherMask V2 Test & Verification Report

Date: 2026-11-27
Environment: Windows (Node `v24.16.0`, npm `11.13.0`), Playwright Chromium `159.0.8154.6`

---

## 1. Automated Command Results

| Check | Command | Exit Code | Observed Result |
| --- | --- | --- | --- |
| Asset Verification (OCR/Vision/NER) | `npm run verify:assets` | `0` | 37/37 verified (`ocr`: 20 / 45.15 MiB, `vision`: 7 / 29.24 MiB, `ner`: 10 / 144.04 MiB) |
| GenAI WASM Verification | `npm run verify:models` | `0` | 6/6 `@mediapipe/tasks-genai` WASM files verified; Gemma 3 4B `.task`: `NEEDS ASSETS` (gated HF repo) |
| TypeScript Check | `npm run typecheck` | `0` | 0 errors |
| ESLint Check | `npm run lint` | `0` | 0 errors (2 non-blocking `react-refresh` warnings) |
| Unit & Contract Tests | `npm test` | `0` | 7/7 files, 26/26 tests passed (Vitest `v5.1.2`) |
| Deploy Bundle Guard | `npm run verify:deploy` | `0` | PASSED: 68 files (`325.6 MiB`), 0 Gemma `.task` binaries, 0 exposed secrets |
| Strict Build | `npm run build:strict` | `0` | Built `dist/` with `connect-src 'self'` CSP, self-hosted `.woff2` fonts, and `precache-manifest.json` |
| Cloud Profile Build | `npm run build:cloud` | `0` | Built `dist/` with optional Gemini relay/origin CSP allowlist (restored `build:strict` after check) |
| Browser E2E + Privacy Sentinels | `npm run test:e2e` | `0` | 5/5 Playwright Chromium specs passed against built `dist/` preview |
| Live Firebase Hosting Check | Playwright on `https://ciphermask-94dbd.web.app` | `0` | Arctic Emerald `#F7F9FC` verified, HTTP `200` on `/` and `/vault`, strict CSP `connect-src 'self'`, `0` external calls, all modules functional |
| Live Protected Cloud + Relay E2E | `$env:PLAYWRIGHT_CLOUD='1'; npx playwright test` | `0` | 1/1 passed: `Auto-Select` (`gemini-flash-lite-latest`), multi-turn sanitized send, local Identity Bridge reveal isolated from Turn 2, relay 422 raw rejection |

---

## 2. Real vs Gated / Pending Validation

- **Real Local & Live Cloud Execution Verified**:
  - Deterministic rules, Luhn/Verhoeff checksums, Leak Hunter normalization, CSV parser/k-anonymity/optimizer, Web Crypto AES-GCM vault, `tesseract.js` OCR, `jsQR` QR detection, `@mediapipe/tasks-vision` `BlazeFace` face detection, Canvas pixel flattening, `JSZip` collection export, Service Worker offline reload, Outbound Privacy Firewall blocking, and live Gemini Flash (`gemini-flash-lite-latest`) multi-turn cloud chat via `optional-relay/`.
- **Pending Owner Action (External / Hardware)**:
  - **Gemma 3 4B INT4 WebGPU Inference**: `litert-community/Gemma3-4B-IT` returned `HTTP 401 GatedRepo` (`hf auth whoami`: Not logged in). End-to-end WebGPU token generation requires the owner to accept the Gemma license on Hugging Face, provide `gemma3-4b-it-int4-web.task`, and run the in-app Smoke Test in Chrome/Edge with WebGPU enabled.
