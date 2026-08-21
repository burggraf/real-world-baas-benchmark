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
  /** Opens the measured boundary; onMeasuredEnd is called only if this resolves. */
  onMeasuredStart?: () => void | Promise<void>;
  /** Closes a successfully opened measured boundary, before final session cleanup. */
  onMeasuredEnd?: () => void | Promise<void>;
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
  preparationFailed: boolean;
  preparationFailureCount: number;
}

export const SESSION_PREPARATION_CONCURRENCY = 10;

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

const emit = (callback: ((sample: WorkloadSample) => void) | undefined, sample: WorkloadSample, enabled: boolean): void => {
  if (enabled) callback?.({ ...sample, elapsedMs: Math.max(0, sample.elapsedMs), error: sample.error && { ...sample.error } });
};

export async function runWorkload(backend: Backend, config: BenchmarkConfig, options: WorkloadOptions): Promise<WorkloadSummary> {
  const now = options.now ?? defaultNow;
  const sleep = options.sleep ?? defaultSleep;
  if (!Array.isArray(options.users)) throw new TypeError("users must be an array");
  if (options.users.some(user => !user.credentials || !user.organizationId || !user.projectId || !user.taskId)) throw new TypeError("each virtual user requires credentials and tenant/project/task context");
  const durationMs = options.durationMs ?? config.stageSeconds * 1000;
  const graceMs = options.graceMs ?? Math.max(0, config.timeoutMs);
  if (!Number.isFinite(durationMs) || durationMs < 0 || !Number.isFinite(graceMs) || graceMs < 0) throw new RangeError("invalid workload duration or grace");
  const controller = new AbortController();
  const summary: WorkloadSummary = { requestedUsers: options.users.length, startedUsers: 0, completedWorkflowCount: 0, failedWorkflowCount: 0, graceExpired: false, stageFailed: false, closeErrors: 0, preparationFailed: false, preparationFailureCount: 0 };
  const active = new Set<AppSession>();
  const abortWorkload = (): void => {
    if (controller.signal.aborted) return;
    controller.abort();
    for (const session of active) session.cancelPending();
  };
  const stopFromParent = () => abortWorkload();
  if (options.signal?.aborted) abortWorkload();
  else options.signal?.addEventListener("abort", stopFromParent, { once: true });
  const closed = new WeakSet<AppSession>();
  let cleanupStarted = false;
  let measuring = false;

  const call = async <T>(workflow: JourneyName, operation: string, operationClass: WorkloadSample["operationClass"], kind: WorkloadSample["kind"], action: () => Promise<T>, emitEnabled = measuring): Promise<T> => {
    const started = now();
    try {
      const result = await action();
      emit(options.onSample, { type: "sdk", name: operation, workflow, kind, operationClass, elapsedMs: Math.max(0, now() - started), success: true }, emitEnabled);
      return result;
    } catch (error) {
      emit(options.onSample, { type: "sdk", name: operation, workflow, kind, operationClass, elapsedMs: Math.max(0, now() - started), success: false, error: asError(error) }, emitEnabled);
      throw error;
    }
  };

  const closeSession = async (session: AppSession, throwError = false, measured = false): Promise<void> => {
    if (closed.has(session)) return;
    try {
      await call("signOutIn", "close", "authSearch", "read", () => session.close(), measured);
      closed.add(session);
    } catch (error) {
      summary.closeErrors++;
      summary.stageFailed = true;
      if (throwError) throw error;
    }
  };
  const closeAll = async (): Promise<void> => {
    for (let attempt = 0; attempt < 2 && active.size; attempt++) {
      const batch = [...active];
      for (let offset = 0; offset < batch.length; offset += SESSION_PREPARATION_CONCURRENCY) {
        await Promise.allSettled(batch.slice(offset, offset + SESSION_PREPARATION_CONCURRENCY).map(session => closeSession(session)));
      }
      for (const session of batch) if (closed.has(session)) active.delete(session);
    }
  };
  const create = async (spec: VirtualUserSpec, workflow: JourneyName = "signOutIn", measured = false): Promise<AppSession> => {
    const started = now();
    let session: AppSession;
    try {
      session = await backend.createSession(spec.credentials, { signal: controller.signal, timeoutMs: config.timeoutMs });
    } catch (error) {
      emit(options.onSample, { type: "sdk", name: "createSession", workflow, kind: "read", operationClass: "authSearch", elapsedMs: Math.max(0, now() - started), success: false, error: asError(error) }, measuring && measured);
      throw error;
    }
    if (cleanupStarted) {
      await closeSession(session, false, false);
      throw abortError();
    }
    emit(options.onSample, { type: "sdk", name: "createSession", workflow, kind: "read", operationClass: "authSearch", elapsedMs: Math.max(0, now() - started), success: true }, measuring && measured);
    return session;
  };

  const prepareSessions = async (): Promise<boolean> => {
    if (controller.signal.aborted) {
      summary.preparationFailed = true;
      summary.preparationFailureCount = options.users.length;
      summary.stageFailed = true;
      return false;
    }
    for (let offset = 0; offset < options.users.length; offset += SESSION_PREPARATION_CONCURRENCY) {
      if (controller.signal.aborted) {
        summary.preparationFailed = true;
        summary.preparationFailureCount = options.users.length - offset;
        summary.stageFailed = true;
        return false;
      }
      const batch = options.users.slice(offset, offset + SESSION_PREPARATION_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(spec => create(spec)));
      let failures = 0;
      for (const result of settled) {
        if (result.status === "fulfilled") active.add(result.value);
        else failures++;
      }
      if (failures || controller.signal.aborted) {
        summary.preparationFailed = true;
        summary.preparationFailureCount = failures + (controller.signal.aborted ? 1 : 0);
        summary.stageFailed = true;
        return false;
      }
    }
    summary.startedUsers = options.users.length;
    return true;
  };

  const users = options.users.map((spec, index) => ({ spec, random: mulberry32(deriveSeed(config.seed, index)) }));
  const runUser = async (spec: VirtualUserSpec, random: () => number, initial: AppSession, deadline: number): Promise<void> => {
    let session: AppSession | undefined = initial;
    const context: WorkflowContext = {
      get session() { if (!session) throw new Error("virtual user has no session"); return session; },
      set session(value: AppSession) { session = value; },
      workflow: "dashboard",
      replaceSession: async () => {
        if (session) {
          const old = session;
          try { await closeSession(old, true, true); }
          finally { session = undefined; }
          if (closed.has(old)) active.delete(old);
        }
        session = await create(spec, "signOutIn", true);
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
      sample: sample => emit(options.onSample, sample, measuring),
    };
    while (!controller.signal.aborted && now() < deadline) {
      const configured = runWorkflow(selectForUser(config, random), context);
      try {
        await configured;
        summary.completedWorkflowCount++;
      } catch (error) {
        summary.failedWorkflowCount++;
        summary.stageFailed = true;
        if (options.stopOnError) { abortWorkload(); break; }
        if (isAbort(error) || controller.signal.aborted) break;
      }
      if (controller.signal.aborted || now() >= deadline) break;
      const think = config.thinkTimeMs.min + Math.floor(random() * (config.thinkTimeMs.max - config.thinkTimeMs.min + 1));
      try { await sleep(think, controller.signal); }
      catch (error) { if (!isAbort(error)) summary.stageFailed = true; break; }
    }
  };

  const prepared = await prepareSessions();
  if (!prepared) {
    cleanupStarted = true;
    await closeAll();
    options.signal?.removeEventListener("abort", stopFromParent);
    return summary;
  }
  if (users.length === 0) {
    options.signal?.removeEventListener("abort", stopFromParent);
    return summary;
  }

  let measuredEnded = false;
  let measurementStarted = false;
  let allWorkers: Promise<void> | undefined;
  try {
    await options.onMeasuredStart?.();
    measurementStarted = true;
    measuring = true;
    const deadline = now() + durationMs;
    const workers = users.map(({ spec, random }, index) => runUser(spec, random, [...active][index]!, deadline).catch(error => { summary.stageFailed = true; if (!isAbort(error)) summary.failedWorkflowCount++; }));
    allWorkers = Promise.all(workers).then(() => undefined);
    const workersDone = allWorkers;
    const stopperController = new AbortController();
    const stopper = (async () => { await Promise.resolve(); await sleep(durationMs, stopperController.signal); abortWorkload(); })().catch(() => {});
    await Promise.race([workersDone, stopper]);
    stopperController.abort();
    if (!controller.signal.aborted) abortWorkload();
    let settled = false;
    const graceController = new AbortController();
    await Promise.race([workersDone.then(() => { settled = true; }), sleep(graceMs, graceController.signal).catch(() => {})]);
    graceController.abort();
    if (!settled) { summary.graceExpired = true; summary.stageFailed = true; }
    measuring = false;
    measuredEnded = true;
    await options.onMeasuredEnd?.();
    await workersDone;
  } catch (error) {
    summary.stageFailed = true;
    if (!isAbort(error)) summary.failedWorkflowCount++;
    abortWorkload();
    measuring = false;
    // Do not close sessions while a worker can still issue backend operations.
    if (allWorkers) await allWorkers;
    if (measurementStarted && !measuredEnded) {
      measuredEnded = true;
      try { await options.onMeasuredEnd?.(); } catch { summary.stageFailed = true; }
    }
  } finally {
    cleanupStarted = true;
    measuring = false;
    await closeAll();
    options.signal?.removeEventListener("abort", stopFromParent);
  }
  return summary;
}

const selectForUser = (config: BenchmarkConfig, random: () => number): WorkflowName => selectWorkflow(config.weights, random);

export const runStage = runWorkload;
