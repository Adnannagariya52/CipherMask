import { z } from 'zod';

export const SemanticCategorySchema = z.enum([
  'EMAIL',
  'PHONE',
  'IPV4',
  'IPV6',
  'PAN',
  'AADHAAR',
  'CARD',
  'PERSON',
  'LOCATION',
  'ORGANIZATION',
  'ADDRESS',
  'DATE_OF_BIRTH',
  'PERSONAL_ID',
  'HEALTH_CONTEXT',
  'FINANCIAL_CONTEXT',
  'EMPLOYMENT_CONTEXT',
  'SECRET_CREDENTIAL',
  'OTHER_SENSITIVE',
]);

export type SemanticCategory = z.infer<typeof SemanticCategorySchema>;

export const SemanticFindingRawSchema = z
  .object({
    quote: z.string().min(1).max(400),
    type: SemanticCategorySchema,
    occurrence: z.number().int().min(0).max(200).optional(),
    leftAnchor: z.string().max(60).optional(),
    rightAnchor: z.string().max(60).optional(),
    reasonCode: z.string().min(2).max(64),
    reviewRequired: z.boolean().default(true),
  })
  .strict();

export const SemanticDetectionResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    chunkId: z.string().min(1).max(64),
    findings: z.array(SemanticFindingRawSchema).max(40),
    truncated: z.boolean(),
  })
  .strict();

export type SemanticDetectionResponse = z.infer<typeof SemanticDetectionResponseSchema>;

export const TextTransformActionSchema = z.enum([
  'full_mask',
  'partial_mask',
  'pseudonymize',
  'suppress',
  'generalize',
  'preserve',
]);

export const VisualTransformActionSchema = z.enum(['solid_mask', 'blur', 'pixelate', 'exclude']);

export const PolicyPurposeSchema = z.enum([
  'technical_debugging',
  'customer_support',
  'research_analytics',
  'public_sharing',
  'general_assistance',
  'custom',
]);

export type PolicyPurpose = z.infer<typeof PolicyPurposeSchema>;

export const PrivacyScriptPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: PolicyPurposeSchema,
    purposeLabel: z.string().max(80).optional(),
    defaultTextMode: z.enum(['full_mask', 'partial_mask', 'pseudonymize']),
    categories: z.record(z.string().max(40), TextTransformActionSchema).default({}),
    contextActions: z.record(z.string().max(40), TextTransformActionSchema).default({}),
    preserveEvidenceTypes: z.array(z.string().max(48)).max(20).default([]),
    imagePolicy: z
      .object({
        faces: VisualTransformActionSchema.default('solid_mask'),
        textPii: VisualTransformActionSchema.default('solid_mask'),
        qr: VisualTransformActionSchema.default('solid_mask'),
        metadata: z.literal('remove').default('remove'),
      })
      .strict(),
    csvPolicy: z
      .object({
        targetK: z.number().int().min(2).max(100).nullable().default(null),
        selectedColumns: z.array(z.string().max(80)).max(50).default([]),
      })
      .strict(),
    unsupportedInstructions: z.array(z.string().max(160)).max(20).default([]),
    rationaleSummary: z.string().max(400).default(''),
  })
  .strict();

export type PrivacyScriptPolicy = z.infer<typeof PrivacyScriptPolicySchema>;

export const CourtProposalItemSchema = z
  .object({
    findingId: z.string().min(1).max(80),
    proposedAction: TextTransformActionSchema,
    reasonCode: z.string().min(2).max(64),
    evidenceQuote: z.string().max(240).optional(),
  })
  .strict();

export const CourtProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    role: z.enum(['privacy_guardian', 'utility_advocate']),
    proposals: z.array(CourtProposalItemSchema).max(40),
    missingExposureQuotes: z
      .array(
        z
          .object({
            quote: z.string().min(1).max(240),
            type: SemanticCategorySchema,
            reasonCode: z.string().min(2).max(64),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    summary: z.string().max(400),
  })
  .strict();

export type CourtProposal = z.infer<typeof CourtProposalSchema>;

export const CourtJudgeSchema = z
  .object({
    schemaVersion: z.literal(1),
    decisions: z.array(CourtProposalItemSchema).max(40),
    conflicts: z.array(z.string().max(200)).max(20).default([]),
    unsupportedRequests: z.array(z.string().max(160)).max(10).default([]),
    rationaleSummary: z.string().max(500),
  })
  .strict();

export type CourtJudge = z.infer<typeof CourtJudgeSchema>;

export const SemanticOutputReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    residualFindings: z
      .array(
        z
          .object({
            quote: z.string().min(1).max(240),
            type: SemanticCategorySchema,
            reasonCode: z.string().min(2).max(64),
          })
          .strict(),
      )
      .max(20),
    missingRequiredFacts: z.array(z.string().max(120)).max(20).default([]),
    summary: z.string().max(400),
  })
  .strict();

export type SemanticOutputReview = z.infer<typeof SemanticOutputReviewSchema>;

export const SmokeTestSchema = z
  .object({
    status: z.literal('ready'),
  })
  .strict();

export interface JsonParseValidationResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * Parses and validates untrusted model text strictly against a Zod schema.
 * Allows unwrapping at most ONE enclosing markdown code fence; rejects trailing junk or extra keys.
 */
export function extractAndValidateJson<T>(
  rawText: string,
  schema: z.ZodType<T>,
): JsonParseValidationResult<T> {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { ok: false, error: 'Model returned empty output.' };
  }
  if (trimmed.length > 32_000) {
    return { ok: false, error: 'Model output exceeded 32 KB safety bound.' };
  }

  let candidate = trimmed;
  const fenceMatch = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(trimmed);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON from model: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const res = schema.safeParse(parsed);
  if (!res.success) {
    const issueMsg = res.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).slice(0, 4).join('; ');
    return { ok: false, error: `Schema validation failed: ${issueMsg}` };
  }

  return { ok: true, data: res.data };
}
