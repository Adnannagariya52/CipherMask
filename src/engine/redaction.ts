import type {
  CoreRedactionMode,
  DetectionCandidate,
  EntityType,
  PresetId,
  RedactionMode,
  RedactionPolicy,
} from './types.ts';
import { SessionPseudonymAllocator } from './pseudonyms.ts';

export function createDefaultPolicy(preset: PresetId = 'AI_SAFE'): RedactionPolicy {
  switch (preset) {
    case 'AI_SAFE':
      return {
        preset: 'AI_SAFE',
        defaultMode: 'FULL',
        categoryModes: {},
        entityOverrides: {},
        manualSpans: [],
        enableLeakHunter: true,
        enableNer: false,
        conservativeMaskInvalid: false,
        phonePartialKeepDigits: 2,
      };
    case 'SUPPORT':
      return {
        preset: 'SUPPORT',
        defaultMode: 'PARTIAL',
        categoryModes: {
          AADHAAR: 'FULL',
          CARD: 'FULL',
          PAN: 'PARTIAL',
          PHONE: 'PARTIAL',
          EMAIL: 'PARTIAL',
          IPV4: 'PARTIAL',
          IPV6: 'FULL',
        },
        entityOverrides: {},
        manualSpans: [],
        enableLeakHunter: true,
        enableNer: false,
        conservativeMaskInvalid: false,
        phonePartialKeepDigits: 4,
      };
    case 'RESEARCH':
      return {
        preset: 'RESEARCH',
        defaultMode: 'PSEUDONYM',
        categoryModes: {},
        entityOverrides: {},
        manualSpans: [],
        enableLeakHunter: true,
        enableNer: false,
        conservativeMaskInvalid: false,
        phonePartialKeepDigits: 2,
      };
    case 'CUSTOM':
    default:
      return {
        preset: 'CUSTOM',
        defaultMode: 'FULL',
        categoryModes: {},
        entityOverrides: {},
        manualSpans: [],
        enableLeakHunter: true,
        enableNer: false,
        conservativeMaskInvalid: false,
        phonePartialKeepDigits: 2,
      };
  }
}

export function formatPartialMask(
  type: EntityType,
  rawText: string,
  canonicalKey: string,
  phoneKeepDigits = 2,
): string {
  switch (type) {
    case 'CARD': {
      const digits = canonicalKey.replace(/\D/g, '');
      const last4 = digits.slice(-4);
      return `XXXX XXXX XXXX ${last4}`;
    }
    case 'AADHAAR': {
      const digits = canonicalKey.replace(/\D/g, '');
      const last4 = digits.slice(-4);
      return `XXXX XXXX ${last4}`;
    }
    case 'PHONE': {
      const digits = rawText.replace(/\D/g, '');
      const keep = Math.max(2, Math.min(4, phoneKeepDigits));
      const suffix = digits.slice(-keep);
      const maskedLen = Math.max(4, digits.length - keep);
      return `${'*'.repeat(maskedLen)}${suffix}`;
    }
    case 'PAN': {
      const upper = rawText.toUpperCase();
      return `XXXXXX${upper.slice(-4)}`;
    }
    case 'EMAIL': {
      const atIdx = canonicalKey.indexOf('@');
      if (atIdx <= 0) return '[REDACTED_EMAIL]';
      const local = canonicalKey.slice(0, atIdx);
      const domain = canonicalKey.slice(atIdx + 1);
      const dotIdx = domain.lastIndexOf('.');
      const tld = dotIdx > 0 ? domain.slice(dotIdx) : '';
      const localPrefix = local.slice(0, 1);
      return `${localPrefix}***@***${tld}`;
    }
    case 'IPV4': {
      const parts = canonicalKey.split('.');
      if (parts.length === 4) {
        return `${parts[0]}.${parts[1]}.xxx.xxx`;
      }
      return 'xxx.xxx.xxx.xxx';
    }
    case 'IPV6':
      return '[REDACTED_IPV6]';
    case 'PERSON':
    case 'LOCATION':
    case 'ORGANIZATION':
    case 'CONTEXT_ID':
    case 'MANUAL':
    default:
      return '[REDACTED]';
  }
}

export function resolveCandidateDecision(
  candidate: DetectionCandidate,
  policy: RedactionPolicy,
): { included: boolean; mode: RedactionMode } {
  const override = policy.entityOverrides[candidate.id];
  const reviewStatus = override?.reviewStatus ?? candidate.reviewStatus;
  if (reviewStatus === 'excluded') {
    return { included: false, mode: 'KEEP' };
  }
  if (reviewStatus === 'pending') {
    // Pending uncertain items are not auto-masked unless explicitly included
    if (override?.mode && override.mode !== 'KEEP') {
      return { included: true, mode: override.mode };
    }
    return { included: false, mode: 'KEEP' };
  }

  const mode: RedactionMode =
    override?.mode ??
    candidate.overrideMode ??
    policy.categoryModes[candidate.type] ??
    policy.defaultMode;

  if (mode === 'KEEP') {
    return { included: false, mode: 'KEEP' };
  }
  return { included: true, mode };
}

export function computeReplacement(
  candidate: DetectionCandidate,
  mode: CoreRedactionMode,
  allocator: SessionPseudonymAllocator,
  phonePartialKeepDigits: number,
): string {
  switch (mode) {
    case 'FULL':
      return '[REDACTED]';
    case 'PARTIAL':
      return formatPartialMask(
        candidate.type,
        candidate.rawText,
        candidate.canonicalKey,
        phonePartialKeepDigits,
      );
    case 'PSEUDONYM':
      return allocator.allocate(candidate.type, candidate.canonicalKey);
  }
}
