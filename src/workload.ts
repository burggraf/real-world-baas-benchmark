import type { AppSession, Backend } from "./backend.js";
import type { BenchmarkConfig, WorkflowName } from "./config.js";
import type { Credentials } from "./domain.js";
import { mulberry32 } from "./random.js";
import { MAX_PAGE_SIZE, runWorkflow, selectWorkflow, type JourneyName, type WorkloadSample, type WorkflowContext } from "./workflows.js";
import { isIntegrityError, isSessionLossError, safeErrorDetails } from "./errors.js";

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
  lostUsers: number;
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
const asError = safeErrorDetails;

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
  const loopController = new AbortController();
  const requestController = new AbortController();
  const summary: WorkloadSummary = { requestedUsers: options.users.length, startedUsers: 0, completedWorkflowCount: 0, failedWorkflowCount: 0, lostUsers: 0, graceExpired: false, stageFailed: false, closeErrors: 0, preparationFailed: false, preparationFailureCount: 0 };
  const active = new Set<AppSession>();
  let requestsCancelled = false;
  const stopScheduling = (): void => { if (!loopController.signal.aborted) loopController.abort(); };
  const cancelPending = (): void => {
    if (requestsCancelled) return;
    requestsCancelled = true;
    requestController.abort();
    for (const session of active) session.cancelPending();
  };
  const abortWorkload = (): void => { stopScheduling(); cancelPending(); };
  let boundaryClosing = false;
  const stopFromParent = () => { if (boundaryClosing) return; summary.stageFailed = true; abortWorkload(); };
  if (options.signal?.aborted) { summary.stageFailed = true; abortWorkload(); }
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
    const unresolved = [...active].filter(session => !closed.has(session)).length;
    summary.closeErrors = unresolved;
    if (unresolved > 0) summary.stageFailed = true;
  };
  const awaitWorkersAfterDrainDeadline = async (workersDone: Promise<void>): Promise<void> => {
    let settled = false;
    const drainController = new AbortController();
    await Promise.race([
      workersDone.then(() => { settled = true; }),
      sleep(config.timeoutMs, drainController.signal).catch(() => undefined),
    ]);
    drainController.abort();
    if (!settled) {
      summary.graceExpired = true;
      summary.stageFailed = true;
      abortWorkload();
    }
    await workersDone;
  };
  const create = async (spec: VirtualUserSpec, workflow: JourneyName = "signOutIn", measured = false): Promise<AppSession> => {
    const started = now();
    let session: AppSession;
    try {
      session = await backend.createSession(spec.credentials, { signal: requestController.signal, timeoutMs: config.timeoutMs });
    } catch (error) {
      emit(options.onSample, { type: "sdk", name: "createSession", workflow, kind: "read", operationClass: "authSearch", elapsedMs: Math.max(0, now() - started), success: false, error: asError(error) }, measuring && measured);
      throw error;
    }
    active.add(session);
    if (cleanupStarted) {
      await closeSession(session, false, false);
      throw abortError();
    }
    emit(options.onSample, { type: "sdk", name: "createSession", workflow, kind: "read", operationClass: "authSearch", elapsedMs: Math.max(0, now() - started), success: true }, measuring && measured);
    return session;
  };

  const prepareSessions = async (): Promise<boolean> => {
    if (requestController.signal.aborted) {
      summary.preparationFailed = true;
      summary.preparationFailureCount = options.users.length;
      summary.stageFailed = true;
      return false;
    }
    for (let offset = 0; offset < options.users.length; offset += SESSION_PREPARATION_CONCURRENCY) {
      if (requestController.signal.aborted) {
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
      if (failures || requestController.signal.aborted) {
        summary.preparationFailed = true;
        summary.preparationFailureCount = failures + (requestController.signal.aborted ? 1 : 0);
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
    let retired = false;
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
    while (!loopController.signal.aborted && now() < deadline) {
      const configured = runWorkflow(selectForUser(config, random), context);
      try {
        await configured;
        summary.completedWorkflowCount++;
      } catch (error) {
        summary.failedWorkflowCount++;
        if (isIntegrityError(error) || options.stopOnError) {
          summary.stageFailed = true;
          abortWorkload();
          break;
        }
        if (isSessionLossError(error, context.workflow)) {
          if (!retired) { retired = true; summary.lostUsers++; }
          break;
        }
        if (isAbort(error) || loopController.signal.aborted) break;
      }
      if (loopController.signal.aborted || now() >= deadline) break;
      const think = config.thinkTimeMs.min + Math.floor(random() * (config.thinkTimeMs.max - config.thinkTimeMs.min + 1));
      try { await sleep(think, loopController.signal); }
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
    const stopper = (async () => { await Promise.resolve(); await sleep(durationMs, stopperController.signal); stopScheduling(); })().catch(() => {});
    await Promise.race([workersDone, stopper]);
    stopperController.abort();
    stopScheduling();
    let settled = false;
    const graceController = new AbortController();
    await Promise.race([workersDone.then(() => { settled = true; }), sleep(graceMs, graceController.signal).catch(() => {})]);
    graceController.abort();
    if (!settled) { summary.graceExpired = true; summary.stageFailed = true; cancelPending(); }
    if (!settled) await awaitWorkersAfterDrainDeadline(workersDone);
    else await workersDone;
    measuring = false;
    measuredEnded = true;
    boundaryClosing = true;
    await options.onMeasuredEnd?.();
  } catch (error) {
    summary.stageFailed = true;
    if (!isAbort(error)) summary.failedWorkflowCount++;
    abortWorkload();
    // Do not end measurement or close sessions while a worker can still issue backend operations.
    if (allWorkers) await awaitWorkersAfterDrainDeadline(allWorkers);
    measuring = false;
    if (measurementStarted && !measuredEnded) {
      boundaryClosing = true;
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
