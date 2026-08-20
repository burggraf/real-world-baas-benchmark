import type { BenchmarkResult, OperationClassMetric } from "./result.js";
import type { OperationClass } from "./config.js";
import { stageResourceMaxima, validateBenchmarkResult, type StageResourceMaxima } from "./report.js";

export interface Spread { median: number; min: number; max: number }
export interface AggregationMismatch { runId: string; field: string; expected: string; actual: string }
export class AggregationCompatibilityError extends Error {
  constructor(readonly mismatches: AggregationMismatch[]) { super(`Incompatible benchmark runs: ${mismatches.map(item => `${item.runId} ${item.field}: ${item.expected} != ${item.actual}`).join("; ")}`); this.name = "AggregationCompatibilityError"; }
}
export interface AggregateOptions { override?: boolean; publishable?: boolean }
export interface AggregateOperationClass {
  latencyP50Ms: Spread; latencyP95Ms: Spread; latencyP99Ms: Spread; errorRate: Spread;
}
export interface AggregateResources {
  sampleCount: Spread;
  runnerCpuPercent: Spread | null; runnerRssBytes: Spread | null;
  backendCpuPercent: Spread | null; backendRssBytes: Spread | null;
  eventLoopP99Ms: Spread | null; eventLoopMaxMs: Spread | null;
  supabaseCpuPercent: Spread | null; supabaseMemoryBytes: Spread | null; supabaseBlockReadBytes: Spread | null; supabaseBlockWriteBytes: Spread | null;
}
export interface AggregateStage {
  requestedUsers: number; achievedUsers: Spread; elapsedSeconds: Spread;
  workflowTransactionsPerSecond: Spread; sdkOperationsPerSecond: Spread; readOperationsPerSecond: Spread; writeOperationsPerSecond: Spread;
  operationClasses: Record<OperationClass, AggregateOperationClass>; resources: AggregateResources;
}
export interface MissingAggregateStage { requestedUsers: number; missingRunIds: string[] }
export interface BenchmarkAggregate {
  runCount: number; runIds: string[]; publishable: boolean;
  identity: { backend: string; backendVersion: string; sdkVersion: string | null; config: BenchmarkResult["config"]; settings: BenchmarkResult["settings"]; dataset: string; seed: number; schemaVersion: number; hardware: HardwareIdentity };
  capacityUsers: Spread; stages: AggregateStage[]; missingStages: MissingAggregateStage[]; compatibilityMismatches: AggregationMismatch[];
}
interface HardwareIdentity { cpuModel: string | null; logicalCores: number | null; totalMemoryBytes: number | null; architecture: string; os: string; release: string; hostname: string }
const operationClasses: OperationClass[] = ["read", "write", "authSearch"];

export function medianSpread(values: number[]): Spread {
  if (!values.length || values.some(value => !Number.isFinite(value))) throw new Error("Spread requires finite values");
  const sorted = [...values].sort((left, right) => left - right); const middle = Math.floor(sorted.length / 2);
  return { median: sorted.length % 2 ? sorted[middle]! : sorted[middle - 1]! / 2 + sorted[middle]! / 2, min: sorted[0]!, max: sorted[sorted.length - 1]! };
}
const hardware = (result: BenchmarkResult): HardwareIdentity => ({ cpuModel: result.environment.cpuModel, logicalCores: result.environment.logicalCores, totalMemoryBytes: result.environment.totalMemoryBytes, architecture: result.environment.architecture, os: result.environment.os, release: result.environment.release, hostname: result.environment.hostname });
const canonical = (value: unknown): string => { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); };
const encoded = (value: unknown): string => canonical(value);
function compatibility(results: BenchmarkResult[]): AggregationMismatch[] {
  const first = results[0]!; const checks: Array<[string, (result: BenchmarkResult) => unknown]> = [
    ["backend.name", result => result.backend.name], ["backend.version", result => result.backend.version], ["backend.endpoint", result => result.backend.endpoint], ["backend.supabaseProjectId", result => result.backend.supabaseProjectId], ["backend.deviations", result => result.backend.deviations],
    ["environment.sdkVersion", result => result.environment.sdkVersion], ["environment.npmVersion", result => result.environment.npmVersion], ["environment.dockerVersion", result => result.environment.dockerVersion], ["environment.supabaseVersion", result => result.environment.supabaseVersion],
    ["config", result => result.config], ["settings", result => result.settings], ["dataset", result => result.dataset], ["seed", result => result.seed], ["schemaVersion", result => result.schemaVersion], ["hardware", hardware],
  ];
  return results.slice(1).flatMap(result => checks.flatMap(([field, get]) => encoded(get(result)) === encoded(get(first)) ? [] : [{ runId: String(result.runId), field, expected: encoded(get(first)), actual: encoded(get(result)) }]));
}
const nullableSpread = (values: Array<number | null>): Spread | null => values.every((value): value is number => value !== null) ? medianSpread(values) : null;
const aggregateClass = (metrics: OperationClassMetric[]): AggregateOperationClass => ({ latencyP50Ms: medianSpread(metrics.map(metric => metric.latencyP50Ms)), latencyP95Ms: medianSpread(metrics.map(metric => metric.latencyP95Ms)), latencyP99Ms: medianSpread(metrics.map(metric => metric.latencyP99Ms)), errorRate: medianSpread(metrics.map(metric => metric.errorRate)) });
const aggregateResources = (values: StageResourceMaxima[]): AggregateResources => ({
  sampleCount: medianSpread(values.map(value => value.sampleCount)),
  runnerCpuPercent: nullableSpread(values.map(value => value.runnerCpuPercent)), runnerRssBytes: nullableSpread(values.map(value => value.runnerRssBytes)),
  backendCpuPercent: nullableSpread(values.map(value => value.backendCpuPercent)), backendRssBytes: nullableSpread(values.map(value => value.backendRssBytes)),
  eventLoopP99Ms: nullableSpread(values.map(value => value.eventLoopP99Ms)), eventLoopMaxMs: nullableSpread(values.map(value => value.eventLoopMaxMs)),
  supabaseCpuPercent: nullableSpread(values.map(value => value.supabaseCpuPercent)), supabaseMemoryBytes: nullableSpread(values.map(value => value.supabaseMemoryBytes)),
  supabaseBlockReadBytes: nullableSpread(values.map(value => value.supabaseBlockReadBytes)), supabaseBlockWriteBytes: nullableSpread(values.map(value => value.supabaseBlockWriteBytes)),
});

export function aggregateBenchmarkResults(results: BenchmarkResult[], options: AggregateOptions = {}): BenchmarkAggregate {
  if (!Array.isArray(results) || results.length < 3) throw new Error("Aggregation requires at least 3 repeated runs");
  for (const result of results) {
    if (!result.valid) throw new Error(`Run ${result.runId} is not valid: ${result.validityReasons.join("; ") || "no reason recorded"}`);
    if ((options.publishable ?? true) && !result.publishable) throw new Error(`Run ${result.runId} is not publishable`);
  }
  const mismatches = compatibility(results); const crossBackend = mismatches.filter(item => item.field === "backend.name");
  if (crossBackend.length) throw new AggregationCompatibilityError(crossBackend);
  if (mismatches.length && !options.override) throw new AggregationCompatibilityError(mismatches);
  if (!options.override && results.some(result => result.schemaVersion !== 1)) throw new Error("Aggregation requires schemaVersion 1");
  for (const result of results) validateBenchmarkResult(result.schemaVersion === 1 ? result : { ...result, schemaVersion: 1 });
  for (const result of results) {
    if (new Set(result.stages.map(stage => stage.requestedUsers)).size !== result.stages.length) throw new Error(`Run ${result.runId} has duplicate requested-user stages`);
  }
  const requestedUsers = [...new Set(results.flatMap(result => result.stages.map(stage => stage.requestedUsers)))].sort((left, right) => left - right);
  const common = requestedUsers.filter(users => results.every(result => result.stages.some(stage => stage.requestedUsers === users)));
  const missingStages = requestedUsers.flatMap(users => { const missingRunIds = results.filter(result => !result.stages.some(stage => stage.requestedUsers === users)).map(result => result.runId); return missingRunIds.length ? [{ requestedUsers: users, missingRunIds }] : []; });
  const stages = common.map(requestedUsersAtStage => {
    const perRun = results.map(result => result.stages.find(stage => stage.requestedUsers === requestedUsersAtStage)!);
    return {
      requestedUsers: requestedUsersAtStage,
      achievedUsers: medianSpread(perRun.map(stage => stage.achievedUsers)), elapsedSeconds: medianSpread(perRun.map(stage => stage.elapsedSeconds)),
      workflowTransactionsPerSecond: medianSpread(perRun.map(stage => stage.workflowTransactionsPerSecond)), sdkOperationsPerSecond: medianSpread(perRun.map(stage => stage.sdkOperationsPerSecond)),
      readOperationsPerSecond: medianSpread(perRun.map(stage => stage.readOperationsPerSecond)), writeOperationsPerSecond: medianSpread(perRun.map(stage => stage.writeOperationsPerSecond)),
      operationClasses: Object.fromEntries(operationClasses.map(name => [name, aggregateClass(perRun.map(stage => stage.operationClassMetrics[name]))])) as Record<OperationClass, AggregateOperationClass>,
      resources: aggregateResources(results.map(result => stageResourceMaxima(result, requestedUsersAtStage))),
    };
  });
  const first = results[0]!;
  return {
    runCount: results.length, runIds: results.map(result => result.runId), publishable: options.publishable ?? true,
    identity: { backend: first.backend.name, backendVersion: first.backend.version, sdkVersion: first.environment.sdkVersion, config: structuredClone(first.config), settings: structuredClone(first.settings), dataset: first.dataset, seed: first.seed, schemaVersion: first.schemaVersion, hardware: hardware(first) },
    capacityUsers: medianSpread(results.map(result => result.capacity.users)), stages, missingStages, compatibilityMismatches: mismatches,
  };
}

export function aggregateBenchmarkResultsByBackend(results: BenchmarkResult[], options: AggregateOptions = {}): Record<string, BenchmarkAggregate> {
  const groups = new Map<string, BenchmarkResult[]>();
  for (const result of results) groups.set(result.backend.name, [...(groups.get(result.backend.name) ?? []), result]);
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([backend, runs]) => [backend, aggregateBenchmarkResults(runs, options)]));
}
