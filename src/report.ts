import { link, lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { parseConfig } from "./config.js";
import type { OperationClass } from "./config.js";
import type { BenchmarkResult, OperationClassMetric, StageMetrics } from "./result.js";

export interface BenchmarkReport { markdown: string; csv: string }
export interface WrittenBenchmarkReport { markdownPath: string; csvPath: string }
export interface WriteReportOptions { overwrite?: boolean }

const classes: OperationClass[] = ["read", "write", "authSearch"];
type RecordValue = Record<string, unknown>;

function object(value: unknown, label: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}: expected object`);
  return value as RecordValue;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}: expected string`);
  return value;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid ${label}: expected boolean`);
  return value;
}
function finite(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) throw new Error(`Invalid ${label}: expected finite number >= ${minimum}`);
  return value;
}
function integer(value: unknown, label: string, minimum = 0): number {
  const number = finite(value, label, minimum);
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid ${label}: expected safe integer`);
  return number;
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}: expected array`);
  return value.map((item, index) => string(item, `${label}[${index}]`));
}
function nullableFinite(value: unknown, label: string): number | null {
  return value === null ? null : finite(value, label);
}
function assertFiniteTree(value: unknown, label = "result", seen = new WeakSet<object>()): void {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`Invalid ${label}: expected finite number`);
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new Error(`Invalid ${label}: cyclic value`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) assertFiniteTree(child, `${label}.${key}`, seen);
  seen.delete(value);
}
function validateBackend(value: unknown, label: string): void {
  const raw = object(value, label);
  const name = string(raw.name, `${label}.name`);
  if (!new Set(["pocketbase", "supabase", "trailbase"]).has(name)) throw new Error(`Invalid ${label}.name`);
  string(raw.version, `${label}.version`); string(raw.endpoint, `${label}.endpoint`);
  if (raw.processIds !== undefined) {
    if (!Array.isArray(raw.processIds)) throw new Error(`Invalid ${label}.processIds`);
    raw.processIds.forEach((pid, index) => integer(pid, `${label}.processIds[${index}]`, 1));
  }
  if (raw.processExecutable !== undefined) string(raw.processExecutable, `${label}.processExecutable`);
  if (raw.supabaseProjectId !== undefined) string(raw.supabaseProjectId, `${label}.supabaseProjectId`);
  if (raw.deviations !== undefined) strings(raw.deviations, `${label}.deviations`);
}
function validateClassMetric(value: unknown, label: string): void {
  const raw = object(value, label);
  for (const key of ["attempted", "completed", "failed"] as const) integer(raw[key], `${label}.${key}`);
  finite(raw.errorRate, `${label}.errorRate`);
  if ((raw.errorRate as number) > 1) throw new Error(`Invalid ${label}.errorRate`);
  for (const key of ["latencyP50Ms", "latencyP95Ms", "latencyP99Ms", "latencyMinMs", "latencyMaxMs"] as const) finite(raw[key], `${label}.${key}`);
}
function validateSnapshot(value: unknown, label: string): void {
  const raw = object(value, label); finite(raw.timestampMs, `${label}.timestampMs`);
  const runner = object(raw.runner, `${label}.runner`); integer(runner.pid, `${label}.runner.pid`, 1); nullableFinite(runner.cpuPercent, `${label}.runner.cpuPercent`); nullableFinite(runner.rssBytes, `${label}.runner.rssBytes`); if (runner.reason !== undefined) string(runner.reason, `${label}.runner.reason`);
  const backend = object(raw.backend, `${label}.backend`); nullableFinite(backend.totalCpuPercent, `${label}.backend.totalCpuPercent`); nullableFinite(backend.totalRssBytes, `${label}.backend.totalRssBytes`); if (!Array.isArray(backend.processes)) throw new Error(`Invalid ${label}.backend.processes`); if (backend.reason !== undefined) string(backend.reason, `${label}.backend.reason`);
  for (const [index, process] of backend.processes.entries()) { const item = object(process, `${label}.backend.processes[${index}]`); integer(item.pid, `${label}.backend.processes[${index}].pid`, 1); nullableFinite(item.cpuPercent, `${label}.backend.processes[${index}].cpuPercent`); nullableFinite(item.rssBytes, `${label}.backend.processes[${index}].rssBytes`); if (item.reason !== undefined) string(item.reason, `${label}.backend.processes[${index}].reason`); }
  if (raw.containers !== null) {
    if (!Array.isArray(raw.containers)) throw new Error(`Invalid ${label}.containers`);
    for (const [index, container] of raw.containers.entries()) { const item = object(container, `${label}.containers[${index}]`); string(item.containerId, `${label}.containers[${index}].containerId`); for (const key of ["cpuPercent", "memoryBytes", "blockReadBytes", "blockWriteBytes"] as const) finite(item[key], `${label}.containers[${index}].${key}`); }
  }
  if (raw.containerTotals !== null) { const totals = object(raw.containerTotals, `${label}.containerTotals`); for (const key of ["cpuPercent", "memoryBytes", "blockReadBytes", "blockWriteBytes"] as const) nullableFinite(totals[key], `${label}.containerTotals.${key}`); }
  if (raw.containerReason !== undefined) string(raw.containerReason, `${label}.containerReason`);
  const eventLoop = object(raw.eventLoop, `${label}.eventLoop`); nullableFinite(eventLoop.p99Ms, `${label}.eventLoop.p99Ms`); nullableFinite(eventLoop.maxMs, `${label}.eventLoop.maxMs`); if (eventLoop.reason !== undefined) string(eventLoop.reason, `${label}.eventLoop.reason`);
}
function validateStage(value: unknown, index: number): void {
  const label = `stages[${index}]`; const raw = object(value, label);
  integer(raw.requestedUsers, `${label}.requestedUsers`, 1); integer(raw.achievedUsers, `${label}.achievedUsers`); finite(raw.elapsedSeconds, `${label}.elapsedSeconds`, Number.MIN_VALUE);
  for (const key of ["workflowTransactionsPerSecond", "sdkOperationsPerSecond", "readOperationsPerSecond", "writeOperationsPerSecond"] as const) finite(raw[key], `${label}.${key}`);
  const workflowRates = object(raw.workflowTransactionsPerSecondByName, `${label}.workflowTransactionsPerSecondByName`); for (const [name, rate] of Object.entries(workflowRates)) finite(rate, `${label}.workflowTransactionsPerSecondByName.${name}`);
  if (raw.workflowCompletionCountByName !== undefined) { const completions = object(raw.workflowCompletionCountByName, `${label}.workflowCompletionCountByName`); for (const [name, count] of Object.entries(completions)) integer(count, `${label}.workflowCompletionCountByName.${name}`); }
  const classMetrics = object(raw.operationClassMetrics, `${label}.operationClassMetrics`); for (const operationClass of classes) validateClassMetric(classMetrics[operationClass], `${label}.operationClassMetrics.${operationClass}`);
  const operations = object(raw.operations, `${label}.operations`);
  for (const [name, operation] of Object.entries(operations)) {
    const item = object(operation, `${label}.operations.${name}`);
    for (const key of ["operationCount", "errorCount", "attemptedCount", "completedCount", "failedCount"] as const) integer(item[key], `${label}.operations.${name}.${key}`);
    for (const key of ["latencyP50Ms", "latencyP95Ms", "latencyP99Ms", "latencyMinMs", "latencyMaxMs", "throughputPerSecond"] as const) finite(item[key], `${label}.operations.${name}.${key}`);
    const errorRate = finite(item.errorRate, `${label}.operations.${name}.errorRate`); if (errorRate > 1) throw new Error(`Invalid ${label}.operations.${name}.errorRate`); if (item.successRate !== undefined && finite(item.successRate, `${label}.operations.${name}.successRate`) > 1) throw new Error(`Invalid ${label}.operations.${name}.successRate`);
    for (const key of ["type", "name", "workflow", "operationClass", "kind"] as const) string(item[key], `${label}.operations.${name}.${key}`);
    const counts = object(item.errorCounts, `${label}.operations.${name}.errorCounts`); for (const [key, count] of Object.entries(counts)) integer(count, `${label}.operations.${name}.errorCounts.${key}`);
  }
  if (!Array.isArray(raw.errorExamples)) throw new Error(`Invalid ${label}.errorExamples`);
  for (const [errorIndex, example] of raw.errorExamples.entries()) { const item = object(example, `${label}.errorExamples[${errorIndex}]`); for (const key of ["type", "name", "workflow", "operationClass", "kind", "classification", "nameOfError", "message"] as const) string(item[key], `${label}.errorExamples[${errorIndex}].${key}`); integer(item.occurrences, `${label}.errorExamples[${errorIndex}].occurrences`, 1); }
  boolean(raw.valid, `${label}.valid`); strings(raw.validityReasons, `${label}.validityReasons`);
}

export function validateBenchmarkResult(value: unknown): asserts value is BenchmarkResult {
  assertFiniteTree(value);
  const raw = object(value, "result");
  if (raw.schemaVersion !== 1) throw new Error("Invalid schemaVersion: expected 1");
  string(raw.runId, "runId"); const startedAt = string(raw.startedAt, "startedAt"); if (!Number.isFinite(Date.parse(startedAt))) throw new Error("Invalid startedAt");
  boolean(raw.publishable, "publishable"); validateBackend(raw.backend, "backend"); const backend = raw.backend as RecordValue;
  const dataset = string(raw.dataset, "dataset"); if (!new Set(["small", "medium", "large"]).has(dataset)) throw new Error("Invalid dataset");
  integer(raw.seed, "seed"); const config = parseConfig(raw.config); if (config.dataset !== dataset || config.seed !== raw.seed || config.publishable !== raw.publishable) throw new Error("Invalid result/config identity mismatch");
  const environment = object(raw.environment, "environment");
  for (const key of ["runtime", "runtimeVersion", "os", "architecture", "host", "release", "hostname", "nodeVersion"] as const) string(environment[key], `environment.${key}`);
  for (const key of ["cpu", "cpuModel"] as const) if (environment[key] !== null) string(environment[key], `environment.${key}`);
  for (const key of ["memoryBytes", "logicalCores", "totalMemoryBytes"] as const) nullableFinite(environment[key], `environment.${key}`);
  for (const key of ["npmVersion", "gitCommit", "sdkVersion", "dockerVersion", "supabaseVersion"] as const) if (environment[key] !== null) string(environment[key], `environment.${key}`);
  if (environment.gitDirty !== null) boolean(environment.gitDirty, "environment.gitDirty"); validateBackend(environment.backend, "environment.backend"); const environmentBackend = environment.backend as RecordValue; if (environmentBackend.name !== backend.name || environmentBackend.version !== backend.version) throw new Error("Invalid environment/backend identity mismatch"); const unavailable = object(environment.unavailable, "environment.unavailable"); for (const [key, reason] of Object.entries(unavailable)) string(reason, `environment.unavailable.${key}`);
  const versions = object(raw.versions, "versions"); for (const [key, version] of Object.entries(versions)) string(version, `versions.${key}`);
  const settings = object(raw.settings, "settings"); integer(settings.warmupUserCount, "settings.warmupUserCount"); if (settings.warmupWritesUnscored !== true) throw new Error("Invalid settings.warmupWritesUnscored");
  for (const key of ["resourceIntervalMs", "minClassSamples", "minAchievedRatio", "saturationMaterialIncrease", "saturationMaxThroughputGain", "maxLatencySamples", "maxErrorExamples"] as const) finite(settings[key], `settings.${key}`);
  const maxSamples = object(settings.resourceMaxSamples, "settings.resourceMaxSamples"); for (const key of ["stageDurationMs", "graceMs", "value"] as const) finite(maxSamples[key], `settings.resourceMaxSamples.${key}`); string(maxSamples.formula, "settings.resourceMaxSamples.formula");
  const overload = object(settings.overloadThresholds, "settings.overloadThresholds"); for (const key of ["cpuPercent", "p99Ms", "maxMs", "consecutiveSamples"] as const) finite(overload[key], `settings.overloadThresholds.${key}`);
  const correctness = object(raw.correctness, "correctness"); if (!Array.isArray(correctness.findings)) throw new Error("Invalid correctness.findings");
  for (const [index, finding] of correctness.findings.entries()) { const item = object(finding, `correctness.findings[${index}]`); string(item.name, `correctness.findings[${index}].name`); boolean(item.passed, `correctness.findings[${index}].passed`); string(item.classification, `correctness.findings[${index}].classification`); if (item.message !== undefined) string(item.message, `correctness.findings[${index}].message`); if (item.evidence !== undefined) string(item.evidence, `correctness.findings[${index}].evidence`); }
  if (correctness.aborted !== undefined) boolean(correctness.aborted, "correctness.aborted"); if (correctness.abortReason !== undefined) string(correctness.abortReason, "correctness.abortReason");
  if (!Array.isArray(raw.stages)) throw new Error("Invalid stages"); raw.stages.forEach(validateStage);
  if (!Array.isArray(raw.resources)) throw new Error("Invalid resources");
  const resourceNames = new Set<string>();
  for (const [index, resource] of raw.resources.entries()) { const item = object(resource, `resources[${index}]`); const name = string(item.name, `resources[${index}].name`); if (resourceNames.has(name)) throw new Error(`Invalid resources[${index}].name: duplicate`); resourceNames.add(name); string(item.unit, `resources[${index}].unit`); if (!Array.isArray(item.samples)) throw new Error(`Invalid resources[${index}].samples`); item.samples.forEach((sample, sampleIndex) => nullableFinite(sample, `resources[${index}].samples[${sampleIndex}]`)); if (item.reasons !== undefined) { if (!Array.isArray(item.reasons)) throw new Error(`Invalid resources[${index}].reasons`); item.reasons.forEach((reason, reasonIndex) => { if (reason !== null) string(reason, `resources[${index}].reasons[${reasonIndex}]`); }); } if (item.reason !== undefined) string(item.reason, `resources[${index}].reason`); if (item.snapshots !== undefined) { if (!Array.isArray(item.snapshots)) throw new Error(`Invalid resources[${index}].snapshots`); item.snapshots.forEach((snapshot, snapshotIndex) => validateSnapshot(snapshot, `resources[${index}].snapshots[${snapshotIndex}]`)); } }
  const capacity = object(raw.capacity, "capacity"); integer(capacity.users, "capacity.users"); boolean(capacity.saturation, "capacity.saturation"); strings(capacity.reasons, "capacity.reasons");
  strings(raw.failures, "failures"); boolean(raw.valid, "valid"); strings(raw.validityReasons, "validityReasons");
}

const freeText = (value: string): string => value
  .replace(/([?&](?:password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization)=)[^&#\s]*/gi, "$1[REDACTED]")
  .replace(/(["']?authorization["']?)\s*[:=]\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^,;}\r\n]*)/gi, "$1=[REDACTED]")
  .replace(/\b(Bearer|Basic)\s+[^\s,;}]+/gi, "$1 [REDACTED]")
  .replace(/(["']?)(password|passwd|secret|token|api[_-]?key|access[_-]?key)\1\s*[:=]\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;&}]+)/gi, "$2=[REDACTED]")
  .replace(/\b([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\b/g, (match, first: string, second: string, third: string) => [first, second, third].every(part => /^v?\d+$/.test(part)) ? match : "[REDACTED]")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
  .slice(0, 300);
const mdCell = (value: unknown): string => freeText(String(value)).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
const markdownTable = (headers: string[], rows: unknown[][]): string => [
  `| ${headers.map(mdCell).join(" | ")} |`,
  `| ${headers.map(() => "---").join(" | ")} |`,
  ...rows.map(row => `| ${row.map(mdCell).join(" | ")} |`),
].join("\n");
const sectionRows = (values: string[], empty = "None"): unknown[][] => values.length ? values.map(value => [value]) : [[empty]];
const number = (value: number): string => String(value);
const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;
const available = (value: string | number | boolean | null, reason?: string): string => value === null ? `unavailable${reason ? ` (${reason})` : ""}` : typeof value === "boolean" ? value ? "yes" : "no" : String(value);
const csvField = (value: unknown): string => { const text = freeText(String(value)); return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
const csvRow = (values: unknown[]): string => values.map(csvField).join(",");

export interface StageResourceMaxima {
  sampleCount: number;
  runnerCpuPercent: number | null; runnerRssBytes: number | null;
  backendCpuPercent: number | null; backendRssBytes: number | null;
  eventLoopP99Ms: number | null; eventLoopMaxMs: number | null;
  supabaseCpuPercent: number | null; supabaseMemoryBytes: number | null; supabaseBlockReadBytes: number | null; supabaseBlockWriteBytes: number | null;
  unavailableReasons: string[];
}
const maximum = (values: Array<number | null>): number | null => values.reduce<number | null>((highest, value) => value === null ? highest : highest === null ? value : Math.max(highest, value), null);
export function stageResourceMaxima(result: BenchmarkResult, requestedUsers: number): StageResourceMaxima {
  const resource = result.resources.find(item => item.name === `stage-${requestedUsers}`); const snapshots = resource?.snapshots ?? [];
  const reasons = new Set<string>(); if (!resource) reasons.add("stage resource record unavailable"); else if (!snapshots.length) reasons.add(resource.reason ?? "resource snapshots unavailable"); if (resource?.reason) reasons.add(resource.reason); for (const reason of resource?.reasons ?? []) if (reason) reasons.add(reason);
  for (const snapshot of snapshots) { if (snapshot.runner.reason) reasons.add(snapshot.runner.reason); if (snapshot.backend.reason) reasons.add(snapshot.backend.reason); if (snapshot.containerReason) reasons.add(snapshot.containerReason); if (snapshot.eventLoop.reason) reasons.add(snapshot.eventLoop.reason); }
  return {
    sampleCount: snapshots.length || resource?.samples.length || 0,
    runnerCpuPercent: maximum(snapshots.map(snapshot => snapshot.runner.cpuPercent)), runnerRssBytes: maximum(snapshots.map(snapshot => snapshot.runner.rssBytes)),
    backendCpuPercent: maximum(snapshots.map(snapshot => snapshot.backend.totalCpuPercent)), backendRssBytes: maximum(snapshots.map(snapshot => snapshot.backend.totalRssBytes)),
    eventLoopP99Ms: maximum(snapshots.map(snapshot => snapshot.eventLoop.p99Ms)), eventLoopMaxMs: maximum(snapshots.map(snapshot => snapshot.eventLoop.maxMs)),
    supabaseCpuPercent: maximum(snapshots.map(snapshot => snapshot.containerTotals?.cpuPercent ?? null)), supabaseMemoryBytes: maximum(snapshots.map(snapshot => snapshot.containerTotals?.memoryBytes ?? null)),
    supabaseBlockReadBytes: maximum(snapshots.map(snapshot => snapshot.containerTotals?.blockReadBytes ?? null)), supabaseBlockWriteBytes: maximum(snapshots.map(snapshot => snapshot.containerTotals?.blockWriteBytes ?? null)),
    unavailableReasons: [...reasons],
  };
}
const slo = (metric: OperationClassMetric, target: { p95Ms: number; maxErrorRate: number }): string => `${metric.latencyP95Ms <= target.p95Ms && metric.errorRate <= target.maxErrorRate ? "PASS" : "FAIL"} (p95 <= ${number(target.p95Ms)} ms; errors <= ${percent(target.maxErrorRate)})`;
const metricCells = (metric: OperationClassMetric, target: { p95Ms: number; maxErrorRate: number }): unknown[] => [metric.attempted, number(metric.latencyP50Ms), number(metric.latencyP95Ms), number(metric.latencyP99Ms), percent(metric.errorRate), slo(metric, target)];
const csvMetricCells = (metric: OperationClassMetric, target: { p95Ms: number; maxErrorRate: number }): unknown[] => [metric.attempted, number(metric.latencyP50Ms), number(metric.latencyP95Ms), number(metric.latencyP99Ms), number(metric.errorRate), slo(metric, target)];
const resourceValue = (value: number | null): string => value === null ? "unavailable" : number(value);
const stageErrors = (examples: StageMetrics["errorExamples"], total: number): string => `${examples.map(example => `${example.classification}: ${example.nameOfError}: ${example.message} (${example.occurrences})`).join("; ") || "none"}${total > examples.length ? `; showing ${examples.length} of ${total}` : ""}`;

export function createBenchmarkReport(result: BenchmarkResult, rawJsonPath: string): BenchmarkReport {
  validateBenchmarkResult(result);
  if (typeof rawJsonPath !== "string" || rawJsonPath.includes("\0") || extname(rawJsonPath).toLowerCase() !== ".json") throw new Error("Invalid raw JSON path");
  const environment = result.environment; const unavailable = environment.unavailable; const passed = result.correctness.findings.filter(finding => finding.passed).length; const failed = result.correctness.findings.length - passed;
  const stageHeaders = ["Requested users", "Achieved users", "Elapsed (s)", "Workflow TPS", "SDK TPS", "Read SDK/s", "Write SDK/s", ...classes.flatMap(name => { const title = name === "authSearch" ? "Auth/search" : name[0]!.toUpperCase() + name.slice(1); return [`${title} attempts`, `${title} p50 (ms)`, `${title} p95 (ms)`, `${title} p99 (ms)`, `${title} error rate`, `${title} SLO`]; }), "Valid", "Validity reasons"];
  const stageRows = result.stages.map(stage => [stage.requestedUsers, stage.achievedUsers, number(stage.elapsedSeconds), number(stage.workflowTransactionsPerSecond), number(stage.sdkOperationsPerSecond), number(stage.readOperationsPerSecond), number(stage.writeOperationsPerSecond), ...classes.flatMap(name => metricCells(stage.operationClassMetrics[name], result.config.slos[name])), stage.valid ? "yes" : "no", stage.validityReasons.join("; ") || "none"]);
  const resourceHeaders = ["Requested users", "Resource samples", "Runner CPU max (%)", "Runner RSS max (bytes)", "Backend CPU max (%)", "Backend RSS max (bytes)", "Event-loop p99 max (ms)", "Event-loop max (ms)", "Supabase CPU max (%)", "Supabase memory max (bytes)", "Supabase block read max (bytes)", "Supabase block write max (bytes)", "Unavailable reasons"];
  const resources = result.stages.map(stage => stageResourceMaxima(result, stage.requestedUsers));
  const resourceRows = result.stages.map((stage, index) => { const value = resources[index]!; return [stage.requestedUsers, value.sampleCount, resourceValue(value.runnerCpuPercent), resourceValue(value.runnerRssBytes), resourceValue(value.backendCpuPercent), resourceValue(value.backendRssBytes), resourceValue(value.eventLoopP99Ms), resourceValue(value.eventLoopMaxMs), resourceValue(value.supabaseCpuPercent), resourceValue(value.supabaseMemoryBytes), resourceValue(value.supabaseBlockReadBytes), resourceValue(value.supabaseBlockWriteBytes), value.unavailableReasons.join("; ") || "none"]; });
  const totalExamples = result.stages.reduce((total, stage) => total + stage.errorExamples.length, 0); const shownExamples: unknown[][] = []; const csvExamples = new Map<StageMetrics, StageMetrics["errorExamples"]>(); let remainingExamples = 20;
  for (const stage of result.stages) { const selected = stage.errorExamples.slice(0, remainingExamples); csvExamples.set(stage, selected); remainingExamples -= selected.length; shownExamples.push(...selected.map(example => [stage.requestedUsers, example.type, example.name, example.operationClass, example.classification, example.nameOfError, example.message, example.occurrences])); }
  const rawName = freeText(basename(rawJsonPath)); const rawTarget = `./${encodeURIComponent(rawName).replace(/%2F/gi, "/")}`;
  const markdown = [
    `# ${result.valid ? "VALID" : "INVALID"} benchmark result`, "",
    "## Run", "", markdownTable(["Field", "Value"], [["Backend", result.backend.name], ["Backend version", result.backend.version], ["Config", result.config.name], ["Dataset", result.dataset], ["Seed", result.seed], ["Publishable", result.publishable ? "yes" : "no"], ["Run ID", result.runId], ["Started at", result.startedAt]]), "",
    "## Validity", "", markdownTable(["Validity reasons"], sectionRows(result.validityReasons)), "", markdownTable(["Failures"], sectionRows(result.failures)), "",
    "## Environment", "", markdownTable(["Field", "Value"], [["CPU model", available(environment.cpuModel, unavailable.cpuModel)], ["Logical cores", available(environment.logicalCores, unavailable.logicalCores)], ["Total memory (bytes)", available(environment.totalMemoryBytes, unavailable.totalMemoryBytes)], ["OS", `${environment.os} ${environment.release} (${environment.architecture})`], ["Host", environment.hostname], ["Runtime", `${environment.runtime} ${environment.runtimeVersion}`], ["Git dirty", available(environment.gitDirty, unavailable.gitDirty)], ["Git commit", available(environment.gitCommit, unavailable.gitCommit)]]), "",
    "## Versions", "", markdownTable(["Component", "Version"], [["Backend", result.backend.version], ["Official SDK", available(environment.sdkVersion, unavailable.sdkVersion)], ["npm", available(environment.npmVersion, unavailable.npmVersion)], ["Supabase CLI", available(environment.supabaseVersion, unavailable.supabaseVersion)], ["Docker", available(environment.dockerVersion, unavailable.dockerVersion)]]), "",
    "## Correctness", "", `${passed} passed, ${failed} failed${result.correctness.aborted ? `; aborted (${mdCell(result.correctness.abortReason ?? "reason unavailable")})` : ""}.`, "", markdownTable(["Check", "Status", "Classification", "Message", "Evidence"], result.correctness.findings.map(finding => [finding.name, finding.passed ? "PASS" : "FAIL", finding.classification, finding.message ?? "", finding.evidence ?? ""])), "",
    "## Capacity", "", `Selected capacity: **${result.capacity.users} users**. Saturation: **${result.capacity.saturation ? "yes" : "no"}**.`, "", markdownTable(["Capacity reasons"], sectionRows(result.capacity.reasons)), "",
    "## Stage metrics", "", markdownTable(stageHeaders, stageRows), "",
    "## Stage resources", "", markdownTable(resourceHeaders, resourceRows), "",
    "## Backend deviations", "", markdownTable(["Deviation"], sectionRows(result.backend.deviations ?? [])), "",
    "## Bounded error examples", "", `showing ${shownExamples.length} of ${totalExamples}`, "", markdownTable(["Stage", "Type", "Name", "Class", "Classification", "Error", "Message", "Occurrences"], shownExamples.length ? shownExamples : [["", "", "", "", "", "", "none", ""]]), "",
    "## Raw result", "", `[${mdCell(rawName)}](${rawTarget})`, "",
  ].join("\n");
  const csvHeaders = ["requestedUsers", "achievedUsers", "elapsedSeconds", "workflowTPS", "sdkTPS", "readSdkRate", "writeSdkRate", ...classes.flatMap(name => [`${name}Attempts`, `${name}P50Ms`, `${name}P95Ms`, `${name}P99Ms`, `${name}ErrorRate`, `${name}Slo`]), "resourceSamples", "runnerCpuMaxPercent", "runnerRssMaxBytes", "backendCpuMaxPercent", "backendRssMaxBytes", "eventLoopP99MaxMs", "eventLoopMaxMs", "supabaseCpuMaxPercent", "supabaseMemoryMaxBytes", "supabaseBlockReadMaxBytes", "supabaseBlockWriteMaxBytes", "valid", "validityReasons", "errorExamples"];
  const csvRows = result.stages.map((stage, index) => { const resource = resources[index]!; return [stage.requestedUsers, stage.achievedUsers, number(stage.elapsedSeconds), number(stage.workflowTransactionsPerSecond), number(stage.sdkOperationsPerSecond), number(stage.readOperationsPerSecond), number(stage.writeOperationsPerSecond), ...classes.flatMap(name => csvMetricCells(stage.operationClassMetrics[name], result.config.slos[name])), resource.sampleCount, resourceValue(resource.runnerCpuPercent), resourceValue(resource.runnerRssBytes), resourceValue(resource.backendCpuPercent), resourceValue(resource.backendRssBytes), resourceValue(resource.eventLoopP99Ms), resourceValue(resource.eventLoopMaxMs), resourceValue(resource.supabaseCpuPercent), resourceValue(resource.supabaseMemoryBytes), resourceValue(resource.supabaseBlockReadBytes), resourceValue(resource.supabaseBlockWriteBytes), stage.valid, stage.validityReasons.join("; ") || "none", stageErrors(csvExamples.get(stage)!, stage.errorExamples.length)]; });
  return { markdown, csv: [csvRow(csvHeaders), ...csvRows.map(csvRow)].join("\n") + "\n" };
}

async function writePrivateTemp(path: string, content: string): Promise<void> { await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
function outputPaths(jsonPath: string): WrittenBenchmarkReport { const base = jsonPath.slice(0, -extname(jsonPath).length); return { markdownPath: `${base}.md`, csvPath: `${base}-stages.csv` }; }
export async function writeBenchmarkReport(result: BenchmarkResult, jsonPath: string, options: WriteReportOptions = {}): Promise<WrittenBenchmarkReport> {
  if (typeof jsonPath !== "string" || jsonPath.includes("\0") || extname(jsonPath).toLowerCase() !== ".json") throw new Error("Invalid JSON input path");
  const input = await lstat(jsonPath).catch(() => null); if (!input?.isFile() || input.isSymbolicLink()) throw new Error("JSON input must be a regular non-symlink file");
  const report = createBenchmarkReport(result, jsonPath); const paths = outputPaths(jsonPath); await mkdir(dirname(jsonPath), { recursive: true });
  const suffix = `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`; const markdownTemp = `${paths.markdownPath}${suffix}`; const csvTemp = `${paths.csvPath}${suffix}`; let markdownCreated = false;
  try {
    await writePrivateTemp(markdownTemp, report.markdown); await writePrivateTemp(csvTemp, report.csv);
    if (options.overwrite) { await rename(markdownTemp, paths.markdownPath); await rename(csvTemp, paths.csvPath); }
    else {
      try { await link(markdownTemp, paths.markdownPath); markdownCreated = true; await link(csvTemp, paths.csvPath); }
      catch (error) { if (markdownCreated) await unlink(paths.markdownPath).catch(() => undefined); if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Report output already exists"); throw error; }
    }
    return paths;
  } finally { await unlink(markdownTemp).catch(() => undefined); await unlink(csvTemp).catch(() => undefined); }
}
