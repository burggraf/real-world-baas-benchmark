import { mkdir, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, basename } from "node:path";
import type { Backend, BackendInfo } from "./backend.js";
import type { BenchmarkConfig } from "./config.js";
import { captureEnvironment, collectResources, evaluateRunnerOverload, type ResourceCollection, type ResourceSnapshot } from "./system.js";
import { runCorrectness, type CorrectnessFixture } from "./correctness.js";
import { StageMetricsAccumulator } from "./metrics.js";
import { evaluateCapacity } from "./capacity.js";
import { runWorkload, type VirtualUserSpec, type WorkloadSummary } from "./workload.js";
import type { BenchmarkResult, Capacity, Correctness, StageMetrics } from "./result.js";
import { profileMetadata, buildSeedVirtualUserSpecs } from "./seed.js";
export { buildSeedVirtualUserSpecs } from "./seed.js";

export interface SetupBackend extends Backend {
  seedCorrectnessFixture?: () => Promise<CorrectnessFixture>;
  buildVirtualUserSpecs?: (profile: BenchmarkConfig["dataset"], count: number, seed: number) => Promise<VirtualUserSpec[]>;
}
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

const safeError = (e: unknown): string => {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/(["']?)(password|passwd|secret|token|api[_-]?key|authorization|access[_-]?key)\1\s*[:=]\s*(["']?)(.*?)(\3(?=\s*[,}])|[,;}\n]|$)/gi, "$1$2$1:$3[REDACTED]$5").replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [REDACTED]").slice(0, 300);
};
const isoId = (date: Date, backend: string, config: string): string => `${date.toISOString().replace(/[^0-9TZ]/g, "-")}-${backend.replace(/[^A-Za-z0-9_-]/g, "-")}-${config.replace(/[^A-Za-z0-9_-]/g, "-")}`;
const emptyCapacity = (): Capacity => ({ users: 0, saturation: false, reasons: ["capacity not evaluated"] });
const atomic = async (path: string, text: string, write: (p: string, t: string) => Promise<void>, move: (a: string, b: string) => Promise<void>) => {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try { await write(tmp, text); await move(tmp, path); } finally { await unlink(tmp).catch(() => undefined); }
};
const serialize = (value: unknown): string => JSON.stringify(value, (_key, v) => typeof v === "number" && !Number.isFinite(v) ? null : v, 2) + "\n";

export async function runBenchmark(options: RunOptions): Promise<{ result: BenchmarkResult; resultPath: string }> {
  if (!options || typeof options.backend !== "string" || !options.backend || !options.config || !options.resultPath || basename(options.resultPath).includes("..") || options.resultPath.includes("\0") || options.resultPath.split(/[\\/]/).includes("..")) throw new Error("invalid benchmark options");
  const d = options.dependencies ?? {};
  const load = d.loadBackend ?? (async name => (await import("./backend.js")).loadBackend(name) as Promise<SetupBackend>);
  const backend = await load(options.backend);
  const write = d.write ?? ((p, text) => writeFile(p, text, { encoding: "utf8", mode: 0o600 }));
  const move = d.rename ?? rename;
  await mkdir(dirname(options.resultPath), { recursive: true });
  const started = (d.now ?? (() => new Date()))();
  const result: BenchmarkResult = { schemaVersion: 1, runId: isoId(started, options.backend, options.config.name), startedAt: started.toISOString(), publishable: options.config.publishable, backend: { name: options.backend as BackendInfo["name"], version: "unknown", endpoint: "unknown" }, dataset: options.config.dataset, seed: options.config.seed, environment: {} as BenchmarkResult["environment"], versions: {}, config: options.config, correctness: { findings: [], aborted: true, abortReason: "not run" }, stages: [], resources: [], capacity: emptyCapacity(), failures: [], valid: false, validityReasons: ["run incomplete"] };
  const save = async () => atomic(options.resultPath, serialize(result), write, move);
  let stopFailure: unknown;
  try {
    const doctor = await backend.doctor(); result.backend = doctor;
    await backend.start();
    result.backend = await backend.doctor();
    result.environment = await (d.captureEnvironment ?? (info => captureEnvironment(info)))(result.backend);
    await backend.reset();
    result.backend = await backend.doctor();
    await backend.seed({ name: options.config.dataset, definition: { ...profileMetadata[options.config.dataset] } }, options.config.seed);
    const fixture = backend.seedCorrectnessFixture ? await backend.seedCorrectnessFixture() : undefined;
    if (!fixture) throw new Error("backend correctness fixture setup unavailable");
    result.correctness = await (d.correctness ?? runCorrectness)(backend, fixture);
    if (result.correctness.aborted || result.correctness.findings.some(f => !f.passed)) throw new Error("correctness checks failed");
    const users = backend.buildVirtualUserSpecs ? await backend.buildVirtualUserSpecs(options.config.dataset, options.config.maxConcurrency, options.config.seed) : [];
    result.backend = await backend.doctor();
    result.environment = await (d.captureEnvironment ?? (info => captureEnvironment(info)))(result.backend);
    result.versions = { backend: result.backend.version, sdk: result.environment.sdkVersion ?? "unknown", runtime: result.environment.runtimeVersion };
    if (options.config.warmupSeconds > 0) {
      const warmup = await (d.workload ?? runWorkload)(backend, options.config, { users: users.slice(0, Math.max(...options.config.concurrency)), durationMs: options.config.warmupSeconds * 1000, graceMs: options.config.timeoutMs, onSample: undefined });
      result.validityReasons = warmup.stageFailed ? ["warmup failed"] : ["warmup writes are unscored"];
      if (warmup.stageFailed) throw new Error("warmup failed");
    }

    if (users.length < options.config.maxConcurrency) throw new Error("backend returned insufficient workload users");
    await save();
    const monotonic = d.monotonic ?? (() => performance.now());
    const resourceFn = d.resources ?? collectResources;
    const workloadFn = d.workload ?? runWorkload;
    const stages = [...options.config.concurrency]; let refined = false;
    for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
      const requestedUsers = stages[stageIndex]!;
      const stageStart = monotonic(); const acc = new StageMetricsAccumulator(); const controller = new AbortController();
      const resourcesPromise = resourceFn({ backend: result.backend, maxSamples: Math.ceil((options.config.stageSeconds * 1000 + options.config.timeoutMs) / 1000) + 2, intervalMs: 1000, signal: controller.signal, shouldStop: () => controller.signal.aborted });
      let summary: WorkloadSummary;
      try { summary = await workloadFn(backend, options.config, { users: users.slice(0, requestedUsers), durationMs: options.config.stageSeconds * 1000, graceMs: options.config.timeoutMs, onSample: s => acc.record(s) }); }
      finally { controller.abort(); }
      const resources = await resourcesPromise;
      const elapsed = (monotonic() - stageStart) / 1000;
      if (!Number.isFinite(elapsed) || elapsed <= 0) throw new Error("invalid monotonic stage elapsed time");
      const stage = acc.finalize(elapsed, { requestedUsers, achievedUsers: summary.startedUsers });
      const reasons = [...stage.validityReasons]; if (summary.stageFailed) reasons.push("workload failed"); if (summary.closeErrors) reasons.push("session close failed"); if (summary.graceExpired) reasons.push("grace period expired"); if (summary.startedUsers < requestedUsers) reasons.push("achieved user count below requested"); if (!resources.valid) reasons.push(...resources.validityReasons); const overload = evaluateRunnerOverload(resources.samples, d.overloadThresholds); if (overload) reasons.push(overload);
      stage.valid = reasons.length === 0; stage.validityReasons = [...new Set(reasons)]; result.stages.push(stage);
      result.resources.push({ name: `stage-${requestedUsers}`, unit: "snapshot", samples: resources.samples.map(() => null), snapshots: resources.samples });
      result.stages.sort((a, b) => a.requestedUsers - b.requestedUsers); result.capacity = mapCapacity(evaluateCapacity(result.stages, options.config, { minSamples: options.config.publishable ? 20 : 1 }));
      if (!stage.valid && !refined && stageIndex > 0) {
        const previous = stages[stageIndex - 1]!;
        const midpoint = Math.floor((previous + requestedUsers) / 2);
        if (midpoint > previous && midpoint < requestedUsers && midpoint <= options.config.maxConcurrency && !stages.includes(midpoint)) { stages.push(midpoint); refined = true; }
      }
      if (stageIndex + 1 === options.config.concurrency.length && stage.valid && requestedUsers < options.config.maxConcurrency) {
        const next = Math.min(options.config.maxConcurrency, requestedUsers * 2);
        if (next > requestedUsers && !stages.includes(next)) stages.push(next);
      }
      await save();
    }
    result.valid = result.correctness.findings.every(f => f.passed) && result.stages.length > 0 && result.stages.every(s => s.valid) && result.capacity.users > 0;
    result.validityReasons = result.valid ? [] : ["one or more benchmark prerequisites failed"];
    await save();
  } catch (error) { result.failures.push(safeError(error)); result.validityReasons = ["benchmark failed"]; await save().catch(() => undefined); throw error; }
  finally { try { await backend.stop(); } catch (error) { stopFailure = error; result.failures.push(safeError(error)); result.valid = false; result.validityReasons.push("backend stop failed"); await save().catch(() => undefined); } }
  if (stopFailure) throw stopFailure;
  return { result, resultPath: options.resultPath };
}
function mapCapacity(value: ReturnType<typeof evaluateCapacity>): Capacity { return { users: value.selectedCapacityUsers, saturation: value.saturation, reasons: value.reasons }; }
