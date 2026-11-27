/**
 * Luhn checksum validation for payment card candidates (13-19 digits).
 * Validates format and checksum only; does not verify account existence or issuer.
 */
export interface LuhnValidationResult {
  valid: boolean;
  digits: string;
  reason: string;
}

const ALL_SAME_DIGIT_RE = /^(\d)\1+$/;

export function validateLuhn(rawCandidate: string): LuhnValidationResult {
  const digits = rawCandidate.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) {
    return {
      valid: false,
      digits,
      reason: `Invalid card length (${digits.length} digits; expected 13–19).`,
    };
  }
  if (ALL_SAME_DIGIT_RE.test(digits)) {
    return {
      valid: false,
      digits,
      reason: 'Rejected trivial repeated-digit sequence.',
    };
  }

  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (shouldDouble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    shouldDouble = !shouldDouble;
  }

  const valid = sum % 10 === 0;
  return {
    valid,
    digits,
    reason: valid
      ? `Passed Luhn mod-10 checksum (${digits.length} digits).`
      : `Failed Luhn mod-10 checksum (remainder ${sum % 10}).`,
  };
}
