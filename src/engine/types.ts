export type EntityType =
  | 'EMAIL'
  | 'PHONE'
  | 'IPV4'
  | 'IPV6'
  | 'PAN'
  | 'AADHAAR'
  | 'CARD'
  | 'PERSON'
  | 'LOCATION'
  | 'ORGANIZATION'
  | 'CONTEXT_ID'
  | 'FACE'
  | 'PERSON_REGION'
  | 'QR'
  | 'BARCODE'
  | 'METADATA'
  | 'MANUAL';

export type RedactionMode = 'FULL' | 'PARTIAL' | 'PSEUDONYM' | 'KEEP';
export type CoreRedactionMode = 'FULL' | 'PARTIAL' | 'PSEUDONYM';
export type PresetId = 'AI_SAFE' | 'SUPPORT' | 'RESEARCH' | 'CUSTOM';

export type DetectionMethod =
  | 'regex'
  | 'checksum'
  | 'parser'
  | 'leak_hunter'
  | 'ner'
  | 'ocr'
  | 'vision_face'
  | 'vision_segment'
  | 'vision_code'
  | 'metadata'
  | 'manual';

export type ValidationStatus =
  | 'checksum_valid'
  | 'structurally_valid'
  | 'pattern_match'
  | 'uncertain'
  | 'rejected';

export type ReviewStatus = 'included' | 'excluded' | 'pending';

export interface TextSpan {
  start: number;
  end: number;
}

export interface DetectionCandidate {
  id: string;
  type: EntityType;
  start: number;
  end: number;
  /** Kept strictly in volatile session memory; never logged or exported in audit. */
  rawText: string;
  maskedPreview: string;
  /** Normalized canonical key used only in volatile memory for pseudonym consistency. */
  canonicalKey: string;
  method: DetectionMethod;
  validationStatus: ValidationStatus;
  evidence: string;
  confidence?: number;
  reviewStatus: ReviewStatus;
  overrideMode?: RedactionMode;
  fromLeakHunter?: boolean;
  row?: number;
  column?: number;
  cellStart?: number;
  cellEnd?: number;
}

export interface DetectionResult {
  revision: number;
  accepted: DetectionCandidate[];
  rejected: DetectionCandidate[];
  uncertain: DetectionCandidate[];
  durationMs: number;
  countsByType: Partial<Record<EntityType, number>>;
  totalAcceptedOccurrences: number;
  uniqueAcceptedCount: number;
}

export interface EntityOverride {
  reviewStatus?: ReviewStatus;
  mode?: RedactionMode;
}

export interface ManualSpan {
  id: string;
  start: number;
  end: number;
  type: EntityType;
  label?: string;
}

export interface RedactionPolicy {
  preset: PresetId;
  defaultMode: CoreRedactionMode;
  categoryModes: Partial<Record<EntityType, RedactionMode>>;
  entityOverrides: Record<string, EntityOverride>;
  manualSpans: ManualSpan[];
  enableLeakHunter: boolean;
  enableNer: boolean;
  conservativeMaskInvalid: boolean;
  phonePartialKeepDigits: number;
}

export interface TransformationRecord {
  candidateId: string;
  type: EntityType;
  mode: RedactionMode;
  origStart: number;
  origEnd: number;
  outStart: number;
  outEnd: number;
  replacement: string;
  /** Used in memory only for local Vault creation if requested by user. */
  originalSlice: string;
  canonicalKey: string;
  applied: boolean;
  row?: number;
  column?: number;
  cellStart?: number;
  cellEnd?: number;
}

export interface VerificationFinding {
  id: string;
  severity: 'info' | 'warning' | 'risk';
  kind:
    | 'remaining_pattern'
    | 'leak_hunter_residual'
    | 'deliberate_exclusion'
    | 'partial_retention'
    | 'unreviewed_uncertain'
    | 'rejected_candidate'
    | 'limitation';
  message: string;
  start?: number;
  end?: number;
  type?: EntityType;
}

export interface VerificationReport {
  cleanByEnabledChecks: boolean;
  statusLabel: string;
  findings: VerificationFinding[];
  remainingCount: number;
  excludedCount: number;
  partialRetainedCount: number;
  pendingCount: number;
  checkedAtMs: number;
}

export interface RedactionOutput {
  sanitizedText: string;
  transformations: TransformationRecord[];
  appliedCount: number;
  excludedCount: number;
  pseudonymCount: number;
  verification: VerificationReport;
  durationMs: number;
}

export interface TextDocument {
  sourceType: 'text';
  sessionId: string;
  revision: number;
  displayName: string;
  byteSize: number;
  content: string;
  lineEnding: '\n' | '\r\n';
  hadBom: boolean;
}

export interface CsvDocument {
  sourceType: 'csv';
  sessionId: string;
  revision: number;
  displayName: string;
  byteSize: number;
  delimiter: string;
  hasHeader: boolean;
  rows: string[][];
}

export interface ImageDocument {
  sourceType: 'image';
  sessionId: string;
  revision: number;
  displayName: string;
  byteSize: number;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

export type AnySessionDocument = TextDocument | CsvDocument | ImageDocument;

export interface ExportArtifact {
  mime: string;
  filename: string;
  bytes: Uint8Array;
  sha256Hex: string;
}

export interface AuditReceipt {
  schemaVersion: 1;
  appName: 'CipherMask';
  appVersion: string;
  generatedAt: string;
  inputFormat: 'txt' | 'csv' | 'png' | 'jpeg' | 'paste';
  inputByteSize: number;
  outputFormat: string;
  outputByteSize: number;
  outputSha256: string;
  policyPreset: PresetId;
  defaultMode: CoreRedactionMode;
  enabledMethods: string[];
  counts: {
    totalDetected: number;
    uniqueEntities: number;
    applied: number;
    excluded: number;
    rejected: number;
    uncertain: number;
    byType: Record<string, number>;
  };
  durationsMs: {
    detection: number;
    redaction: number;
  };
  verification: {
    statusLabel: string;
    remainingFindings: number;
    limitations: string[];
  };
  csvSummary?: {
    rows: number;
    columns: number;
    selectedQiCount: number;
    targetK?: number;
    beforeKMin?: number | null;
    afterKMin?: number | null;
    beforeSingletons?: number;
    afterSingletons?: number;
    beforeRowsBelowTarget?: number;
    afterRowsBelowTarget?: number;
    appliedTransforms?: Array<{ columnLabel: string; transformDescription: string }>;
    utilityLoss?: number;
  };
  visionSummary?: {
    originalDimensions: { width: number; height: number };
    exportedDimensions: { width: number; height: number };
    selectedFaces: number;
    unselectedFaces: number;
    appliedEffects: Record<string, number>;
    ocrRan: boolean;
    codeScanRan: boolean;
    metadataCategoriesDetected: string[];
    metadataRemovedVerified: boolean;
  };
  offlineAssetStatus: Record<string, string>;
}

export const ENTITY_LABELS: Record<EntityType, string> = {
  EMAIL: 'Email',
  PHONE: 'Phone',
  IPV4: 'IPv4',
  IPV6: 'IPv6',
  PAN: 'Indian PAN',
  AADHAAR: 'Aadhaar',
  CARD: 'Credit Card',
  PERSON: 'Person (NER)',
  LOCATION: 'Location (NER)',
  ORGANIZATION: 'Organization (NER)',
  CONTEXT_ID: 'Context ID',
  FACE: 'Face',
  PERSON_REGION: 'Person Region',
  QR: 'QR Code',
  BARCODE: 'Barcode',
  METADATA: 'Metadata',
  MANUAL: 'Manual Region',
};
