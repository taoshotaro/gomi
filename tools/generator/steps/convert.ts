import { runConvertArtifacts } from "../convert/run.js";
import type { PipelineContext } from "../pipeline/context.js";

export async function runConvertStep(
  context: PipelineContext,
  signal: AbortSignal
): Promise<void> {
  context.stateStore.setStepMessage("convert", "Converting extracted artifacts into canonical outputs");
  await runConvertArtifacts(context, signal);
}
