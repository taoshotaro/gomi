import type { GenerateOptions } from "./types.js";
import type { RunStateStore } from "./state.js";
import type { Logger } from "./logger.js";
import { createModel } from "../lib/ai.js";
import type { BudgetManager } from "./budget.js";
import type { ModelRuntimeConfig, SkillsRuntimeStatus } from "./types.js";

export interface RuntimeDirs {
  downloadDir: string;
  stagingDir: string;
  summaryPath: string;
}

export interface PipelineContext {
  options: GenerateOptions;
  logger: Logger;
  stateStore: RunStateStore;
  model: ReturnType<typeof createModel>;
  dirs: RuntimeDirs;
  budget: BudgetManager;
  runtime: ModelRuntimeConfig;
  skillsStatus?: SkillsRuntimeStatus;
}
