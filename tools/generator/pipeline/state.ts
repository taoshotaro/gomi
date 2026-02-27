import { existsSync } from "fs";
import { join } from "path";
import { readJsonFile, writeJsonAtomic } from "../lib/json.js";
import { emitAgentEvent } from "./events.js";
import type {
  DiscoverOutputV2,
  GenerateOptions,
  HttpArtifact,
  RunState,
  StepName,
  StepState,
  StepStatus,
} from "./types.js";
import { STEP_ORDER } from "./types.js";

export function runStatePath(workDir: string): string {
  return join(workDir, "run-state.json");
}

export class RunStateMismatchError extends Error {
  constructor(
    public readonly statePath: string,
    public readonly existing: { runId: string; city: string; prefecture: string },
    public readonly requested: { runId: string; city: string; prefecture: string }
  ) {
    super(
      `Existing run-state does not match requested run. existing={runId:${existing.runId},city:${existing.city},prefecture:${existing.prefecture}} requested={runId:${requested.runId},city:${requested.city},prefecture:${requested.prefecture}}`
    );
    this.name = "RunStateMismatchError";
  }
}

function createInitialStepState(): StepState {
  return {
    status: "pending",
    attempts: 0,
    history: [],
  };
}

function createInitialStepStatuses(): Record<StepName, StepState> {
  return {
    discover: createInitialStepState(),
    download: createInitialStepState(),
    "extraction-plan": createInitialStepState(),
    extract: createInitialStepState(),
    convert: createInitialStepState(),
    validate: createInitialStepState(),
  };
}

function createInitialRunState(options: GenerateOptions): RunState {
  return {
    version: "2.0.0",
    runId: options.runId,
    city: options.city,
    prefecture: options.prefecture,
    startedAt: new Date().toISOString(),
    stepStatuses: createInitialStepStatuses(),
    artifacts: {
      downloadedFiles: [],
      outputPaths: [],
      http: [],
    },
  };
}

export class RunStateStore {
  public state: RunState;

  constructor(
    public readonly path: string,
    state: RunState
  ) {
    this.state = state;
  }

  static loadOrCreate(options: GenerateOptions): RunStateStore {
    const path = runStatePath(options.workDir);
    if (existsSync(path)) {
      const existing = readJsonFile<RunState>(path);
      if (
        existing.runId !== options.runId ||
        existing.city !== options.city ||
        existing.prefecture !== options.prefecture
      ) {
        throw new RunStateMismatchError(
          path,
          {
            runId: existing.runId,
            city: existing.city,
            prefecture: existing.prefecture,
          },
          {
            runId: options.runId,
            city: options.city,
            prefecture: options.prefecture,
          }
        );
      }
      const desired = createInitialStepStatuses();
      for (const step of STEP_ORDER) {
        if (!existing.stepStatuses[step]) {
          existing.stepStatuses[step] = desired[step];
        }
      }
      return new RunStateStore(path, existing);
    }

    const state = createInitialRunState(options);
    const store = new RunStateStore(path, state);
    store.persist();
    return store;
  }

  persist(): void {
    writeJsonAtomic(this.path, this.state);
  }

  markStepStatus(step: StepName, status: StepStatus): void {
    const target = this.state.stepStatuses[step];
    target.status = status;
    if (!target.startedAt && status === "running") {
      target.startedAt = new Date().toISOString();
    }
    if (status === "succeeded" || status === "failed" || status === "skipped") {
      target.endedAt = new Date().toISOString();
    }
    if (status === "skipped") {
      target.message = "Skipped";
      target.messageUpdatedAt = new Date().toISOString();
    }
    this.persist();
  }

  markStepAttemptStart(step: StepName, attempt: number): void {
    const target = this.state.stepStatuses[step];
    target.status = "running";
    target.attempts = Math.max(target.attempts, attempt);
    target.message = `Running attempt ${attempt}`;
    target.messageUpdatedAt = new Date().toISOString();
    if (!target.startedAt) {
      target.startedAt = new Date().toISOString();
    }
    target.history.push({
      attempt,
      startedAt: new Date().toISOString(),
      status: "running",
    });
    this.persist();
  }

  markStepAttemptResult(
    step: StepName,
    attempt: number,
    ok: boolean,
    errorCode?: string,
    errorMessage?: string
  ): void {
    const target = this.state.stepStatuses[step];
    const record = [...target.history].reverse().find((item) => item.attempt === attempt);

    if (record) {
      record.endedAt = new Date().toISOString();
      record.status = ok ? "succeeded" : "failed";
      if (!ok) {
        record.errorCode = errorCode;
        record.errorMessage = errorMessage;
      }
    }

    if (ok) {
      target.status = "succeeded";
      target.message = `Succeeded on attempt ${attempt}`;
      target.messageUpdatedAt = new Date().toISOString();
      target.lastErrorCode = undefined;
      target.lastErrorMessage = undefined;
      target.endedAt = new Date().toISOString();
    } else {
      target.status = "failed";
      target.message = `Failed on attempt ${attempt}: ${errorMessage ?? "unknown error"}`;
      target.messageUpdatedAt = new Date().toISOString();
      target.lastErrorCode = errorCode;
      target.lastErrorMessage = errorMessage;
      target.endedAt = new Date().toISOString();
    }

    this.persist();
  }

  setStepMessage(step: StepName, message: string): void {
    const target = this.state.stepStatuses[step];
    target.message = message;
    target.messageUpdatedAt = new Date().toISOString();
    this.persist();
    emitAgentEvent({
      level: "info",
      eventType: "state.update",
      step,
      attempt: target.attempts,
      message: "Step message updated",
      action: message,
    });
  }

  addDownloadedFile(path: string): void {
    if (!this.state.artifacts.downloadedFiles.includes(path)) {
      this.state.artifacts.downloadedFiles.push(path);
      this.persist();
    }
  }

  addOutputPath(path: string): void {
    if (!this.state.artifacts.outputPaths.includes(path)) {
      this.state.artifacts.outputPaths.push(path);
      this.persist();
    }
  }

  addHttpArtifact(artifact: HttpArtifact): void {
    this.state.artifacts.http.push(artifact);
    this.persist();
  }

  setSources(sources: DiscoverOutputV2): void {
    this.state.sources = sources;
    this.persist();
  }

  ensurePendingForForcedSteps(forcedSteps: Set<StepName>): void {
    for (const step of STEP_ORDER) {
      if (forcedSteps.has(step)) {
        this.state.stepStatuses[step].status = "pending";
      }
    }
    this.persist();
  }

  markFinished(): void {
    this.state.finishedAt = new Date().toISOString();
    this.persist();
  }
}
