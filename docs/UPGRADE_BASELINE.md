# CipherMask V2 Upgrade Baseline Inventory

Captured: 2026-11-27

## 1. Environment & Toolchain
- **OS**: Windows (PowerShell)
- **Node.js**: `v24.16.0`, **npm**: `11.13.0`, **Git**: `2.55.0` (not initialized as `.git` repo)
- **Disk Free (C:)**: ~136.5 GiB (`146,601,218,048` bytes)
- **Framework**: React `19.3.1`, TypeScript `6.0.3`, Vite `8.4.0`, Tailwind CSS `4.3.5` (`@tailwindcss/vite`)

## 2. Existing V1 Modules Preserved
- **Detection & Redaction (`src/engine/`)**:
  - `types.ts`, `normalization.ts`, `resolver.ts`, `pseudonyms.ts`, `redaction.ts`, `verification.ts`, `pipeline.ts`
  - Detectors: `email.ts`, `phone.ts` (`libphonenumber-js`), `ip.ts` (`ipaddr.js`), `pan.ts`, `aadhaar.ts` + `validators/verhoeff.ts`, `card.ts` + `validators/luhn.ts`
- **Vision (`src/engine/vision/`)**: `decode.ts`, `geometry.ts`, `metadata.ts` (`exifr`), `codes.ts` (`jsqr`, `@zxing/library`), `ocr.ts` (`tesseract.js`), `face.ts` (`@mediapipe/tasks-vision`), `render.ts`, `sampleGenerator.ts`
- **CSV / Data (`src/engine/csv/`)**: `parse.ts`, `serialize.ts` (`papaparse`), `classify.ts`, `risk.ts`, `optimizer.ts`
- **Crypto & Audit (`src/engine/crypto/`, `src/engine/audit.ts`)**: `hash.ts`, `vault.ts` (`PBKDF2-HMAC-SHA256` 600k + `AES-GCM-256`), `restore.ts`, `audit.ts`
- **NER (`src/engine/ner/`, `src/workers/ner.worker.ts`)**: `@huggingface/transformers` + `Xenova/bert-base-NER` (`model_quantized.onnx`)
- **UI Features (`src/features/`)**: `text/TextShield.tsx`, `vision/VisionShield.tsx`, `data/DataShield.tsx`, `data/IdentityExposureGraph.tsx`, `benchmark/BenchmarkLab.tsx`, `audit/AuditPanel.tsx`, `vault/IdentityVault.tsx`, `privacy/PrivacyCenter.tsx`, `promptLog/PromptLogView.tsx`
- **Provisioned Assets (`public/assets/`)**: 37 verified files (OCR 45.15 MiB, Vision 29.24 MiB, NER 144.04 MiB).

## 3. Pre-Upgrade Verification Baseline
- `npm run verify:assets` -> exit `0` (37/37 ready)
- `npm run verify` (`typecheck`, `lint`, `vitest run`, `vite build`) -> exit `0` (17/17 unit tests passed)
- `npm run test:e2e` (Playwright Chromium on `dist/` preview) -> exit `0` (4/4 specs passed)

## 4. V2 Prerequisites Discovered
- **Gemma 3 4B INT4 Web (`litert-community/Gemma3-4B-IT/gemma3-4b-it-int4-web.task`)**: Gated Hugging Face repository (`HTTP 401 GatedRepo`, `hf auth whoami`: Not logged in). Requires owner's Hugging Face license acceptance & local download/import.
- **Cloud Gemini**: Disabled by default pending organizer authorization, model ID selection, and local relay `.env.local` configuration.
