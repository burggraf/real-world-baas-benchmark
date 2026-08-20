import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Backend, BackendInfo } from "./backend.js";
import { evaluateCapacity } from "./capacity.js";
import type { BenchmarkConfig } from "./config.js";
import { runCorrectness, type CorrectnessFixture } from "./correctness.js";
import { StageMetricsAccumulator } from "./metrics.js";
import type { BenchmarkResult, Capacity, Correctness } from "./result.js";
import { buildSeedVirtualUserSpecs, profileMetadata } from "./seed.js";
import { captureEnvironment, collectResources, evaluateRunnerOverload, type ResourceCollection } from "./system.js";
import { runWorkload, type WorkloadSummary } from "./workload.js";
export { buildSeedVirtualUserSpecs } from "./seed.js";

export type SetupBackend = Backend;
export interface RunDependencies {
  loadBackend?: (name: string) => Promise<SetupBackend>;
  captureEnvironment?: (info: BackendInfo) => Promise<BenchmarkResult["environment"]>;
  correctness?: (backend: Backend, fixture: CorrectnessFixture) => Promise<{ findings: Correctness["findings"]; aborted?: boolean; abortReason?: string }>;
  workload?: typeof runWorkload;
  resources?: (options: Parameters<typeof collectResources>[0]) => Promise<ResourceCollection>;
  now?: () => Date;
  monotonic?: () => number;
  write?: (path: string, text: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  overloadThresholds?: Parameters<typeof evaluateRunnerOverload>[1];
}
export interface RunOptions { backend: string; config: BenchmarkConfig; resultPath: string; dependencies?: RunDependencies; }

const RESOURCE_INTERVAL_MS = 1_000;
const MAX_LATENCY_SAMPLES = 2_000_000;
const MAX_ERROR_EXAMPLES = 100;
const MIN_ACHIEVED_RATIO = 0.95;
const SATURATION_MATERIAL_INCREASE = 0.2;
const SATURATION_MAX_TPS_GAIN = 0.1;
const DEFAULT_OVERLOAD = { cpuPercent: 90, p99Ms: 100, maxMs: 250, consecutiveSamples: 3 } as const;
const RESOURCE_SAMPLE_FORMULA = "ceil((stageDurationMs + graceMs) / intervalMs) + 2" as const;

export function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "command failed";
  return error.message
    .replace(/([?&](?:password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/(["']?authorization["']?)\s*[:=]\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^,;}\r\n]*)/gi, "$1=[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[^\s,;}]+/gi, "$1 [REDACTED]")
    .replace(/(["']?)(password|passwd|secret|token|api[_-]?key|access[_-]?key)\1\s*[:=]\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;&}]+)/gi, "$2=[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .slice(0, 300);
}

const isoId = (date: Date, backend: string, config: string): string => `${date.toISOString().replace(/[^0-9TZ]/g, "-")}-${backend.replace(/[^A-Za-z0-9_-]/g, "-")}-${config.replace(/[^A-Za-z0-9_-]/g, "-")}`;
const emptyCapacity = (): Capacity => ({ users: 0, saturation: false, reasons: ["capacity not evaluated"] });
const atomic = async (path: string, text: string, write: (p: string, t: string) => Promise<void>, move: (a: string, b: string) => Promise<void>) => {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try { await write(tmp, text); await move(tmp, path); } finally { await unlink(tmp).catch(() => undefined); }
};
const serialize = (value: unknown): string => JSON.stringify(value, (_key, v) => typeof v === "number" && !Number.isFinite(v) ? null : v, 2) + "\n";
const sortedPids = (info: BackendInfo): number[] => [...(info.processIds ?? [])].sort((a, b) => a - b);
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
function identityChange(baseline: BackendInfo, current: BackendInfo): string | undefined {
  if (baseline.name !== current.name) return "backend identity changed: name mismatch";
  if (baseline.name === "supabase") {
    if (!baseline.supabaseProjectId || !current.supabaseProjectId) return "backend identity changed: Supabase project ID missing";
    if (baseline.supabaseProjectId !== current.supabaseProjectId || baseline.version !== current.version || baseline.endpoint !== current.endpoint) return "backend identity changed: Supabase project/version/endpoint mismatch";
    return undefined;
  }
  if (!baseline.processExecutable || !current.processExecutable || sortedPids(baseline).length === 0 || sortedPids(current).length === 0) return "backend identity changed: owned process identity missing";
  if (baseline.processExecutable !== current.processExecutable || !same(sortedPids(baseline), sortedPids(current))) return "backend identity changed: owned process executable or PIDs changed";
  return undefined;
}
const mapCapacity = (value: ReturnType<typeof evaluateCapacity>): Capacity => ({ users: value.selectedCapacityUsers, saturation: value.saturation, reasons: value.reasons });
const safeText = (value: string | undefined): string | undefined => value === undefined ? undefined : safeErrorMessage(new Error(value));
const sanitizeCorrectness = (value: Correctness): Correctness => {
  const findings = value.findings.map(finding => {
    const message = safeText(finding.message); const evidence = safeText(finding.evidence);
    return { name: safeText(finding.name)!, passed: finding.passed, classification: finding.classification, ...(message === undefined ? {} : { message }), ...(evidence === undefined ? {} : { evidence }) };
  });
  const abortReason = safeText(value.abortReason);
  return { findings, ...(value.aborted === undefined ? {} : { aborted: value.aborted }), ...(abortReason === undefined ? {} : { abortReason }) };
};
const conclusive = (evaluation: ReturnType<typeof evaluateCapacity>["stages"][number]): boolean => !evaluation.invalid && !evaluation.reasons.some(reason => /fewer than|missing from/.test(reason));

export async function runBenchmark(options: RunOptions): Promise<{ result: BenchmarkResult; resultPath: string }> {
  if (!options || typeof options.backend !== "string" || !options.backend || !options.config || !options.resultPath || basename(options.resultPath).includes("..") || options.resultPath.includes("\0") || options.resultPath.split(/[\\/]/).includes("..")) throw new Error("invalid benchmark options");
  const d = options.dependencies ?? {};
  const load = d.loadBackend ?? (async name => (await import("./backend.js")).loadBackend(name) as Promise<SetupBackend>);
  const backend = await load(options.backend);
  const write = d.write ?? ((path, text) => writeFile(path, text, { encoding: "utf8", mode: 0o600 }));
  const move = d.rename ?? rename;
  await mkdir(dirname(options.resultPath), { recursive: true });
  const started = (d.now ?? (() => new Date()))();
  const stageDurationMs = options.config.stageSeconds * 1_000;
  const overloadThresholds = {
    cpuPercent: d.overloadThresholds?.cpuPercent ?? DEFAULT_OVERLOAD.cpuPercent,
    p99Ms: d.overloadThresholds?.p99Ms ?? DEFAULT_OVERLOAD.p99Ms,
    maxMs: d.overloadThresholds?.maxMs ?? DEFAULT_OVERLOAD.maxMs,
    consecutiveSamples: d.overloadThresholds?.consecutiveSamples ?? DEFAULT_OVERLOAD.consecutiveSamples,
  };
  const resourceMaxSamples = Math.ceil((stageDurationMs + options.config.timeoutMs) / RESOURCE_INTERVAL_MS) + 2;
  const minClassSamples = options.config.publishable ? 20 : 1;
  const warmupUserCount = options.config.warmupSeconds > 0 ? Math.max(...options.config.concurrency) : 0;
  const result: BenchmarkResult = {
    schemaVersion: 1,
    runId: isoId(started, options.backend, options.config.name),
    startedAt: started.toISOString(),
    publishable: options.config.publishable,
    backend: { name: options.backend as BackendInfo["name"], version: "unknown", endpoint: "unknown" },
    dataset: options.config.dataset,
    seed: options.config.seed,
    environment: {} as BenchmarkResult["environment"],
    versions: {},
    config: options.config,
    settings: {
      warmupUserCount,
      warmupWritesUnscored: true,
      resourceIntervalMs: RESOURCE_INTERVAL_MS,
      resourceMaxSamples: { stageDurationMs, graceMs: options.config.timeoutMs, formula: RESOURCE_SAMPLE_FORMULA, value: resourceMaxSamples },
      overloadThresholds,
      minClassSamples,
      minAchievedRatio: MIN_ACHIEVED_RATIO,
      saturationMaterialIncrease: SATURATION_MATERIAL_INCREASE,
      saturationMaxThroughputGain: SATURATION_MAX_TPS_GAIN,
      maxLatencySamples: MAX_LATENCY_SAMPLES,
      maxErrorExamples: MAX_ERROR_EXAMPLES,
    },
    correctness: { findings: [], aborted: true, abortReason: "not run" },
    stages: [], resources: [], capacity: emptyCapacity(), failures: [], valid: false, validityReasons: ["run incomplete"],
  };
  const save = async () => atomic(options.resultPath, serialize(result), write, move);
  let stopFailure: unknown;
  let baseline: BackendInfo | undefined;
  try {
    await backend.doctor();
    await backend.start();
    result.backend = await backend.doctor();
    result.environment = await (d.captureEnvironment ?? (info => captureEnvironment(info)))(result.backend);
    await backend.reset();
    // Process-backed resets restart the owned server; this is the stable post-lifecycle-start identity.
    baseline = await backend.doctor();
    result.backend = baseline;
    await backend.seed({ name: options.config.dataset, definition: { ...profileMetadata[options.config.dataset] } }, options.config.seed);
    const fixture = backend.seedCorrectnessFixture ? await backend.seedCorrectnessFixture() : undefined;
    if (!fixture) throw new Error("backend correctness fixture setup unavailable");
    result.correctness = sanitizeCorrectness(await (d.correctness ?? runCorrectness)(backend, fixture));
    if (result.correctness.aborted || result.correctness.findings.some(finding => !finding.passed)) throw new Error("correctness checks failed");
    const users = backend.buildVirtualUserSpecs ? await backend.buildVirtualUserSpecs(options.config.dataset, options.config.maxConcurrency, options.config.seed) : [];
    const ready = await backend.doctor();
    const readyIdentityFailure = identityChange(baseline, ready);
    if (readyIdentityFailure) throw new Error(readyIdentityFailure);
    result.environment = await (d.captureEnvironment ?? (info => captureEnvironment(info)))(ready);
    result.versions = { backend: ready.version, sdk: result.environment.sdkVersion ?? "unknown", runtime: result.environment.runtimeVersion };
    if (options.config.warmupSeconds > 0) {
      const warmup = await (d.workload ?? runWorkload)(backend, options.config, { users: users.slice(0, warmupUserCount), durationMs: options.config.warmupSeconds * 1_000, graceMs: options.config.timeoutMs, onSample: undefined });
      result.validityReasons = warmup.stageFailed ? ["warmup failed"] : ["warmup writes are unscored"];
      if (warmup.stageFailed) throw new Error("warmup failed");
    }
    if (users.length < options.config.maxConcurrency) throw new Error("backend returned insufficient workload users");
    await save();

    const monotonic = d.monotonic ?? (() => performance.now());
    const resourceFn = d.resources ?? collectResources;
    const workloadFn = d.workload ?? runWorkload;
    const stages = [...options.config.concurrency];
    let refined = false;
    let refinementStage: number | undefined;
    let conclusiveFailureSeen = false;
    for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
      const requestedUsers = stages[stageIndex]!;
      const stageInfo = await backend.doctor().catch(() => { throw new Error("pre-stage backend doctor failed"); });
      const preIdentityFailure = identityChange(baseline, stageInfo);
      const stageStart = monotonic();
      const acc = new StageMetricsAccumulator({ maxLatencySamples: MAX_LATENCY_SAMPLES, maxErrorExamples: MAX_ERROR_EXAMPLES });
      const controller = new AbortController();
      const resourcesPromise = resourceFn({ backend: stageInfo, maxSamples: resourceMaxSamples, intervalMs: RESOURCE_INTERVAL_MS, signal: controller.signal, shouldStop: () => controller.signal.aborted }).catch((): ResourceCollection => ({ samples: [], valid: false, validityReasons: ["resource collection failed"] }));
      let summary: WorkloadSummary;
      let workloadEnd = stageStart;
      try {
        summary = await workloadFn(backend, options.config, { users: users.slice(0, requestedUsers), durationMs: stageDurationMs, graceMs: options.config.timeoutMs, onSample: sample => acc.record(sample) });
      } finally {
        workloadEnd = monotonic();
        controller.abort();
      }
      const resources = await resourcesPromise;
      let postStageFailure: string | undefined;
      try {
        const postStageInfo = await backend.doctor();
        postStageFailure = identityChange(baseline, postStageInfo);
      } catch { postStageFailure = "post-stage backend doctor failed"; }
      const elapsed = (workloadEnd - stageStart) / 1_000;
      if (!Number.isFinite(elapsed) || elapsed <= 0) throw new Error("invalid monotonic stage elapsed time");
      const stage = acc.finalize(elapsed, { requestedUsers, achievedUsers: summary.startedUsers });
      const reasons = [...stage.validityReasons];
      if (preIdentityFailure) reasons.push(preIdentityFailure);
      if (postStageFailure) reasons.push(postStageFailure);
      if (summary.stageFailed) reasons.push("workload failed");
      if (summary.closeErrors) reasons.push("session close failed");
      if (summary.graceExpired) reasons.push("grace period expired");
      if (summary.startedUsers < requestedUsers) reasons.push("achieved user count below requested");
      if (!resources.valid) reasons.push(...resources.validityReasons);
      const overload = evaluateRunnerOverload(resources.samples, overloadThresholds);
      if (overload) reasons.push(overload);
      stage.valid = reasons.length === 0;
      stage.validityReasons = [...new Set(reasons)];
      result.stages.push(stage);
      result.resources.push({ name: `stage-${requestedUsers}`, unit: "snapshot", samples: resources.samples.map(() => null), snapshots: resources.samples });
      result.stages.sort((left, right) => left.requestedUsers - right.requestedUsers);
      const evaluation = evaluateCapacity(result.stages, options.config, { minSamples: minClassSamples, minAchievedRatio: MIN_ACHIEVED_RATIO, materialIncrease: SATURATION_MATERIAL_INCREASE, maxThroughputGain: SATURATION_MAX_TPS_GAIN });
      result.capacity = mapCapacity(evaluation);
      const currentEvaluation = evaluation.stages.find(item => item.requestedUsers === requestedUsers);
      const previous = stageIndex > 0 ? stages[stageIndex - 1]! : undefined;
      const previousEvaluation = previous === undefined ? undefined : evaluation.stages.find(item => item.requestedUsers === previous);
      const currentFailedConclusively = Boolean(currentEvaluation && !currentEvaluation.passed && conclusive(currentEvaluation));
      if (currentFailedConclusively) conclusiveFailureSeen = true;
      if (currentFailedConclusively && previousEvaluation?.passed && previous !== undefined && requestedUsers - previous > 1 && !refined) {
        const midpoint = Math.floor((previous + requestedUsers) / 2);
        if (midpoint <= options.config.maxConcurrency && !stages.includes(midpoint)) { stages.splice(stageIndex + 1, 0, midpoint); refinementStage = midpoint; refined = true; }
      }
      const configuredDone = options.config.concurrency.every(count => result.stages.some(item => item.requestedUsers === count));
      if (configuredDone && !conclusiveFailureSeen && currentEvaluation?.passed && requestedUsers < options.config.maxConcurrency) {
        const next = Math.min(options.config.maxConcurrency, requestedUsers * 2);
        if (next > requestedUsers && !stages.includes(next)) stages.push(next);
      }
      await save();
      if (refinementStage === requestedUsers || (currentFailedConclusively && refinementStage === undefined)) break;
    }
    result.valid = result.correctness.findings.every(finding => finding.passed) && result.stages.length > 0 && result.stages.every(stage => stage.valid) && result.capacity.users > 0;
    result.validityReasons = result.valid ? [] : ["one or more benchmark prerequisites failed"];
    await save();
  } catch (error) {
    result.failures.push(safeErrorMessage(error));
    result.valid = false;
    result.validityReasons = ["benchmark failed"];
    await save().catch(() => undefined);
    throw error;
  } finally {
    try { await backend.stop(); }
    catch (error) { stopFailure = error; result.failures.push(safeErrorMessage(error)); result.valid = false; result.validityReasons.push("backend stop failed"); await save().catch(() => undefined); }
  }
  if (stopFailure) throw stopFailure;
  return { result, resultPath: options.resultPath };
}
