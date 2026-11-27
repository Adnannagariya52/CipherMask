# CipherMask — 2–3 Minute Judging Demo Guide

> **Opening Line**: *"Removing an email from a document is easy. The harder problem is knowing what still exposes someone's identity—even inside an image or a supposedly anonymized dataset."*

---

## Step 1: Text Shield (Mandatory Core + Leak Hunter)

1. Open CipherMask in **Text Shield** (default landing module).
2. Click **Load Noisy Sample**.
   - **Expected**:
     - **11** accepted detections across Email (`3`), Phone (`2`), PAN (`2`), Aadhaar (`1`), Credit Card (`1`), IPv4 (`1`), IPv6 (`1`).
     - **4** rejected candidates in the **Rejected** inspector tab:
       - `4111 1111 1111 1112` — *Failed Luhn mod-10 checksum* (never leaks as a shorter phone/Aadhaar substring).
       - `2345 6789 0125` — *Matches 12-digit Aadhaar format but failed Verhoeff checksum*.
       - `999.168.1.100` — *Rejected invalid IPv4: octet out of 0–255 range*.
       - `2.4.1.0` — *Rejected: preceded by version/release prefix (`v`)*.
     - Leak Hunter catches `support [at] ciphermask-demo [dot] org`.
3. Switch between **Full Mask** (`[REDACTED]`), **Partial Mask** (`XXXX XXXX XXXX 1111`, `XXXX XXXX 0124`, `XXXXXX234F`), and **Consistent Pseudonym** (`EMAIL_01` used identically for both `priya.sharma@example.org` and `priya.sharma@EXAMPLE.ORG`; `EMAIL_02` for the obfuscated email; `PAN_01` twice; `PHONE_01` twice).
4. Click **Download Sanitized .TXT** to export the file and generate a SHA-256 audit receipt.

---

## Step 2: Vision Shield (Real Local OCR, QR, Face Detection & Pixel Flattening)

1. Click **Vision Shield** in the sidebar.
2. Click **Sample Ticket + QR** -> **Scan OCR + QR**.
   - **Expected**: Local `jsQR` locates the QR badge and local `tesseract.js` OCR maps detected PII text (`Email`, `Phone`, `PAN`, `Aadhaar`, `Card`, `IPv4`) to bounding boxes.
3. Click **+ Add Box** (or use **Draw Box**) to add a manual mask.
4. Click **Export Flattened Image** -> downloads a newly encoded PNG with zero editable overlay layers and opaque mask pixels verified.
5. Click **Sample Portrait (Faces)** -> **Detect Faces**.
   - **Expected**: Local MediaPipe `BlazeFace` detects `FACE_01`; toggle **Blur** / **Pixelate** / **Solid Mask** and inspect live Canvas preview.

---

## Step 3: Data Shield (CSV + K-Anonymity + Policy Optimizer)

1. Click **Data Shield** in the sidebar.
2. Click **Load Risk & K-Anonymity Sample** (16 synthetic employee/clinic records).
   - **Expected**:
     - Direct identifiers (`Employee_ID`, `Full_Name`, `Email`, `Phone`) are consistently pseudonymized across rows (Row 1 and Row 14 share `Aarav Mehta`'s Name/Email/Phone pseudonyms while keeping distinct `Employee_ID` tokens).
     - Yet under Quasi-Identifiers (`Age`, `City`, `Occupation`), **k_min = 1** with singleton rows (e.g. `29, Solapur, Radiologist`).
3. Keep Target `k=2` and click **Run Generalization Optimizer**.
   - **Expected**: Optimizer evaluates age buckets, city→state hierarchy, occupation→sector hierarchy, and finds a feasible policy achieving **k_min >= 2** and **0 singleton rows** without dropping any rows.
4. Click **Export Sanitized .CSV**.

---

## Step 4: Audit Receipt, Benchmark Lab & Offline Proof

1. Open **Benchmark Lab** -> **Run Benchmark Suite** -> inspect live TP/FP/FN scores over 72 synthetic fixtures.
2. Open **Audit & Verify** -> view the exact SHA-256 digest of your latest export and test the **Local Receipt Integrity Checker**.
3. Open **Privacy Center** -> verify the Service Worker offline shell & local asset manifest, then disable network connectivity (`Offline` in DevTools) and reload to prove local operation without external endpoints.

> **Closing Line**: *"CipherMask helps you detect, reduce, and verify privacy exposure without giving another server your sensitive data."*
