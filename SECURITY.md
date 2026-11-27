# CipherMask Security & Threat Model

## 1. Security Posture & Scope

CipherMask is a local browser-based data preparation tool. It **does not** claim regulatory compliance (GDPR, HIPAA, DPDP, PCI-DSS), 100% detection recall, guaranteed anonymity, or protection against a compromised operating system, malicious browser extension, or physical device theft.

---

## 2. Threat Model & Implemented Mitigations

| Threat | Risk | Implemented Mitigation | Remaining Limitation |
| --- | --- | --- | --- |
| **External Data Transmission** | Cloud DLP or third-party scripts receive sensitive documents | Zero backend APIs; production CSP `connect-src 'self'`; `env.allowRemoteModels = false` in Transformers.js; Tesseract `cacheMethod: 'none'`; Playwright network sentinel tests verify 0 external requests | Browser extensions or OS-level proxies operate outside page CSP |
| **Accidental Browser Persistence** | Raw PII cached in `localStorage`, `IndexedDB`, URLs, or SW caches | Document state kept strictly in volatile JS/worker memory; Service Worker caches only allowlisted static shell and `/assets/` GET routes; Reset terminates workers & revokes object URLs | JS garbage collection cannot guarantee immediate physical RAM erasure |
| **Unsafe HTML / XSS Rendering** | Malicious `<script>` or HTML in uploaded text/CSV executes in UI | All text & diffs rendered strictly as React text nodes (`DiffViewer.tsx`, `PromptLogView.tsx`); zero `dangerouslySetInnerHTML`, `eval`, or `new Function` | Standard React/browser DOM invariants apply |
| **Spreadsheet Formula Injection** | CSV cells starting with `=`, `+`, `-`, `@` execute when opened in Excel | Formula prefix detector warns before export (`inspectCsvFormulas`) and offers explicit opt-in `' ` prefix escaping (`spreadsheetSafeEscape`) | Escaping alters cell values; users should import CSVs as plain text |
| **Detachable Image Layers / EXIF Leaks** | SVG overlays or retained EXIF GPS expose redacted content | Exported images are freshly flattened Canvas bitmaps (`canvas.toBlob`); opaque masks render after weak effects; `exifr` + PNG chunk re-scan verifies metadata omission | Blur/pixelation can preserve recognizable shapes; opaque solid masks are recommended |
| **Vault Tampering / KDF DoS** | Modified vault JSON or malicious huge iteration count freezes browser | `validateVaultEnvelope` bounds iterations `[100k..1M]`, checks exact 16B salt / 12B IV, authenticates header metadata via AES-GCM `additionalData`, and checks sanitized SHA-256 before restoring | Strength depends on user passphrase entropy; no password recovery |
| **Malicious / Oversized Files** | Browser OOM or parser freeze | Input bounds enforced: 2 MiB TXT, 5 MiB / 20k rows / 100 cols CSV, 15 MiB / 16 MP PNG/JPEG; magic byte validation before decoding | Large workloads depend on client device RAM |

---

## 3. Verification Boundaries

- **Luhn & Verhoeff**: Confirm structural format and check digits only; passing checksums do not prove live card accounts or valid UIDAI Aadhaar numbers.
- **K-Anonymity**: `k_min` is conditional on the selected quasi-identifier columns and current dataset sample; it is not a probability of re-identification and does not protect against external linkage datasets not in the CSV.
- **Audit Receipts**: SHA-256 digests prove that a sanitized file matches its local receipt bytes—not external authenticity or absence of browser compromise.
