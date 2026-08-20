import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, basename } from "node:path";
import type { Backend, BackendInfo } from "./backend.js";
import type { BenchmarkConfig } from "./config.js";
import { captureEnvironment, collectResources, evaluateRunnerOverload, type ResourceCollection, type ResourceSnapshot } from "./system.js";
import { runCorrectness, type CorrectnessFixture } from "./correctness.js";
import { StageMetricsAccumulator } from "./metrics.js";
import { evaluateCapacity } from "./capacity.js";
import { runWorkload, type VirtualUserSpec, type WorkloadSummary } from "./workload.js";
import type { BenchmarkResult, Capacity, Correctness, StageMetrics } from "./result.js";
import { profileMetadata, seedDataset, entityId } from "./seed.js";

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
}
export interface RunOptions { backend: string; config: BenchmarkConfig; resultPath: string; dependencies?: RunDependencies; }

/** Deterministic setup-only user assignment shared by adapters. */
export async function buildSeedVirtualUserSpecs(profile: BenchmarkConfig["dataset"], count: number, seed: number, email: (id: string, canonical: string) => string, password: string): Promise<VirtualUserSpec[]> {
  if (!Number.isSafeInteger(count) || count < 1 || count > profileMetadata[profile].users) throw new RangeError("requested users exceed seeded profile");
  const users: Array<{ id: string; email: string }> = [];
  for await (const batch of seedDataset(profile, seed, Math.max(1000, count))) {
    if (batch.entity !== "user") continue;
    for (const value of batch.records.slice(0, count) as Array<{ id: string; email: string }>) users.push(value);
    if (users.length >= count) break;
  }
  return users.map((user, i) => ({ credentials: { email: email(user.id, user.email), password }, organizationId: entityId("organization", profile, i % profileMetadata[profile].organizations), projectId: entityId("project", profile, i % profileMetadata[profile].projects), taskId: entityId("task", profile, i % profileMetadata[profile].tasks) }));
}

const safeError = (e: unknown): string => {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/(password|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]").slice(0, 300);
};
const isoId = (date: Date, backend: string, config: string): string => `${date.toISOString().replace(/[^0-9TZ]/g, "-")}-${backend.replace(/[^A-Za-z0-9_-]/g, "-")}-${config.replace(/[^A-Za-z0-9_-]/g, "-")}`;
const emptyCapacity = (): Capacity => ({ users: 0, saturation: false, reasons: ["capacity not evaluated"] });
const atomic = async (path: string, text: string, write: (p: string, t: string) => Promise<void>, move: (a: string, b: string) => Promise<void>) => {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await write(tmp, text); await move(tmp, path);
};
const serialize = (value: unknown): string => JSON.stringify(value, (_key, v) => typeof v === "number" && !Number.isFinite(v) ? null : v, 2) + "\n";

export async function runBenchmark(options: RunOptions): Promise<{ result: BenchmarkResult; resultPath: string }> {
  if (!options || typeof options.backend !== "string" || !options.backend || !options.config || !options.resultPath || basename(options.resultPath).includes("..") || options.resultPath.includes("\0")) throw new Error("invalid benchmark options");
  const d = options.dependencies ?? {};
  const load = d.loadBackend ?? (async name => (await import("./backend.js")).loadBackend(name) as Promise<SetupBackend>);
  const backend = await load(options.backend);
  const write = d.write ?? ((p, text) => writeFile(p, text, { encoding: "utf8", mode: 0o600 }));
  const move = d.rename ?? rename;
  await mkdir(dirname(options.resultPath), { recursive: true });
  const started = (d.now ?? (() => new Date()))();
  const result: BenchmarkResult = { schemaVersion: 1, runId: isoId(started, options.backend, options.config.name), startedAt: started.toISOString(), publishable: options.config.publishable, backend: { name: options.backend as BackendInfo["name"], version: "unknown", endpoint: "unknown" }, dataset: options.config.dataset, seed: options.config.seed, environment: {} as BenchmarkResult["environment"], versions: {}, config: options.config, correctness: { findings: [], aborted: true, abortReason: "not run" }, stages: [], resources: [], capacity: emptyCapacity(), failures: [], valid: false, validityReasons: ["run incomplete"] };
  const save = async () => atomic(options.resultPath, serialize(result), write, move);
  let stopped = false;
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
    const stages = [...options.config.concurrency];
    while (stages.length && stages[stages.length - 1]! < options.config.maxConcurrency && stages.length < options.config.concurrency.length + 32) {
      const n = Math.min(options.config.maxConcurrency, stages[stages.length - 1]! * 2); if (n === stages[stages.length - 1]) break; stages.push(n);
      if (stages.length >= options.config.concurrency.length + 32) break;
    }
    for (const requestedUsers of stages) {
      const stageStart = monotonic(); const acc = new StageMetricsAccumulator(); const controller = new AbortController();
      const resourcesPromise = resourceFn({ backend: result.backend, maxSamples: Math.ceil((options.config.stageSeconds * 1000 + options.config.timeoutMs) / 1000) + 2, intervalMs: 1000, signal: controller.signal, shouldStop: () => controller.signal.aborted });
      let summary: WorkloadSummary;
      try { summary = await workloadFn(backend, options.config, { users: users.slice(0, requestedUsers), durationMs: options.config.stageSeconds * 1000, graceMs: options.config.timeoutMs, onSample: s => acc.record(s) }); }
      finally { controller.abort(); }
      const resources = await resourcesPromise;
      const elapsed = Math.max(0.001, (monotonic() - stageStart) / 1000);
      const stage = acc.finalize(elapsed, { requestedUsers, achievedUsers: summary.startedUsers });
      const reasons = [...stage.validityReasons]; if (summary.graceExpired) reasons.push("grace period expired"); if (summary.startedUsers < requestedUsers) reasons.push("achieved user count below requested"); if (!resources.valid) reasons.push(...resources.validityReasons); const overload = evaluateRunnerOverload(resources.samples); if (overload) reasons.push(overload);
      stage.valid = reasons.length === 0; stage.validityReasons = [...new Set(reasons)]; result.stages.push(stage);
      result.resources.push({ name: `stage-${requestedUsers}`, unit: "snapshot", samples: resources.samples.map(() => null), snapshots: resources.samples });
      result.stages.sort((a, b) => a.requestedUsers - b.requestedUsers); result.capacity = mapCapacity(evaluateCapacity(result.stages, options.config, { minSamples: options.config.publishable ? 20 : 1 }));
      await save();
    }
    result.valid = result.correctness.findings.every(f => f.passed) && result.stages.length > 0 && result.stages.every(s => s.valid) && result.capacity.users > 0;
    result.validityReasons = result.valid ? [] : ["one or more benchmark prerequisites failed"];
  } catch (error) { result.failures.push(safeError(error)); result.validityReasons = ["benchmark failed"]; await save().catch(() => undefined); throw error; }
  finally { try { await backend.stop(); stopped = true; } catch (error) { result.failures.push(safeError(error)); result.valid = false; result.validityReasons.push("backend stop failed"); await save().catch(() => undefined); } }
  return { result, resultPath: options.resultPath };
}
function mapCapacity(value: ReturnType<typeof evaluateCapacity>): Capacity { return { users: value.selectedCapacityUsers, saturation: value.saturation, reasons: value.reasons }; }
