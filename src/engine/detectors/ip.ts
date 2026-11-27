import ipaddr from 'ipaddr.js';
import type { DetectionCandidate } from '../types.ts';

// Candidate dotted-quad sequence (capturing >255 octets too so we can reject invalid IPs cleanly)
const IPV4_CANDIDATE_RE = /(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g;

// General IPv6 candidate token (including compressed :: and IPv4-mapped ::ffff:a.b.c.d),
// validated authoritatively by ipaddr.IPv6.isValid().
const IPV6_CANDIDATE_RE =
  /(?<![A-Za-z0-9:])([0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?:\.\d{1,3}){0,3})(?![A-Za-z0-9:])/g;

const VERSION_PREFIX_RE = /(?:^|[\s(])(?:v|ver|version|release|build|sdk|api)[=: ]*$/i;

export function detectIps(text: string): { accepted: DetectionCandidate[]; rejected: DetectionCandidate[] } {
  const accepted: DetectionCandidate[] = [];
  const rejected: DetectionCandidate[] = [];
  const ipv6Ranges: Array<{ start: number; end: number }> = [];

  // 1. Detect IPv6 first so embedded IPv4 (::ffff:192.0.2.128) is not double-counted as separate IPv4
  IPV6_CANDIDATE_RE.lastIndex = 0;
  let m6: RegExpExecArray | null;
  while ((m6 = IPV6_CANDIDATE_RE.exec(text)) !== null) {
    const raw = m6[1];
    const start = m6.index + (m6[0].length - raw.length);
    const end = start + raw.length;
    if (!raw.includes(':')) continue;
    // Avoid matching time like 12:30:45 unless it has :: or >= 3 colons (or valid IPv6)
    const colonCount = (raw.match(/:/g) || []).length;
    if (colonCount < 2) continue;

    if (ipaddr.IPv6.isValid(raw)) {
      try {
        const parsed = ipaddr.IPv6.parse(raw);
        // Reject HH:MM:SS timestamps that happen to look like 3 hex groups? Wait: 12:30:45 only has 2 colons and isn't valid IPv6 anyway!
        const canonical = parsed.toNormalizedString();
        ipv6Ranges.push({ start, end });
        accepted.push({
          id: `ipv6_${start}_${end}`,
          type: 'IPV6',
          start,
          end,
          rawText: raw,
          maskedPreview: '',
          canonicalKey: canonical,
          method: 'parser',
          validationStatus: 'structurally_valid',
          evidence: `Validated IPv6 address (normalized ${canonical}).`,
          reviewStatus: 'included',
        });
      } catch {
        // Not valid IPv6
      }
    }
  }

  // 2. Detect IPv4 candidates
  IPV4_CANDIDATE_RE.lastIndex = 0;
  let m4: RegExpExecArray | null;
  while ((m4 = IPV4_CANDIDATE_RE.exec(text)) !== null) {
    const raw = m4[1];
    const start = m4.index;
    const end = start + raw.length;

    // Skip if inside an IPv6 IPv4-mapped address
    if (ipv6Ranges.some((r) => start >= r.start && end <= r.end)) {
      continue;
    }

    const prefix = text.slice(Math.max(0, start - 16), start);
    const looksLikeVersion = VERSION_PREFIX_RE.test(prefix);

    // Check strict 4-part decimal IPv4 (rejects leading-zero octal ambiguity if any octet >1 digit starts with 0)
    const octets = raw.split('.');
    const hasLeadingZeroOctet = octets.some((o) => o.length > 1 && o.startsWith('0'));
    const validFourPart = ipaddr.IPv4.isValidFourPartDecimal(raw) && !hasLeadingZeroOctet;

    if (validFourPart) {
      if (looksLikeVersion) {
        rejected.push({
          id: `ipv4_ver_${start}_${end}`,
          type: 'IPV4',
          start,
          end,
          rawText: raw,
          maskedPreview: '',
          canonicalKey: raw,
          method: 'parser',
          validationStatus: 'rejected',
          evidence: 'Rejected: preceded by version/release prefix.',
          reviewStatus: 'excluded',
        });
        continue;
      }

      const parsed = ipaddr.IPv4.parse(raw);
      accepted.push({
        id: `ipv4_${start}_${end}`,
        type: 'IPV4',
        start,
        end,
        rawText: raw,
        maskedPreview: '',
        canonicalKey: parsed.toString(),
        method: 'parser',
        validationStatus: 'structurally_valid',
        evidence: 'Validated strict 4-octet decimal IPv4 (0–255).',
        reviewStatus: 'included',
      });
    } else {
      rejected.push({
        id: `ipv4_bad_${start}_${end}`,
        type: 'IPV4',
        start,
        end,
        rawText: raw,
        maskedPreview: '',
        canonicalKey: raw,
        method: 'parser',
        validationStatus: 'rejected',
        evidence: hasLeadingZeroOctet
          ? 'Rejected invalid IPv4: leading zero in octet.'
          : 'Rejected invalid IPv4: octet out of 0–255 range.',
        reviewStatus: 'excluded',
      });
    }
  }

  return { accepted, rejected };
}
