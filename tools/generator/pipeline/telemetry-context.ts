import { AsyncLocalStorage } from "async_hooks";
import type { StepName } from "./types.js";

export interface TelemetryContextValue {
  step: StepName | "system";
  attempt: number;
}

const storage = new AsyncLocalStorage<TelemetryContextValue>();

export function runWithTelemetryContext<T>(
  value: TelemetryContextValue,
  fn: () => Promise<T>
): Promise<T> {
  return storage.run(value, fn);
}

export function getTelemetryContext(): TelemetryContextValue {
  return storage.getStore() ?? { step: "system", attempt: 0 };
}
