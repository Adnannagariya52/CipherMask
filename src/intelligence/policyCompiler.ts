import type { LocalReasoner } from './localReasoner.ts';
import { buildPrivacyScriptPrompt } from './prompts.ts';
import {
  extractAndValidateJson,
  PrivacyScriptPolicySchema,
  type PolicyPurpose,
  type PrivacyScriptPolicy,
} from './schemas.ts';
import type { HybridFinding } from './fusion.ts';

export type TransformAction =
  | 'full_mask'
  | 'partial_mask'
  | 'pseudonymize'
  | 'suppress'
  | 'generalize'
  | 'preserve';

export interface BoundTransform {
  findingId: string;
  type: string;
  action: TransformAction;
  reasonCode: string;
  overriddenByPrivacyFloor: boolean;
}

export interface BoundPolicyPlan {
  policy: PrivacyScriptPolicy;
  compilerSource: 'gemma' | 'manual_deterministic';
  transforms: BoundTransform[];
  warnings: string[];
  reviewRequired: boolean;
}

const UNSAFE_INSTRUCTION_RE =
  /\b(send\s+raw|disable\s+(?:checks|scan|verification|firewall)|bypass|include\s+vault|reveal\s+all\s+secrets)\b/i;

const MANDATORY_DIRECT_CATEGORIES = new Set([
  'EMAIL',
  'PHONE',
  'IPV4',
  'IPV6',
  'PAN',
  'AADHAAR',
  'CARD',
  'SECRET_CREDENTIAL',
]);

export function createDeterministicPrivacyScript(
  purpose: PolicyPurpose,
  instruction = '',
): PrivacyScriptPolicy {
  const lower = instruction.toLowerCase();
  const unsupportedInstructions: string[] = [];

  if (UNSAFE_INSTRUCTION_RE.test(instruction)) {
    unsupportedInstructions.push(
      'Unsafe request ignored: cannot disable verification/scans, send raw data, or export vault.',
    );
  }

  const wantsFull = /\bfull\s*mask\b|\bredact\s+everything\b|\bstrict\b/.test(lower);
  const wantsPartial = /\bpartial\b/.test(lower);
  const defaultTextMode: PrivacyScriptPolicy['defaultTextMode'] = wantsFull
    ? 'full_mask'
    : wantsPartial
      ? 'partial_mask'
      : 'pseudonymize';

  const preserveEvidenceTypes: string[] = [];
  if (/\berror\s*code|\bstatus\s*code|\bstack/i.test(lower)) preserveEvidenceTypes.push('ERROR_CODE');
  if (/\bretr(y|ies)\b/i.test(lower)) preserveEvidenceTypes.push('RETRY_COUNT');
  if (/\bamount|\bprice|\btotal\b/i.test(lower)) preserveEvidenceTypes.push('TRANSACTION_AMOUNT');

  const contextActions: Record<string, TransformAction> = {};
  if (/\b(hide|remove|mask|suppress).*(medical|health)\b/i.test(lower) || purpose === 'technical_debugging') {
    contextActions.HEALTH_CONTEXT = 'suppress';
  }
  if (/\b(hide|remove|mask|suppress).*(salary|income|financial)\b/i.test(lower)) {
    contextActions.FINANCIAL_CONTEXT = 'suppress';
  }

  const faceAction = /\bblur\s+face/i.test(lower)
    ? 'blur'
    : /\bpixelate\s+face/i.test(lower)
      ? 'pixelate'
      : 'solid_mask';

  return {
    schemaVersion: 1,
    purpose,
    defaultTextMode,
    categories: {
      EMAIL: defaultTextMode,
      PHONE: defaultTextMode === 'partial_mask' ? 'partial_mask' : 'full_mask',
      CARD: 'full_mask',
      AADHAAR: 'full_mask',
      PAN: defaultTextMode === 'pseudonymize' ? 'pseudonymize' : 'full_mask',
      PERSON: 'pseudonymize',
    },
    contextActions,
    preserveEvidenceTypes,
    imagePolicy: {
      faces: faceAction,
      textPii: 'solid_mask',
      qr: 'solid_mask',
      metadata: 'remove',
    },
    csvPolicy: {
      targetK: purpose === 'research_analytics' || purpose === 'public_sharing' ? 2 : null,
      selectedColumns: [],
    },
    unsupportedInstructions,
    rationaleSummary:
      unsupportedInstructions.length > 0
        ? 'Compiled deterministic policy with unsafe bypass instructions rejected.'
        : `Deterministic policy compiled for ${purpose.replace(/_/g, ' ')}.`,
  };
}

export async function compilePrivacyScriptPolicy(
  instruction: string,
  purpose: PolicyPurpose,
  availableCategories: string[],
  availableCsvColumns: string[],
  reasoner?: LocalReasoner,
  signal?: AbortSignal,
): Promise<{ policy: PrivacyScriptPolicy; compilerSource: 'gemma' | 'manual_deterministic'; error?: string }> {
  const hasUnsafe = UNSAFE_INSTRUCTION_RE.test(instruction);

  if (!reasoner || reasoner.getStatus().state !== 'ready') {
    return {
      policy: createDeterministicPrivacyScript(purpose, instruction),
      compilerSource: 'manual_deterministic',
    };
  }

  const prompt = buildPrivacyScriptPrompt(instruction, availableCategories, availableCsvColumns);
  const res = await reasoner.run(
    { jobId: `ps_${Date.now()}`, task: 'privacyscript_compile', prompt, maxOutputTokens: 512 },
    { signal },
  );

  if (res.status !== 'completed') {
    return {
      policy: createDeterministicPrivacyScript(purpose, instruction),
      compilerSource: 'manual_deterministic',
      error: res.errorMessage || 'Gemma compiler failed; fell back to deterministic policy.',
    };
  }

  const parsed = extractAndValidateJson(res.text, PrivacyScriptPolicySchema);
  if (!parsed.ok || !parsed.data) {
    return {
      policy: createDeterministicPrivacyScript(purpose, instruction),
      compilerSource: 'manual_deterministic',
      error: parsed.error || 'Invalid PrivacyScript JSON from Gemma; fell back to deterministic policy.',
    };
  }

  const compiled = { ...parsed.data };
  if (hasUnsafe) {
    compiled.unsupportedInstructions = [
      ...compiled.unsupportedInstructions,
      'Unsafe request rejected by privacy floor (cannot disable verification or send raw content).',
    ];
  }
  // Enforce metadata removal invariant
  compiled.imagePolicy = {
    ...compiled.imagePolicy,
    metadata: 'remove',
  };

  return {
    policy: compiled,
    compilerSource: 'gemma',
  };
}

export function bindPolicyToFindings(
  policy: PrivacyScriptPolicy,
  compilerSource: 'gemma' | 'manual_deterministic',
  findings: HybridFinding[],
  strictCloudFloor: boolean,
): BoundPolicyPlan {
  const warnings: string[] = [...policy.unsupportedInstructions];
  const transforms: BoundTransform[] = [];
  let reviewRequired = false;

  for (const f of findings) {
    const typeKey = String(f.type);
    let action: TransformAction =
      (policy.categories[typeKey] as TransformAction | undefined) ??
      (policy.contextActions[typeKey] as TransformAction | undefined) ??
      policy.defaultTextMode;

    let overriddenByPrivacyFloor = false;

    // Privacy floor: confirmed mandatory direct PII cannot be preserved, and in strict cloud mode cannot stay partial
    if (f.mandatoryFloor || MANDATORY_DIRECT_CATEGORIES.has(typeKey)) {
      if (action === 'preserve') {
        action = 'full_mask';
        overriddenByPrivacyFloor = true;
        warnings.push(`Blocked preserving mandatory ${typeKey} finding (${f.id}); enforced full_mask.`);
      } else if (strictCloudFloor && action === 'partial_mask') {
        action = 'pseudonymize';
        overriddenByPrivacyFloor = true;
        warnings.push(`Upgraded ${typeKey} from partial_mask to pseudonymize for protected cloud mode.`);
      }
    }

    if (f.reviewRequired) {
      reviewRequired = true;
    }

    transforms.push({
      findingId: f.id,
      type: typeKey,
      action,
      reasonCode: f.reasonCode,
      overriddenByPrivacyFloor,
    });
  }

  return {
    policy,
    compilerSource,
    transforms,
    warnings: Array.from(new Set(warnings)),
    reviewRequired,
  };
}
