/**
 * Verhoeff checksum algorithm used for 12-digit Aadhaar format validation.
 * Validates structural format (12 digits, starts with 2-9) and Verhoeff check digit only;
 * does NOT verify real UIDAI registration.
 */

const MULTIPLICATION_TABLE: readonly number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const PERMUTATION_TABLE: readonly number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

const INVERSE_TABLE: readonly number[] = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

export function computeVerhoeffCheckDigit(payloadDigits: string): number {
  let c = 0;
  const len = payloadDigits.length;
  for (let i = 0; i < len; i += 1) {
    const digit = payloadDigits.charCodeAt(len - 1 - i) - 48;
    c = MULTIPLICATION_TABLE[c][PERMUTATION_TABLE[(i + 1) % 8][digit]];
  }
  return INVERSE_TABLE[c];
}

export function validateVerhoeff(digits: string): boolean {
  if (!/^\d+$/.test(digits) || digits.length < 2) return false;
  let c = 0;
  const len = digits.length;
  for (let i = 0; i < len; i += 1) {
    const digit = digits.charCodeAt(len - 1 - i) - 48;
    c = MULTIPLICATION_TABLE[c][PERMUTATION_TABLE[i % 8][digit]];
  }
  return c === 0;
}

export interface AadhaarValidationResult {
  valid: boolean;
  digits: string;
  reason: string;
}

export function validateAadhaar(rawCandidate: string): AadhaarValidationResult {
  const digits = rawCandidate.replace(/\D/g, '');
  if (digits.length !== 12) {
    return {
      valid: false,
      digits,
      reason: `Expected 12 digits, got ${digits.length}.`,
    };
  }
  if (digits[0] === '0' || digits[0] === '1') {
    return {
      valid: false,
      digits,
      reason: `Aadhaar cannot start with digit '${digits[0]}'.`,
    };
  }
  if (/^(\d)\1{11}$/.test(digits)) {
    return {
      valid: false,
      digits,
      reason: 'Rejected trivial repeated-digit sequence.',
    };
  }
  const checksumOk = validateVerhoeff(digits);
  return {
    valid: checksumOk,
    digits,
    reason: checksumOk
      ? 'Passed 12-digit structural rule and Verhoeff checksum.'
      : 'Matches 12-digit Aadhaar format but failed Verhoeff checksum.',
  };
}
