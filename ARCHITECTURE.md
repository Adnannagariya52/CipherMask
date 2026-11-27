# CipherMask Architecture

CipherMask is a 100% client-side, static single-page web application (React + TypeScript + Vite) designed as a multimodal privacy preparation workspace. There is no application backend, no database, no remote API, and no runtime telemetry.

---

## 1. Execution & Trust Boundary

1. **Static Same-Origin Assets (`public/` -> `dist/`)**:
   - Application JS/CSS bundles, Web Workers, WASM runtimes, and local ML model weights (`/assets/ocr/`, `/assets/vision/`, `/assets/ner/`, `/assets/samples/`) are served strictly from the same application origin.
   - Production `index.html` enforces a strict Content Security Policy (`default-src 'self'; connect-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' blob: data:; ...`) and `dist/_headers` includes `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
2. **Volatile Session Memory**:
   - All raw documents, decoded image bitmaps, OCR outputs, face coordinates, pseudonym maps, and audit previews live strictly in volatile React/worker memory.
   - No `localStorage`, `sessionStorage`, `IndexedDB`, or URL state stores document contents, raw filenames, or vault passphrases.
   - **Reset Session** cancels active jobs, terminates Web Workers retaining state, clears mappings/previews, and revokes object URLs. (JavaScript GC cannot guarantee immediate physical RAM erasure.)

---

## 2. Shared Detection & Redaction Pipeline (`src/engine/`)

- **Normalization & Offset Mapping (`normalization.ts`)**: Builds a Unicode-safe normalized view (stripping zero-width chars, converting fullwidth ASCII and Unicode decimal digits) with per-character UTF-16 `[origStart, origEnd)` maps so normalized hits map back to exact original slices.
- **Modular Detectors (`detectors/`)**:
  - `email.ts`: Structural local/domain rules + Leak Hunter obfuscated `[at]`/`(at)`/`[dot]`/`(dot)` detector.
  - `phone.ts`: `libphonenumber-js` (`IN` default region + international `+` prefixes), filtering out IP dotted quads and dates.
  - `ip.ts`: `ipaddr.js` strict 4-octet decimal IPv4 and compressed/IPv4-mapped IPv6, distinguishing version strings and invalid octets.
  - `pan.ts`: Indian PAN 5A-4N-1A structure with holder-type evidence.
  - `aadhaar.ts` & `validators/verhoeff.ts`: 12-digit structural rule (starts 2–9) + Verhoeff check digit.
  - `card.ts` & `validators/luhn.ts`: 13–19 digit full-run capture + Luhn mod-10 check digit.
- **Overlap Resolver (`resolver.ts`)**: Deterministic priority ordering (`MANUAL > CHECKSUM > STRUCTURAL > PATTERN > NER > UNCERTAIN`), preventing shorter numeric substrings (like Phone/Aadhaar) from leaking out of rejected full Card/Aadhaar/IP runs.
- **Consistent Pseudonyms (`pseudonyms.ts`)**: Volatile `SessionPseudonymAllocator` keyed by `(typeGroup, canonicalKey)` with collision avoidance against preexisting literal tokens (`EMAIL_01`, etc.).
- **Verification (`verification.ts`)**: Independent post-redaction scan using primary detectors + Leak Hunter normalization, distinguishing deliberate exclusions, partial retentions, unreviewed uncertain candidates, and unexpected residuals.

---

## 3. Worker Architecture (`src/workers/`)

- `text.worker.ts`: Runs detection + redaction off the main UI thread with `requestId + sessionId + revision` stale-response rejection.
- `ner.worker.ts`: Lazily loads local `Xenova/bert-base-NER` (`model_quantized.onnx` via `@huggingface/transformers` + local ONNX Runtime WASM) with `env.allowRemoteModels = false`. Uses Unicode-safe overlapping window chunking (`ner/chunking.ts`) and WordPiece/BIO offset aggregation (`ner/adapter.ts`).
- `data.worker.ts`: Runs bounded k-anonymity generalization policy search (`csv/optimizer.ts`) with cancellation support.

---

## 4. Vision Pixel Pipeline (`src/engine/vision/`)

1. **Canonical Decoding (`decode.ts`)**: Validates PNG/JPEG magic bytes and size/megapixel limits (15 MiB / 16 MP), normalizes EXIF orientation once via `createImageBitmap(..., { imageOrientation: 'from-image' })`.
2. **Detectors**:
   - `ocr.ts`: Local `tesseract.js` v7 worker (`workerBlobURL: false`, `cacheMethod: 'none'`, `blocks: true`), mapping character offsets back to word/line bounding boxes.
   - `face.ts`: Local `@mediapipe/tasks-vision` `FaceDetector` (`blaze_face_short_range.tflite`, CPU) and `ImageSegmenter` (`selfie_segmenter.tflite`, CPU).
   - `codes.ts`: Multi-pass `jsQR` + `@zxing/library` `MultiFormatReader`.
   - `metadata.ts`: `exifr` + PNG chunk scanner (`tEXt`, `iTXt`, `zTXt`, `eXIf`).
3. **Flattened Rendering (`render.ts`)**: Draws canonical source once; renders weaker effects (blur with CPU fallback / pixelation) BEFORE opaque solid masks (`alpha=1`, `source-over`) so overlaps cannot restore hidden pixels; exports fresh PNG/JPEG via `canvas.toBlob` without source EXIF headers.

---

## 5. Structured CSV & K-Anonymity (`src/engine/csv/`)

- `parse.ts` / `serialize.ts`: Papa Parse with `dynamicTyping: false` (preserves leading zeros), BOM tracking, delimiter support, row-width diagnostics, and formula-prefix detection (`=`, `+`, `-`, `@`, `\t`, `\r`).
- `classify.ts`: Per-cell PII detection using a session-wide pseudonym allocator + direct-ID column masking.
- `risk.ts`: Collision-free `JSON.stringify` tuple keys over user-selected quasi-identifier columns to compute `k_min`, singleton rows, `rowsBelowTarget`, equivalence class size distributions, and optional `l-diversity`.
- `optimizer.ts`: Evaluates age buckets, ISO date generalizations, sample geography/occupation hierarchies, and optional suppression against weighted normalized utility loss, ranking feasible policies (`k_min >= targetK`).

---

## 6. Cryptography & Vault (`src/engine/crypto/`)

- `hash.ts`: Exact-byte `SHA-256` digests via Web Crypto `subtle.digest`.
- `vault.ts` / `restore.ts`: Optional local reversible vault for pseudonymized TXT/CSV using `PBKDF2-HMAC-SHA256` (600,000 iterations, bounded `[100k..1M]` on decrypt), random 16-byte salt, random 12-byte IV, `AES-GCM-256` with canonical header `additionalData`, and pre-restoration sanitized-byte SHA-256 verification.
