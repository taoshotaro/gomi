import { existsSync } from "fs";
import { join } from "path";
import { PipelineError } from "./errors.js";
import type { PipelineContext } from "./context.js";
import type { StepName } from "./types.js";

type ArtifactPointerKey =
  | "sourceManifestPath"
  | "discoverReportPath"
  | "extractionPlanPath"
  | "executionReportPath"
  | "selectionReportPath";

interface ArtifactRequirement {
  label: string;
  producerStep: StepName;
  pointerKey?: ArtifactPointerKey;
  canonicalPath: string;
}

export function hydrateArtifactPointers(context: PipelineContext): void {
  const resolvedSourceManifest = resolveAndPersistPointer(
    context,
    "sourceManifestPath",
    join(context.options.workDir, "source-manifest.json")
  );
  if (resolvedSourceManifest) {
    context.logger.info("Using artifact", {
      step: "system",
      attempt: 0,
      eventType: "validation",
      artifact: "source-manifest",
      path: resolvedSourceManifest,
    });
  }

  resolveAndPersistPointer(
    context,
    "discoverReportPath",
    join(context.options.workDir, "discover-report.json")
  );
  resolveAndPersistPointer(
    context,
    "extractionPlanPath",
    join(context.options.workDir, "extraction-plan.json")
  );
  resolveAndPersistPointer(
    context,
    "executionReportPath",
    join(context.options.workDir, "execution-report.json")
  );
  resolveAndPersistPointer(
    context,
    "selectionReportPath",
    join(context.options.workDir, "selection-report.json")
  );
}

export function assertStepInputsAvailable(step: StepName, context: PipelineContext): void {
  const requirements: ArtifactRequirement[] = [];

  if (step === "download") {
    assertDiscoverState(context, step);
    return;
  }

  if (step === "extraction-plan") {
    assertDiscoverState(context, step);
    requirements.push({
      label: "source manifest",
      producerStep: "download",
      pointerKey: "sourceManifestPath",
      canonicalPath: join(context.options.workDir, "source-manifest.json"),
    });
  }

  if (step === "extract") {
    assertDiscoverState(context, step);
    requirements.push({
      label: "extraction plan",
      producerStep: "extraction-plan",
      pointerKey: "extractionPlanPath",
      canonicalPath: join(context.options.workDir, "extraction-plan.json"),
    });
  }

  if (step === "convert") {
    assertDiscoverState(context, step);
    requirements.push(
      {
        label: "extraction plan",
        producerStep: "extraction-plan",
        pointerKey: "extractionPlanPath",
        canonicalPath: join(context.options.workDir, "extraction-plan.json"),
      },
      {
        label: "execution report",
        producerStep: "extract",
        pointerKey: "executionReportPath",
        canonicalPath: join(context.options.workDir, "execution-report.json"),
      }
    );
  }

  if (step === "validate") {
    assertDiscoverState(context, step);
    requirements.push(
      {
        label: "staged schedule output",
        producerStep: "convert",
        canonicalPath: join(context.dirs.stagingDir, "schedule.json"),
      },
      {
        label: "staged separation output",
        producerStep: "convert",
        canonicalPath: join(context.dirs.stagingDir, "separation.json"),
      }
    );
  }

  for (const requirement of requirements) {
    const path = ensureArtifact(requirement, context, step);
    context.logger.info("Using artifact", {
      step,
      eventType: "validation",
      artifact: requirement.label,
      path,
    });
  }
}

function assertDiscoverState(context: PipelineContext, step: StepName): void {
  if (context.stateStore.state.sources) {
    return;
  }
  throw missingArtifactError({
    step,
    missing: "discover output",
    producerStep: "discover",
    details: "run-state.sources is not set",
  });
}

function ensureArtifact(
  requirement: ArtifactRequirement,
  context: PipelineContext,
  step: StepName
): string {
  if (requirement.pointerKey) {
    const pointerPath = context.stateStore.state[requirement.pointerKey];
    if (pointerPath && existsSync(pointerPath)) {
      return pointerPath;
    }
  }

  if (existsSync(requirement.canonicalPath)) {
    if (requirement.pointerKey) {
      context.stateStore.state[requirement.pointerKey] = requirement.canonicalPath;
      context.stateStore.persist();
    }
    return requirement.canonicalPath;
  }

  throw missingArtifactError({
    step,
    missing: requirement.label,
    producerStep: requirement.producerStep,
    details: requirement.canonicalPath,
  });
}

function resolveAndPersistPointer(
  context: PipelineContext,
  pointerKey: ArtifactPointerKey,
  canonicalPath: string
): string | undefined {
  const pointed = context.stateStore.state[pointerKey];
  if (pointed && existsSync(pointed)) {
    return pointed;
  }
  if (existsSync(canonicalPath)) {
    context.stateStore.state[pointerKey] = canonicalPath;
    context.stateStore.persist();
    return canonicalPath;
  }
  return undefined;
}

function missingArtifactError(input: {
  step: StepName;
  missing: string;
  producerStep: StepName;
  details: string;
}): PipelineError {
  const skipHint =
    `Missing required artifact for step "${input.step}": ${input.missing} (${input.details}). ` +
    `This is produced by "${input.producerStep}". ` +
    `If you used --skip-to ${input.step}, run from an earlier step with the same --work-dir or remove --skip-to.`;

  return new PipelineError(skipHint, {
    code: "MISSING_ARTIFACT",
    retryable: false,
  });
}
