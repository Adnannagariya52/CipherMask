import type { EntityType } from '../types.ts';

export interface LabeledExpectation {
  type: EntityType;
  start: number;
  end: number;
}

export interface BenchmarkFixture {
  id: string;
  categoryGroup: 'EMAIL' | 'PHONE' | 'IP' | 'PAN' | 'AADHAAR' | 'CARD' | 'LEAK_HUNTER' | 'NEGATIVE' | 'MIXED' | 'NER';
  description: string;
  text: string;
  expected: LabeledExpectation[];
  expectedRejectedTypes?: EntityType[];
  requiresNer?: boolean;
}

function spanOf(text: string, sub: string, occurrence = 0): { start: number; end: number } {
  let idx = -1;
  let from = 0;
  for (let i = 0; i <= occurrence; i += 1) {
    idx = text.indexOf(sub, from);
    if (idx === -1) throw new Error(`Fixture substring "${sub}" not found in "${text}"`);
    from = idx + sub.length;
  }
  return { start: idx, end: idx + sub.length };
}

function fx(
  id: string,
  categoryGroup: BenchmarkFixture['categoryGroup'],
  description: string,
  text: string,
  targets: Array<{ type: EntityType; sub: string; occurrence?: number }>,
  expectedRejectedTypes?: EntityType[],
  requiresNer = false,
): BenchmarkFixture {
  return {
    id,
    categoryGroup,
    description,
    text,
    expected: targets.map((t) => ({
      type: t.type,
      ...spanOf(text, t.sub, t.occurrence ?? 0),
    })),
    expectedRejectedTypes,
    requiresNer,
  };
}

/**
 * 70+ independent synthetic benchmark fixtures across mandatory PII categories,
 * negative controls, checksum rejections, obfuscation, Unicode/emoji, and edge boundaries.
 */
export const BENCHMARK_FIXTURES: BenchmarkFixture[] = [
  // EMAIL (10)
  fx('em_01', 'EMAIL', 'Standard corporate email', 'Send report to alice.smith@acme-corp.com today.', [{ type: 'EMAIL', sub: 'alice.smith@acme-corp.com' }]),
  fx('em_02', 'EMAIL', 'Plus-tagged email', 'Tag user+billing2026@sub.example.co.in ok.', [{ type: 'EMAIL', sub: 'user+billing2026@sub.example.co.in' }]),
  fx('em_03', 'EMAIL', 'Email followed by period and paren', '(mailto: dev_ops@cloud-node.io).', [{ type: 'EMAIL', sub: 'dev_ops@cloud-node.io' }]),
  fx('em_04', 'EMAIL', 'Repeated mixed-case emails', 'From: Bob.Ray@Example.ORG Cc: bob.ray@example.org', [
    { type: 'EMAIL', sub: 'Bob.Ray@Example.ORG' },
    { type: 'EMAIL', sub: 'bob.ray@example.org' },
  ]),
  fx('em_05', 'EMAIL', 'Underscore & hyphen local', 'Contact a_b-c.1@test-domain.net asap.', [{ type: 'EMAIL', sub: 'a_b-c.1@test-domain.net' }]),
  fx('em_06', 'EMAIL', 'Short 2-char domain & TLD', 'Ping x1@ab.io now.', [{ type: 'EMAIL', sub: 'x1@ab.io' }]),
  fx('em_07', 'EMAIL', 'Email adjacent to emoji', 'Reach out 😊 maya.k@sample.org!', [{ type: 'EMAIL', sub: 'maya.k@sample.org' }]),
  fx('em_08', 'EMAIL', 'Double dot malformed negative', 'Bad address user..name@example.com ignored.', []),
  fx('em_09', 'EMAIL', 'Single-label domain negative', 'Localhost admin@intranet not public TLD.', []),
  fx('em_10', 'EMAIL', 'Malformed trailing double-dot domain negative', 'Invalid host test@domain.com.. wait.', []),

  // PHONE (10)
  fx('ph_01', 'PHONE', 'Indian +91 spaced mobile', 'Call +91 98765 43210 immediately.', [{ type: 'PHONE', sub: '+91 98765 43210' }]),
  fx('ph_02', 'PHONE', 'Indian 10-digit mobile unformatted', 'Mobile 9876543210 active.', [{ type: 'PHONE', sub: '9876543210' }]),
  fx('ph_03', 'PHONE', 'Indian hyphenated mobile', 'Dial +91-98201-55443 for support.', [{ type: 'PHONE', sub: '+91-98201-55443' }]),
  fx('ph_04', 'PHONE', 'US international phone with extension', 'US office: +1 (415) 555-0199 ext 4.', [{ type: 'PHONE', sub: '+1 (415) 555-0199 ext 4' }]),
  fx('ph_05', 'PHONE', 'UK international phone', 'UK desk: +44 20 7946 0958.', [{ type: 'PHONE', sub: '+44 20 7946 0958' }]),
  fx('ph_06', 'PHONE', 'Leading zero IN mobile', 'Alt: 09811122233.', [{ type: 'PHONE', sub: '09811122233' }]),
  fx('ph_07', 'PHONE', 'Two phones in one line', 'Primary: +91 98200 11111, Backup: +91 98200 22222', [
    { type: 'PHONE', sub: '+91 98200 11111' },
    { type: 'PHONE', sub: '+91 98200 22222' },
  ]),
  fx('ph_08', 'PHONE', 'Short 6-digit ticket ID negative', 'Ticket #482910 closed.', []),
  fx('ph_09', 'PHONE', 'Timestamp digits negative', 'Epoch 1700000000123 ms.', []),
  fx('ph_10', 'PHONE', 'ISO date negative', 'Created on 2026-11-27.', []),

  // IP (10)
  fx('ip_01', 'IP', 'Standard IPv4', 'Source IP 192.168.10.42 blocked.', [{ type: 'IPV4', sub: '192.168.10.42' }]),
  fx('ip_02', 'IP', 'Public IPv4', 'DNS resolver 8.8.4.4 responding.', [{ type: 'IPV4', sub: '8.8.4.4' }]),
  fx('ip_03', 'IP', 'Loopback IPv4', 'Bind 127.0.0.1 locally.', [{ type: 'IPV4', sub: '127.0.0.1' }]),
  fx('ip_04', 'IP', 'Compressed IPv6', 'Gateway 2001:db8::1 up.', [{ type: 'IPV6', sub: '2001:db8::1' }]),
  fx('ip_05', 'IP', 'Bracketed IPv6 with port', 'Peer [2001:db8:85a3::8a2e:370:7334]:443 connected.', [{ type: 'IPV6', sub: '2001:db8:85a3::8a2e:370:7334' }]),
  fx('ip_06', 'IP', 'IPv4-mapped IPv6', 'Dual stack ::ffff:192.0.2.128 logged.', [{ type: 'IPV6', sub: '::ffff:192.0.2.128' }]),
  fx('ip_07', 'IP', 'Full 8-group IPv6', 'Node fe80:0000:0000:0000:0202:b3ff:fe1e:8329 active.', [{ type: 'IPV6', sub: 'fe80:0000:0000:0000:0202:b3ff:fe1e:8329' }]),
  fx('ip_08', 'IP', 'Out-of-range octet IPv4 rejected', 'Bad log 999.168.1.100 dropped.', [], ['IPV4']),
  fx('ip_09', 'IP', 'Version string rejected', 'Upgraded to v2.4.1.0 yesterday.', [], ['IPV4']),
  fx('ip_10', 'IP', 'Leading zero octet rejected', 'Octal-like 192.168.01.10 rejected.', [], ['IPV4']),

  // PAN (8)
  fx('pan_01', 'PAN', 'Uppercase personal PAN', 'PAN: ABCDE1234F verified.', [{ type: 'PAN', sub: 'ABCDE1234F' }]),
  fx('pan_02', 'PAN', 'Lowercase PAN', 'Entered pan abcde1234f in form.', [{ type: 'PAN', sub: 'abcde1234f' }]),
  fx('pan_03', 'PAN', 'Company holder PAN (C)', 'Entity PAN: AABCC9988K filed.', [{ type: 'PAN', sub: 'AABCC9988K' }]),
  fx('pan_04', 'PAN', 'PAN in parentheses', 'Tax ID (ZYXWV5432Q).', [{ type: 'PAN', sub: 'ZYXWV5432Q' }]),
  fx('pan_05', 'PAN', 'Two PANs in sentence', 'Primary BNZAA2318J and secondary CHJPK7712M.', [
    { type: 'PAN', sub: 'BNZAA2318J' },
    { type: 'PAN', sub: 'CHJPK7712M' },
  ]),
  fx('pan_06', 'PAN', '11-char alphanumeric negative', 'Code ABCDE1234FG too long.', []),
  fx('pan_07', 'PAN', '4-letter prefix negative', 'Order ABCD1234F invalid PAN.', []),
  fx('pan_08', 'PAN', '10-letter word negative', 'Word BASKETBALL not a PAN.', []),

  // AADHAAR (8)
  fx('aa_01', 'AADHAAR', 'Spaced Verhoeff-valid synthetic Aadhaar', 'UID: 2345 6789 0124 recorded.', [{ type: 'AADHAAR', sub: '2345 6789 0124' }]),
  fx('aa_02', 'AADHAAR', 'Hyphenated Verhoeff-valid Aadhaar', 'ID 5678-9012-3458 attached.', [{ type: 'AADHAAR', sub: '5678-9012-3458' }]),
  fx('aa_03', 'AADHAAR', 'Unspaced Verhoeff-valid Aadhaar', 'Number 234567890124 submitted.', [{ type: 'AADHAAR', sub: '234567890124' }]),
  fx('aa_04', 'AADHAAR', 'Mutated check digit rejected', 'Bad UID 2345 6789 0125 rejected.', [], ['AADHAAR']),
  fx('aa_05', 'AADHAAR', 'Leading 1 invalid start', 'Invalid 1345 6789 0120 skipped.', [], ['AADHAAR']),
  fx('aa_06', 'AADHAAR', 'Repeated digits rejected', 'Test 9999 9999 9999 rejected.', [], ['AADHAAR']),
  fx('aa_07', 'AADHAAR', '13-digit run not matched as Aadhaar', 'Serial 2345678901249 ignored as Aadhaar.', [], ['CARD']),
  fx('aa_08', 'AADHAAR', 'Two valid synthetic Aadhaars', 'A: 2345 6789 0124 B: 5678 9012 3458', [
    { type: 'AADHAAR', sub: '2345 6789 0124' },
    { type: 'AADHAAR', sub: '5678 9012 3458' },
  ]),

  // CARD (8)
  fx('cc_01', 'CARD', 'Visa test vector 4111 spaced', 'Card: 4111 1111 1111 1111 charged.', [{ type: 'CARD', sub: '4111 1111 1111 1111' }]),
  fx('cc_02', 'CARD', 'Visa test vector unspaced', 'Card 4111111111111111 ok.', [{ type: 'CARD', sub: '4111111111111111' }]),
  fx('cc_03', 'CARD', 'Hyphenated 16-digit Luhn valid', 'Test 4000-0012-3456-7899 ok.', [{ type: 'CARD', sub: '4000-0012-3456-7899' }]),
  fx('cc_04', 'CARD', '15-digit Amex Luhn test vector', 'Amex 3782 822463 10005 used.', [{ type: 'CARD', sub: '3782 822463 10005' }]),
  fx('cc_05', 'CARD', '16-digit Luhn invalid 4112', 'Rejected 4111 1111 1111 1112 must not leak substring.', [], ['CARD']),
  fx('cc_06', 'CARD', 'All-zero 16 digits rejected', 'Null 0000 0000 0000 0000 rejected.', [], ['CARD']),
  fx('cc_07', 'CARD', '12-digit number not a card', 'Short 411111111111 not card.', []),
  fx('cc_08', 'CARD', '19-digit Luhn valid vector', 'Long 4111111111111111118.', []), // let's verify Luhn for 19-digit or use exact 16-digit! Let's fix cc_08 to valid 13-digit 4222222222222!

  // LEAK HUNTER (8)
  fx('lh_01', 'LEAK_HUNTER', 'Bracket [at] and [dot] email', 'Mail ops [at] acme-sec [dot] org soon.', [{ type: 'EMAIL', sub: 'ops [at] acme-sec [dot] org' }]),
  fx('lh_02', 'LEAK_HUNTER', 'Paren (at) and (dot) email', 'Ping admin (at) demo-app (dot) io now.', [{ type: 'EMAIL', sub: 'admin (at) demo-app (dot) io' }]),
  fx('lh_03', 'LEAK_HUNTER', 'Zero-width space inside email', 'Reach a\u200Blice@example.org today.', [{ type: 'EMAIL', sub: 'a\u200Blice@example.org' }]),
  fx('lh_04', 'LEAK_HUNTER', 'Fullwidth card digits', 'Pay \uFF14\uFF11\uFF11\uFF11 \uFF11\uFF11\uFF11\uFF11 \uFF11\uFF11\uFF11\uFF11 \uFF11\uFF11\uFF11\uFF11.', [{ type: 'CARD', sub: '\uFF14\uFF11\uFF11\uFF11 \uFF11\uFF11\uFF11\uFF11 \uFF11\uFF11\uFF11\uFF11 \uFF11\uFF11\uFF11\uFF11' }]),
  fx('lh_05', 'LEAK_HUNTER', 'Devanagari digits in PAN', 'PAN ABCDE\u0967\u0968\u0969\u096AF', [{ type: 'PAN', sub: 'ABCDE\u0967\u0968\u0969\u096AF' }]),
  fx('lh_06', 'LEAK_HUNTER', 'Fullwidth email symbols', 'Contact bob\uFF20test\uFF0Eorg.', [{ type: 'EMAIL', sub: 'bob\uFF20test\uFF0Eorg' }]),
  fx('lh_07', 'LEAK_HUNTER', 'Ordinary prose with at/dot negative', 'Meet at noon and put a dot on the map.', []),
  fx('lh_08', 'LEAK_HUNTER', 'Zero-width inside IPv4', 'Host 10.\u200B0.0.1 online.', [{ type: 'IPV4', sub: '10.\u200B0.0.1' }]),

  // MIXED & NEGATIVES (10)
  fx('mx_01', 'MIXED', 'Adjacent comma-separated PII', 'alice@ex.com,+91 98765 43210,ABCDE1234F,10.1.2.3', [
    { type: 'EMAIL', sub: 'alice@ex.com' },
    { type: 'PHONE', sub: '+91 98765 43210' },
    { type: 'PAN', sub: 'ABCDE1234F' },
    { type: 'IPV4', sub: '10.1.2.3' },
  ]),
  fx('mx_02', 'MIXED', 'Emoji + multiline + all 6 types', '🔒 Line1: u1@test.org\nLine2: 9876543210\nLine3: 2345 6789 0124\nLine4: 4111 1111 1111 1111\nLine5: ABCDE1234F\nLine6: 192.168.1.5', [
    { type: 'EMAIL', sub: 'u1@test.org' },
    { type: 'PHONE', sub: '9876543210' },
    { type: 'AADHAAR', sub: '2345 6789 0124' },
    { type: 'CARD', sub: '4111 1111 1111 1111' },
    { type: 'PAN', sub: 'ABCDE1234F' },
    { type: 'IPV4', sub: '192.168.1.5' },
  ]),
  fx('ng_01', 'NEGATIVE', 'Pure prose no PII', 'The quick brown fox jumps over the lazy dog at 10:30 AM.', []),
  fx('ng_02', 'NEGATIVE', 'Order IDs and SKUs', 'Order ORD-2026-9910, SKU-8821-AB, Batch #4402.', []),
  fx('ng_03', 'NEGATIVE', 'Financial amounts', 'Total INR 12,450.00 and USD 1,999.95 paid.', []),
  fx('ng_04', 'NEGATIVE', 'Dates and times', 'Scheduled 2026-11-27 14:30:00 UTC.', []),
  fx('ng_05', 'NEGATIVE', 'HTTP status & metrics', 'Latency 24.5ms, status 200, throughput 4500 req/s.', []),
  fx('ng_06', 'NEGATIVE', 'Empty string', '', []),
  fx('ng_07', 'NEGATIVE', 'UUID negative (must not split into phone/PAN)', 'Request 550e8400-e29b-41d4-a716-446655440000 done.', []),
  fx('ng_08', 'NEGATIVE', 'Semantic version & git SHA', 'Commit 8e892123e8b7 tag v1.2.3.', []),
];

// Replace cc_08 with verified 13-digit Luhn valid Visa test vector 4222222222222
BENCHMARK_FIXTURES[BENCHMARK_FIXTURES.findIndex((f) => f.id === 'cc_08')] = fx(
  'cc_08',
  'CARD',
  '13-digit Luhn valid test vector',
  'Legacy card 4222222222222 accepted.',
  [{ type: 'CARD', sub: '4222222222222' }],
);
