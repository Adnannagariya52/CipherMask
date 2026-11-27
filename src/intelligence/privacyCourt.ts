import type { LocalReasoner } from './localReasoner.ts';
import type { HybridFinding } from './fusion.ts';
import {
  bindPolicyToFindings,
  compilePrivacyScriptPolicy,
  type BoundPolicyPlan,
} from './policyCompiler.ts';
import {
  buildPrivacyGuardianPrompt,
  buildPrivacyJudgePrompt,
  buildSemanticOutputReviewPrompt,
  buildUtilityAdvocatePrompt,
} from './prompts.ts';
import {
  CourtJudgeSchema,
  CourtProposalSchema,
  extractAndValidateJson,
  SemanticOutputReviewSchema,
  type PolicyPurpose,
  type SemanticOutputReview,
} from './schemas.ts';

export type CourtMode = 'fast' | 'deep';

export interface CourtStageReport {
  stage: 'guardian' | 'advocate' | 'judge' | 'deterministic_validator' | 'semantic_reviewer';
  status: 'completed' | 'skipped' | 'failed' | 'partial';
  elapsedMs: number;
  summary: string;
  conflicts?: string[];
}

export interface PrivacyCourtResult {
  mode: CourtMode;
  plan: BoundPolicyPlan;
  stages: CourtStageReport[];
  semanticReview?: SemanticOutputReview;
  partialOrIncomplete: boolean;
  totalElapsedMs: number;
}

export async function runPrivacyCourt(params: {
  mode: CourtMode;
  purpose: PolicyPurpose;
  instruction: string;
  findings: HybridFinding[];
  sourceText: string;
  availableCsvColumns?: string[];
  strictCloudFloor: boolean;
  reasoner?: LocalReasoner;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
}): Promise<PrivacyCourtResult> {
  const t0 = performance.now();
  const stages: CourtStageReport[] = [];
  const {
    mode,
    purpose,
    instruction,
    findings,
    sourceText,
    availableCsvColumns = [],
    strictCloudFloor,
    reasoner,
    signal,
    onStage,
  } = params;

  onStage?.('Compiling PrivacyScript policy...');
  const categories = Array.from(new Set(findings.map((f) => String(f.type))));
  const compiled = await compilePrivacyScriptPolicy(
    instruction,
    purpose,
    categories,
    availableCsvColumns,
    reasoner,
    signal,
  );

  let plan = bindPolicyToFindings(compiled.policy, compiled.compilerSource, findings, strictCloudFloor);
  let partialOrIncomplete = false;

  if (mode === 'fast' || !reasoner || reasoner.getStatus().state !== 'ready') {
    stages.push({
      stage: 'deterministic_validator',
      status: 'completed',
      elapsedMs: Math.round(performance.now() - t0),
      summary:
        mode === 'deep' && (!reasoner || reasoner.getStatus().state !== 'ready')
          ? 'Gemma 3 4B not loaded; ran deterministic policy validator without LLM court stages.'
          : `Fast mode validated ${plan.transforms.length} transform(s) via deterministic privacy floor.`,
      conflicts: plan.warnings,
    });
    if (mode === 'deep') partialOrIncomplete = true;
    return {
      mode,
      plan,
      stages,
      partialOrIncomplete,
      totalElapsedMs: Math.round(performance.now() - t0),
    };
  }

  const compactFindings = findings.slice(0, 25).map((f) => ({
    id: f.id,
    type: String(f.type),
    preview: f.maskedPreview,
  }));

  // Deep Stage 1: Privacy Guardian
  onStage?.('Privacy Guardian reviewing contextual risks...');
  const gStart = performance.now();
  const gRes = await reasoner.run(
    {
      jobId: `court_guardian_${Date.now()}`,
      task: 'court_guardian',
      prompt: buildPrivacyGuardianPrompt(purpose, compactFindings, sourceText),
      maxOutputTokens: 450,
    },
    { signal },
  );
  const gParsed =
    gRes.status === 'completed' ? extractAndValidateJson(gRes.text, CourtProposalSchema) : null;

  stages.push({
    stage: 'guardian',
    status: gParsed?.ok ? 'completed' : 'failed',
    elapsedMs: Math.round(performance.now() - gStart),
    summary: gParsed?.ok && gParsed.data ? gParsed.data.summary : gRes.errorMessage || gParsed?.error || 'Guardian stage failed.',
  });
  if (!gParsed?.ok) partialOrIncomplete = true;

  // Deep Stage 2: Utility Advocate
  onStage?.('Utility Advocate identifying task-relevant facts...');
  const aStart = performance.now();
  const aRes = await reasoner.run(
    {
      jobId: `court_advocate_${Date.now()}`,
      task: 'court_advocate',
      prompt: buildUtilityAdvocatePrompt(purpose, compactFindings, sourceText),
      maxOutputTokens: 450,
    },
    { signal },
  );
  const aParsed =
    aRes.status === 'completed' ? extractAndValidateJson(aRes.text, CourtProposalSchema) : null;

  stages.push({
    stage: 'advocate',
    status: aParsed?.ok ? 'completed' : 'failed',
    elapsedMs: Math.round(performance.now() - aStart),
    summary: aParsed?.ok && aParsed.data ? aParsed.data.summary : aRes.errorMessage || aParsed?.error || 'Advocate stage failed.',
  });
  if (!aParsed?.ok) partialOrIncomplete = true;

  // Deep Stage 3: Privacy Judge (only if Guardian or Advocate returned valid structured data)
  if (gParsed?.ok || aParsed?.ok) {
    onStage?.('Privacy Judge reconciling proposals...');
    const jStart = performance.now();
    const jRes = await reasoner.run(
      {
        jobId: `court_judge_${Date.now()}`,
        task: 'court_judge',
        prompt: buildPrivacyJudgePrompt(purpose, gParsed?.data ?? null, aParsed?.data ?? null),
        maxOutputTokens: 450,
      },
      { signal },
    );
    const jParsed =
      jRes.status === 'completed' ? extractAndValidateJson(jRes.text, CourtJudgeSchema) : null;

    if (jParsed?.ok && jParsed.data) {
      // Apply Judge decisions only to matching findingIds, then re-enforce deterministic privacy floor!
      const updatedCategories = { ...compiled.policy.categories };
      for (const dec of jParsed.data.decisions) {
        const matched = findings.find((f) => f.id === dec.findingId);
        if (matched && !matched.mandatoryFloor) {
          updatedCategories[String(matched.type)] = dec.proposedAction;
        }
      }
      plan = bindPolicyToFindings(
        { ...compiled.policy, categories: updatedCategories },
        'gemma',
        findings,
        strictCloudFloor,
      );
      stages.push({
        stage: 'judge',
        status: 'completed',
        elapsedMs: Math.round(performance.now() - jStart),
        summary: jParsed.data.rationaleSummary,
        conflicts: jParsed.data.conflicts,
      });
    } else {
      partialOrIncomplete = true;
      stages.push({
        stage: 'judge',
        status: 'failed',
        elapsedMs: Math.round(performance.now() - jStart),
        summary: jRes.errorMessage || jParsed?.error || 'Judge stage returned invalid schema.',
      });
    }
  } else {
    stages.push({
      stage: 'judge',
      status: 'skipped',
      elapsedMs: 0,
      summary: 'Skipped Judge because both Guardian and Advocate stages failed.',
    });
  }

  // Final deterministic validator stage (cannot be overruled)
  stages.push({
    stage: 'deterministic_validator',
    status: 'completed',
    elapsedMs: 1,
    summary: `Enforced deterministic privacy floor across ${plan.transforms.length} finding(s).`,
    conflicts: plan.warnings,
  });

  return {
    mode,
    plan,
    stages,
    partialOrIncomplete,
    totalElapsedMs: Math.round(performance.now() - t0),
  };
}

export async function runSemanticOutputReview(
  reasoner: LocalReasoner,
  sanitizedText: string,
  signal?: AbortSignal,
): Promise<{ review?: SemanticOutputReview; error?: string }> {
  if (reasoner.getStatus().state !== 'ready') {
    return { error: 'Gemma 3 4B not loaded.' };
  }
  const res = await reasoner.run(
    {
      jobId: `sem_rev_${Date.now()}`,
      task: 'semantic_review',
      prompt: buildSemanticOutputReviewPrompt(sanitizedText),
      maxOutputTokens: 350,
    },
    { signal },
  );
  if (res.status !== 'completed') {
    return { error: res.errorMessage || 'Semantic output review failed.' };
  }
  const parsed = extractAndValidateJson(res.text, SemanticOutputReviewSchema);
  if (!parsed.ok || !parsed.data) {
    return { error: parsed.error || 'Invalid review JSON.' };
  }
  return { review: parsed.data };
}
