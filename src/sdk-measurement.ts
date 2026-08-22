import { AsyncLocalStorage } from "node:async_hooks";
import { safeErrorDetails } from "./errors.js";
import type { WorkloadSample } from "./workflows.js";

export interface SdkMeasurementContext {
  name: string;
  workflow: WorkloadSample["workflow"];
  operationClass: WorkloadSample["operationClass"];
  kind: WorkloadSample["kind"];
  now: () => number;
  sample: (sample: WorkloadSample) => void;
}

type StoredContext = SdkMeasurementContext & { active: boolean };
const contexts = new AsyncLocalStorage<StoredContext>();

export async function withSdkMeasurement<T>(context: SdkMeasurementContext, work: () => PromiseLike<T> | T): Promise<T> {
  const stored: StoredContext = { ...context, active: true };
  return contexts.run(stored, async () => {
    try { return await work(); }
    finally { stored.active = false; }
  });
}

export async function measureSdkCall<T>(work: () => PromiseLike<T>): Promise<T> {
  const context = contexts.getStore();
  if (!context?.active) return work();
  const started = context.now();
  let result: T;
  try {
    result = await work();
  } catch (error) {
    context.sample({ type: "sdk", name: context.name, workflow: context.workflow, operationClass: context.operationClass, kind: context.kind, elapsedMs: Math.max(0, context.now() - started), success: false, error: safeErrorDetails(error) });
    throw error;
  }
  context.sample({ type: "sdk", name: context.name, workflow: context.workflow, operationClass: context.operationClass, kind: context.kind, elapsedMs: Math.max(0, context.now() - started), success: true });
  return result;
}
