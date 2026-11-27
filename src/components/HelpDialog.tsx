import React, { useEffect } from 'react';
import { X, Shield, HelpCircle } from 'lucide-react';

interface HelpDialogProps {
  open: boolean;
  onClose: () => void;
}

export const HelpDialog: React.FC<HelpDialogProps> = ({ open, onClose }) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#101828]/40 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ciphermask-help-title"
    >
      <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto ae-card p-6 sm:p-8 shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#EDF0F4] pb-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#E1F5EF] text-[#087F6D] flex items-center justify-center">
              <HelpCircle className="w-5 h-5" aria-hidden="true" />
            </div>
            <h2 id="ciphermask-help-title" className="text-xl font-semibold text-[#101828]">
              CipherMask Guide &amp; Honest Limitations
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close help dialog"
            className="rounded-lg p-2 text-[#64748B] hover:text-[#101828] hover:bg-[#F1F5F9] cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-5 text-[15px] text-[#475569] leading-relaxed">
          <section>
            <h3 className="font-semibold text-[#101828] mb-1.5">1. Structured Detectors &amp; Checksums</h3>
            <p>
              CipherMask validates Emails, Phone Numbers (<code>libphonenumber-js</code>), IPv4/IPv6 (<code>ipaddr.js</code>),
              Indian PAN (5 letters + 4 digits + 1 letter), Aadhaar (12 digits starting 2–9 + <strong>Verhoeff</strong> check digit),
              and Credit Cards (13–19 digits + <strong>Luhn</strong> mod-10 check digit). Checksums validate format only, not whether an account or identity exists.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-[#101828] mb-1.5">2. Three Redaction Modes</h3>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong className="text-[#101828]">Full Mask</strong>: Replaces each included entity with fixed <code>[REDACTED]</code>.</li>
              <li><strong className="text-[#101828]">Partial Mask</strong>: Retains limited context (e.g., last 4 digits of card/Aadhaar). Do not treat partial masking as anonymity.</li>
              <li><strong className="text-[#101828]">Consistent Pseudonym</strong>: Maps recurring normalized values to the same token (e.g., <code>EMAIL_01</code>) across the active session.</li>
            </ul>
          </section>

          <section>
            <h3 className="font-semibold text-[#101828] mb-1.5">3. Vision Shield &amp; OCR</h3>
            <p>
              OCR (Tesseract.js), face detection (MediaPipe BlazeFace), QR/barcodes (jsQR/ZXing), and metadata stripping run inside your browser.
              Exported images are freshly flattened Canvas encodings without editable overlay layers or original EXIF/GPS headers.
              Opaque solid masks are recommended over blur/pixelation for high-risk text or faces.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-[#101828] mb-1.5">4. K-Anonymity &amp; Policy Optimizer</h3>
            <p>
              In Data Shield, <code>k_min</code> measures the smallest equivalence class across your chosen quasi-identifier columns in the current CSV sample.
              It is conditional on your column selection and is not a guarantee of anonymity or re-identification probability.
            </p>
          </section>

          <div className="rounded-xl border border-[#E2E8F0] bg-[#F7F9FC] p-4 flex items-start gap-3 text-sm text-[#475569]">
            <Shield className="w-5 h-5 text-[#087F6D] shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              All processing runs client-side with zero document uploads. CipherMask does not claim regulatory certification or protection against a compromised OS or malicious browser extension.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
