import type { AppSession, Backend } from "./backend.js";
import type { BenchmarkConfig, WorkflowName } from "./config.js";
import type { Credentials } from "./domain.js";
import { mulberry32 } from "./random.js";
import { MAX_PAGE_SIZE, runWorkflow, selectWorkflow, type JourneyName, type WorkloadSample, type WorkflowContext } from "./workflows.js";

export interface VirtualUserSpec {
  credentials: Credentials;
  organizationId: string;
  projectId: string;
  taskId: string;
  commentId?: string;
}
export interface WorkloadClock {
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}
export interface WorkloadOptions extends WorkloadClock {
  users: VirtualUserSpec[];
  durationMs?: number;
  graceMs?: number;
  signal?: AbortSignal;
  onSample?: (sample: WorkloadSample) => void;
  stopOnError?: boolean;
}
export interface WorkloadSummary {
  requestedUsers: number;
  startedUsers: number;
  completedWorkflowCount: number;
  failedWorkflowCount: number;
  graceExpired: boolean;
  stageFailed: boolean;
  closeErrors: number;
}

const defaultNow = (): number => performance.now();
const defaultSleep = (milliseconds: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(abortError()); return; }
  const abort = () => { clearTimeout(timer); reject(abortError()); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, Math.max(0, milliseconds));
  signal?.addEventListener("abort", abort, { once: true });
});
const abortError = (): Error => Object.assign(new Error("Workload aborted"), { name: "AbortError" });
const isAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";
const deriveSeed = (seed: number, index: number): number => (seed + Math.imul(index, 0x9e3779b9)) >>> 0;
const asError = (error: unknown): { name: string; message: string } => ({ name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error) });

const emit = (callback: ((sample: WorkloadSample) => void) | undefined, sample: WorkloadSample): void => callback?.({ ...sample, elapsedMs: Math.max(0, sample.elapsedMs), error: sample.error && { ...sample.error } });

export async function runWorkload(backend: Backend, config: BenchmarkConfig, options: WorkloadOptions): Promise<WorkloadSummary> {
  const now = options.now ?? defaultNow;
  const sleep = options.sleep ?? defaultSleep;
  if (!Array.isArray(options.users)) throw new TypeError("users must be an array");
  if (options.users.some(user => !user.credentials || !user.organizationId || !user.projectId || !user.taskId)) throw new TypeError("each virtual user requires credentials and tenant/project/task context");
  const durationMs = options.durationMs ?? config.stageSeconds * 1000;
  const graceMs = options.graceMs ?? Math.max(0, config.timeoutMs);
  if (!Number.isFinite(durationMs) || durationMs < 0 || !Number.isFinite(graceMs) || graceMs < 0) throw new RangeError("invalid workload duration or grace");
  const onSample = options.onSample;
  const controller = new AbortController();
  const stopFromParent = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", stopFromParent, { once: true });
  const summary: WorkloadSummary = { requestedUsers: options.users.length, startedUsers: 0, completedWorkflowCount: 0, failedWorkflowCount: 0, graceExpired: false, stageFailed: false, closeErrors: 0 };
  const active = new Set<AppSession>();
  const closed = new WeakSet<AppSession>();
  let cleanupStarted = false;
  const call = async <T>(workflow: JourneyName, operation: string, operationClass: WorkloadSample["operationClass"], kind: WorkloadSample["kind"], action: () => Promise<T>): Promise<T> => {
    const started = now();
    try {
      const result = await action();
      emit(onSample, { type: "sdk", name: operation, workflow, kind, operationClass, elapsedMs: Math.max(0, now() - started), success: true });
      return result;
    } catch (error) {
      emit(onSample, { type: "sdk", name: operation, workflow, kind, operationClass, elapsedMs: Math.max(0, now() - started), success: false, error: asError(error) });
      throw error;
    }
  };

  const closeSession = async (session: AppSession, throwError = false): Promise<void> => {
    if (closed.has(session)) return;
    try {
      await call("signOutIn", "close", "authSearch", "read", () => session.close());
      closed.add(session);
    } catch (error) {
      summary.closeErrors++;
      summary.stageFailed = true;
      if (throwError) throw error;
    }
  };
  const create = async (spec: VirtualUserSpec, workflow: JourneyName = "signOutIn"): Promise<AppSession> => {
    const started = now();
    let session: AppSession;
    try {
      session = await backend.createSession(spec.credentials);
    } catch (error) {
      emit(onSample, { type: "sdk", name: "createSession", workflow, kind: "read", operationClass: "authSearch", elapsedMs: Math.max(0, now() - started), success: false, error: asError(error) });
      throw error;
    }
    emit(onSample, { type: "sdk", name: "createSession", workflow, kind: "read", operationClass: "authSearch", elapsedMs: Math.max(0, now() - started), success: true });
    if (cleanupStarted) {
      await closeSession(session);
      throw abortError();
    }
    return session;
  };

  const users = options.users.map((spec, index) => ({ spec, random: mulberry32(deriveSeed(config.seed, index)) }));
  const runUser = async (spec: VirtualUserSpec, random: () => number): Promise<void> => {
    let session: AppSession | undefined;
    const context: WorkflowContext = {
      get session() { if (!session) throw new Error("virtual user has no session"); return session; },
      set session(value: AppSession) { session = value; },
      workflow: "dashboard",
      replaceSession: async () => {
        if (session) {
          const old = session;
          try { await closeSession(old, true); }
          finally { session = undefined; }
          if (closed.has(old)) active.delete(old);
        }
        session = await create(spec);
        active.add(session);
      },
      organizationId: spec.organizationId,
      projectId: spec.projectId,
      taskId: spec.taskId,
      commentId: spec.commentId,
      random,
      pageSize: () => Math.min(MAX_PAGE_SIZE, 1 + Math.floor(random() * 25)),
      now,
      invoke: (operation, operationClass, kind, action) => call(context.workflow, operation, operationClass, kind, action),
      sample: sample => emit(onSample, sample),
    };
    if (controller.signal.aborted) return;
    session = await create(spec);
    active.add(session);
    summary.startedUsers++;
    const deadline = now() + durationMs;
    while (!controller.signal.aborted && now() < deadline) {
      const configured = runWorkflow(selectForUser(config, random), context);
      try {
        await configured;
        summary.completedWorkflowCount++;
      } catch (error) {
        summary.failedWorkflowCount++;
        summary.stageFailed = true;
        if (options.stopOnError) { controller.abort(); break; }
        if (isAbort(error) || controller.signal.aborted) break;
      }
      if (controller.signal.aborted || now() >= deadline) break;
      const think = config.thinkTimeMs.min + Math.floor(random() * (config.thinkTimeMs.max - config.thinkTimeMs.min + 1));
      try { await sleep(think, controller.signal); }
      catch (error) { if (!isAbort(error)) { summary.stageFailed = true; } break; }
    }
  };

  const workers: Promise<void>[] = [];
  for (const user of users) workers.push(runUser(user.spec, user.random).catch(error => { summary.stageFailed = true; if (!isAbort(error)) summary.failedWorkflowCount++; }));
  if (workers.length === 0) { options.signal?.removeEventListener("abort", stopFromParent); return summary; }
  const allWorkers = Promise.all(workers);
  const stopperController = new AbortController();
  let stopper: Promise<void> | undefined;
  if (!controller.signal.aborted) {
    // Let initial authentication settle before a zero-cost injected clock can end the stage.
    // Let initial authentication settle before a zero-cost injected clock can end the stage.
    stopper = (async () => { await Promise.resolve(); await sleep(durationMs, stopperController.signal); controller.abort(); })().catch(() => {});
  }
  await Promise.race([allWorkers, stopper ?? Promise.resolve()]);
  stopperController.abort();
  if (!controller.signal.aborted) controller.abort();
  let settled = false;
  const graceController = new AbortController();
  await Promise.race([allWorkers.then(() => { settled = true; }), sleep(graceMs, graceController.signal).catch(() => {})]);
  graceController.abort();
  if (!settled) { summary.graceExpired = true; summary.stageFailed = true; }
  // Close every session observed, including replacements. Duplicates are avoided by identity.
  cleanupStarted = true;
  for (const session of [...active]) {
    await closeSession(session);
    if (closed.has(session)) active.delete(session);
    if (!closed.has(session)) {
      await closeSession(session);
      if (closed.has(session)) active.delete(session);
    }
  }
  options.signal?.removeEventListener("abort", stopFromParent);
  return summary;
}

const selectForUser = (config: BenchmarkConfig, random: () => number): WorkflowName => selectWorkflow(config.weights, random);

export const runStage = runWorkload;
