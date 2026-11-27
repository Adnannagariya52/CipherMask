import type { DetectionCandidate } from '../types.ts';

// Standard email pattern: avoids double dots, leading/trailing dots, and trailing punctuation.
const EMAIL_RE =
  /(?<![A-Za-z0-9._%+-])([A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9])?)@((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24})(?![A-Za-z0-9-]|\.[A-Za-z0-9.-])/g;

// Leak Hunter obfuscated email patterns: [at], (at), {at}, [dot], (dot), {dot}
// and strict spaced " at " / " dot " only when terminating in a common TLD.
const OBFUSCATED_EMAIL_RE =
  /(?<![A-Za-z0-9._%+-])([A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,40}[A-Za-z0-9])?)(?:\s*(?:\[at\]|\(at\)|\{at\}|\bat\b)\s*)((?:[A-Za-z0-9-]{1,40}(?:\s*(?:\[dot\]|\(dot\)|\{dot\}|\.)\s*))+(?:com|org|net|edu|gov|io|co|in|uk|de|ai|app|dev|tech|info|biz|me|us|ca|au|co\.in|co\.uk|org\.in))(?![A-Za-z0-9.-])/gi;

const BRACKET_OBFUSCATED_RE =
  /(?<![A-Za-z0-9._%+-])([A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,40}[A-Za-z0-9])?)\s*(?:\[at\]|\(at\)|\{at\})\s*([A-Za-z0-9-]+(?:\s*(?:\[dot\]|\(dot\)|\{dot\}|\.)\s*[A-Za-z0-9-]+)*\s*(?:\[dot\]|\(dot\)|\{dot\}|\.)\s*[A-Za-z]{2,16})(?![A-Za-z0-9.-])/gi;

function isValidLocalPart(local: string): boolean {
  return local.length >= 1 && local.length <= 64 && !local.includes('..');
}

function isValidDomain(domain: string): boolean {
  if (domain.length > 253 || domain.includes('..')) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  return labels.every((l) => l.length >= 1 && l.length <= 63 && !l.startsWith('-') && !l.endsWith('-'));
}

export function canonicalizeEmail(local: string, domain: string): string {
  // Preserve local-part case by default; domain is case-insensitive
  return `${local}@${domain.toLowerCase()}`;
}

export function detectEmails(text: string): DetectionCandidate[] {
  const results: DetectionCandidate[] = [];
  EMAIL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMAIL_RE.exec(text)) !== null) {
    const raw = m[0];
    const local = m[1];
    const domain = m[2];
    if (!isValidLocalPart(local) || !isValidDomain(domain)) continue;
    results.push({
      id: `email_${m.index}_${m.index + raw.length}`,
      type: 'EMAIL',
      start: m.index,
      end: m.index + raw.length,
      rawText: raw,
      maskedPreview: '',
      canonicalKey: canonicalizeEmail(local, domain),
      method: 'regex',
      validationStatus: 'structurally_valid',
      evidence: 'Matched email local@domain syntax with valid labels and TLD.',
      reviewStatus: 'included',
    });
  }
  return results;
}

export function detectObfuscatedEmails(text: string): DetectionCandidate[] {
  const results: DetectionCandidate[] = [];
  const seen = new Set<string>();

  for (const re of [BRACKET_OBFUSCATED_RE, OBFUSCATED_EMAIL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      const key = `${start}:${end}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const raw = m[0];
      const local = m[1].trim();
      const domainRaw = m[2]
        .replace(/\s*(?:\[dot\]|\(dot\)|\{dot\})\s*/gi, '.')
        .replace(/\s*\.\s*/g, '.')
        .trim();

      if (!isValidLocalPart(local) || !isValidDomain(domainRaw)) continue;

      results.push({
        id: `leak_email_${start}_${end}`,
        type: 'EMAIL',
        start,
        end,
        rawText: raw,
        maskedPreview: '',
        canonicalKey: canonicalizeEmail(local, domainRaw),
        method: 'leak_hunter',
        validationStatus: 'pattern_match',
        evidence: 'Leak Hunter detected obfuscated email separator ([at]/(at)/[dot]/(dot)/at/dot).',
        reviewStatus: 'included',
        fromLeakHunter: true,
      });
    }
  }
  return results;
}
