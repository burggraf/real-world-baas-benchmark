import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { aggregateBenchmarkResults, aggregateBenchmarkResultsByBackend, AggregationCompatibilityError, medianSpread } from "../src/aggregate.js";
import { createBenchmarkReport, validateBenchmarkResult, writeBenchmarkReport } from "../src/report.js";
import type { BenchmarkResult } from "../src/result.js";

const fixture = async (name: "pass" | "fail" = "pass"): Promise<BenchmarkResult> => JSON.parse(await readFile(new URL(`../../test/fixtures/result-${name}.json`, import.meta.url), "utf8")) as BenchmarkResult;

const repeated = async (count: number): Promise<BenchmarkResult[]> => {
  const base = await fixture();
  return Array.from({ length: count }, (_, index) => {
    const result = structuredClone(base);
    result.runId = `run-${index + 1}`;
    result.config.maxConcurrency = 20; result.capacity.users = [1, 2, 10, 20][index]!;
    for (const users of [1, 10, 20]) { const stage = structuredClone(result.stages[0]!); stage.requestedUsers = users; stage.achievedUsers = users; result.stages.push(stage); const resource = structuredClone(result.resources[0]!); resource.name = `stage-${users}`; result.resources.push(resource); }
    result.stages.sort((left, right) => left.requestedUsers - right.requestedUsers);
    for (const stage of result.stages) {
      stage.workflowTransactionsPerSecond = [10, 20, 100, 30][index]!; stage.sdkOperationsPerSecond = [20, 40, 200, 60][index]!; stage.readOperationsPerSecond = [15, 30, 150, 45][index]!; stage.writeOperationsPerSecond = [5, 10, 50, 15][index]!;
      stage.operationClassMetrics.read.latencyP95Ms = [90, 100, 130, 110][index]!; stage.operationClassMetrics.read.latencyP99Ms = [120, 140, 180, 160][index]!; const readErrors = [0, 1, 2, 3][index]!; Object.assign(stage.operationClassMetrics.read, { failed: readErrors, completed: 100 - readErrors, errorRate: readErrors / 100 });
    }
    for (const resource of result.resources) for (const snapshot of resource.snapshots!) snapshot.runner.cpuPercent = [10, 20, 30, 40][index]!;
    return result;
  });
};

test("renders deterministic valid Markdown and CSV with all required report sections", async () => {
  const result = await fixture();
  const report = createBenchmarkReport(result, "/tmp/results/result-pass.json");
  assert.equal(report.markdown, createBenchmarkReport(result, "/tmp/results/result-pass.json").markdown);
  for (const text of [
    "# VALID benchmark result",
    "| Backend | supabase |",
    "| Config | full \\| quoted |",
    "| Dataset | small |",
    "| Seed | 42 |",
    "| Publishable | yes |",
    "Test CPU",
    "linux 6.8.0 (x64)",
    "v22.20.0",
    "0123456789abcdef0123456789abcdef01234567",
    "| Git dirty | no |",
    "| Official SDK | 2.112.3 |",
    "| npm | 10.9.3 |",
    "| Supabase CLI | 2.50.0 |",
    "| Docker | 28.3.0 |",
    "2 passed, 0 failed",
    "Selected capacity: **2 users**",
    "stage 2 meets every configured SLO",
    "Requested users",
    "Workflow TPS",
    "Read attempts",
    "Read p50 (ms)",
    "PASS (p95 &lt;= 500 ms; errors &lt; 5.00%)",
    "Resource samples",
    "250000000",
    "5800",
    "aaaaaaaaaaaa",
    "bbbbbbbbbbbb",
    "CPU (%)",
    "RSS/memory (bytes)",
    "block read (bytes) 3000",
    "local SMTP \\| disabled",
    "timeout \\| \"safe\", retry, then stop",
    "[result-pass.json](./result-pass.json)",
  ]) assert.ok(report.markdown.includes(text), `missing report text: ${text}`);
  assert.match(report.csv, /^requestedUsers,achievedUsers,elapsedSeconds,workflowTPS,sdkTPS,readSdkRate,writeSdkRate,/);
  assert.match(report.csv, /2,2,30,12\.5,40\.25,30\.5,9\.75/);
  assert.match(report.csv, /timeout \| ""safe"", retry, then stop/);
  assert.doesNotMatch(report.markdown + report.csv, /undefined|NaN|Infinity/);
});

test("renders invalid reasons, failures, and unavailable resources without invented zeroes", async () => {
  const report = createBenchmarkReport(await fixture("fail"), "result-fail.json");
  assert.match(report.markdown, /# INVALID benchmark result/);
  assert.match(report.markdown, /correctness \\\| prerequisite failed/);
  assert.match(report.markdown, /backend health check failed, safe detail/);
  assert.match(report.markdown, /FAIL \(p95 &lt;= 500 ms; errors &lt; 5\.00%\)/);
  assert.match(report.markdown, /runner probe unavailable/);
  assert.match(report.markdown, /docker stats unavailable/);
  assert.match(report.markdown, /unavailable \(official SDK metadata unavailable\)/);
  assert.match(report.markdown, /unavailable \(npm probe unavailable\)/);
  assert.match(report.markdown, /unavailable \(Supabase CLI probe unavailable\)/);
  assert.match(report.markdown, /unavailable \(docker probe unavailable\)/);
  assert.match(report.markdown, /\| 2 \| 1 \| unavailable \| unavailable \| unavailable/);
  assert.doesNotMatch(report.markdown, /\| 0 \| 0 \| 0 \| 0 \|/);
});

test("safe error metadata validates and renders without leaking arbitrary fields", async () => {
  const result = await fixture();
  result.stages[0]!.errorExamples = [{ ...result.stages[0]!.errorExamples[0]!, code: "23505", status: 409, message: "safe" }];
  const report = createBenchmarkReport(result, "result.json");
  assert.match(report.markdown + report.csv, /23505|409/);
  const malformed = structuredClone(result) as any;
  malformed.stages[0].errorExamples[0].status = 600;
  assert.throws(() => validateBenchmarkResult(malformed), /errorExamples.*status/i);
  malformed.stages[0].errorExamples[0].status = 409;
  malformed.stages[0].errorExamples[0].code = "secret.body";
  assert.throws(() => validateBenchmarkResult(malformed), /errorExamples.*code/i);
});

test("redacts bounded error text and rejects malformed or non-finite required fields", async () => {
  const result = await fixture();
  result.correctness.findings[0]!.message = "password=hunter2 Authorization: Bearer abc.def.ghi token=secret-token";
  result.stages[0]!.errorExamples = Array.from({ length: 40 }, (_, index) => ({ ...result.stages[0]!.errorExamples[0]!, message: `safe error ${index}` }));
  const report = createBenchmarkReport(result, "result-pass.json");
  assert.doesNotMatch(report.markdown + report.csv, /hunter2|abc\.def\.ghi|secret-token/);
  assert.match(report.markdown, /showing 20 of 40/);
  const malformed = structuredClone(result) as unknown as Record<string, unknown>;
  malformed.seed = Number.NaN;
  assert.throws(() => validateBenchmarkResult(malformed), /seed|finite/i);
  assert.throws(() => createBenchmarkReport({ ...result, capacity: { ...result.capacity, users: Infinity } }, "result.json"), /capacity\.users|finite/i);
  assert.throws(() => validateBenchmarkResult({ ...result, environment: {} }), /environment/i);
});

test("rejects semantically inconsistent benchmark results", async () => {
  const cases: Array<[string, (result: BenchmarkResult) => void]> = [
    ["achieved users", result => { result.stages[0]!.achievedUsers = result.stages[0]!.requestedUsers + 1; }],
    ["class counts", result => { result.stages[0]!.operationClassMetrics.read = { ...result.stages[0]!.operationClassMetrics.read, attempted: 1, completed: 999 }; }],
    ["class error rate", result => { result.stages[0]!.operationClassMetrics.read.errorRate = 0.5; }],
    ["percentile order", result => { result.stages[0]!.operationClassMetrics.read.latencyP50Ms = 700; }],
    ["stage uniqueness", result => { result.stages.push(structuredClone(result.stages[0]!)); }],
    ["stage validity", result => { result.stages[0]!.validityReasons = ["contradiction"]; }],
    ["settings integer", result => { result.settings.minClassSamples = 1.5; }],
    ["session preparation integer", result => { result.settings.sessionPreparationConcurrency = 0; }],
    ["boundary session flag", result => { result.settings.boundarySessionsUnmeasured = false as never; }],
    ["measured request timeout", result => { result.settings.measuredRequestTimeoutMs = 0; }],
    ["malformed error code", result => { result.stages[0]!.errorExamples = [{ ...result.stages[0]!.errorExamples[0]!, code: "bad.code" }]; }],
    ["malformed error status", result => { result.stages[0]!.errorExamples = [{ ...result.stages[0]!.errorExamples[0]!, status: 99 }]; }],
    ["malformed error classification", result => { result.stages[0]!.errorExamples = [{ ...result.stages[0]!.errorExamples[0]!, classification: "secret" as never }]; }],
    ["fractional measured request timeout", result => { result.settings.measuredRequestTimeoutMs = 0.5; }],
    ["oversized measured request timeout", result => { result.settings.measuredRequestTimeoutMs = 2_147_483_648; }],
    ["fractional config timeout", result => { result.config.timeoutMs = 0.5; }],
    ["byte integer", result => { result.resources[0]!.snapshots![0]!.runner.rssBytes = 1.5; }],
    ["valid prerequisites", result => { result.failures = ["failure"]; }],
    ["selected capacity SLO", result => { Object.assign(result.stages[0]!.operationClassMetrics.read, { failed: 5, completed: 95, errorRate: 0.05 }); }],
  ];
  for (const [label, mutate] of cases) { const result = await fixture(); mutate(result); assert.throws(() => validateBenchmarkResult(result), /Invalid/, label); }
});

test("uses strict error SLO boundaries and escapes active Markdown and CSV content", async () => {
  const boundary = await fixture("fail"); Object.assign(boundary.stages[0]!.operationClassMetrics.read, { attempted: 100, completed: 95, failed: 5, errorRate: 0.05, latencyP95Ms: 500 });
  assert.match(createBenchmarkReport(boundary, "boundary.json").markdown, /FAIL \(p95 &lt;= 500 ms; errors &lt; 5\.00%\)/);
  const injected = await fixture(); injected.correctness.findings[0]!.name = "<img src=x onerror=alert(1)> [x](javascript:alert(1))";
  const markdown = createBenchmarkReport(injected, "x](javascript:alert(1)).json").markdown;
  assert.doesNotMatch(markdown, /<img|(?:^|[^\\])\[x\]\(javascript:/m); assert.match(markdown, /&lt;img src=x onerror=alert\(1\)&gt;/);
  const formula = await fixture("fail"); formula.stages[0]!.validityReasons = ["=CMD()"];
  assert.match(createBenchmarkReport(formula, "formula.json").csv, /'=CMD\(\)/);
});

test("writes both reports atomically with private permissions and refuses overwrite by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-report-"));
  const jsonPath = join(dir, "run.json");
  const result = await fixture(); result.correctness.findings[0]!.message = "password=writer-secret Authorization: Bearer abc.def.ghi";
  await writeFile(jsonPath, JSON.stringify(result), { mode: 0o600 });
  const written = await writeBenchmarkReport(result, jsonPath);
  assert.equal(written.markdownPath, join(dir, "run.md"));
  assert.equal(written.csvPath, join(dir, "run-stages.csv"));
  const generated = await readFile(written.markdownPath, "utf8") + await readFile(written.csvPath, "utf8");
  assert.match(generated, /# VALID benchmark result/); assert.doesNotMatch(generated, /writer-secret|abc\.def\.ghi/);
  if (process.platform !== "win32") {
    assert.equal((await stat(written.markdownPath)).mode & 0o077, 0);
    assert.equal((await stat(written.csvPath)).mode & 0o077, 0);
  }
  await writeFile(written.markdownPath, "unrelated\n");
  await assert.rejects(writeBenchmarkReport(result, jsonPath), /already exists/i);
  assert.equal(await readFile(written.markdownPath, "utf8"), "unrelated\n");
  await assert.rejects(writeBenchmarkReport(result, jsonPath), /already exists/i);
});

test("median spread uses odd values and the arithmetic mean of an even middle pair", () => {
  assert.deepEqual(medianSpread([10, 2, 5]), { median: 5, min: 2, max: 10 });
  assert.deepEqual(medianSpread([10, 2, 8, 4]), { median: 6, min: 2, max: 10 });
  assert.throws(() => medianSpread([]), /value/i);
});

test("aggregates capacity, throughput, classes, and resource maxima without a composite score", async () => {
  const aggregate = aggregateBenchmarkResults(await repeated(3));
  assert.equal(aggregate.runCount, 3);
  assert.deepEqual(aggregate.capacityUsers, { median: 2, min: 1, max: 10 });
  assert.deepEqual(aggregate.stages[0]!.workflowTransactionsPerSecond, { median: 20, min: 10, max: 100 });
  assert.deepEqual(aggregate.stages[0]!.sdkOperationsPerSecond, { median: 40, min: 20, max: 200 });
  assert.deepEqual(aggregate.stages[0]!.operationClasses.read.latencyP50Ms, { median: 20, min: 20, max: 20 });
  assert.deepEqual(aggregate.stages[0]!.operationClasses.read.latencyP95Ms, { median: 100, min: 90, max: 130 });
  assert.deepEqual(aggregate.stages[0]!.resources.runnerCpuPercent, { median: 20, min: 10, max: 30 });
  assert.equal("score" in aggregate, false);
  const even = aggregateBenchmarkResults(await repeated(4));
  assert.deepEqual(even.stages[0]!.workflowTransactionsPerSecond, { median: 25, min: 10, max: 100 });
});

test("lists exact aggregation incompatibilities and only compatibility override bypasses them", async () => {
  const fields: Array<[string, (value: BenchmarkResult) => void]> = [
    ["backend.version", value => { value.backend.version = "different"; value.environment.backend.version = "different"; }],
    ["environment.sdkVersion", value => { value.environment.sdkVersion = "9.9.9"; }],
    ["config", value => { value.config.stageSeconds++; }],
    ["dataset", value => { value.dataset = "medium"; value.config.dataset = "medium"; }],
    ["seed", value => { value.seed++; value.config.seed++; }],
    ["schemaVersion", value => { (value as { schemaVersion: number }).schemaVersion = 2; }],
    ["hardware", value => { value.environment.cpuModel = "Other CPU"; }],
  ];
  for (const [field, change] of fields) {
    const runs = await repeated(3); change(runs[2]!);
    assert.throws(() => aggregateBenchmarkResults(runs), error => error instanceof AggregationCompatibilityError && error.mismatches.some(item => item.field === field));
  }
  const runs = await repeated(3); runs[2]!.backend.version = "different"; runs[2]!.environment.backend.version = "different";
  const aggregate = aggregateBenchmarkResults(runs, { override: true });
  assert.equal(aggregate.compatibilityMismatches[0]!.field, "backend.version");
  const reordered = await repeated(3); const sourceConfig = reordered[1]!.config;
  reordered[1]!.config = {
    slos: sourceConfig.slos, weights: sourceConfig.weights, thinkTimeMs: sourceConfig.thinkTimeMs,
    timeoutMs: sourceConfig.timeoutMs, maxConcurrency: sourceConfig.maxConcurrency, concurrency: sourceConfig.concurrency,
    stageSeconds: sourceConfig.stageSeconds, warmupSeconds: sourceConfig.warmupSeconds, seed: sourceConfig.seed,
    dataset: sourceConfig.dataset, publishable: sourceConfig.publishable, name: sourceConfig.name,
  };
  assert.doesNotThrow(() => aggregateBenchmarkResults(reordered));
  const duplicateRuns = await repeated(3); duplicateRuns[1]!.runId = duplicateRuns[0]!.runId;
  assert.throws(() => aggregateBenchmarkResults(duplicateRuns, { override: true }), /distinct run IDs/i);
  const settingsChanged = await repeated(3); settingsChanged[1]!.settings.minClassSamples++;
  assert.throws(() => aggregateBenchmarkResults(settingsChanged), /settings/);
  const hostChanged = await repeated(3); hostChanged[1]!.environment.hostname = "other-host";
  assert.throws(() => aggregateBenchmarkResults(hostChanged), /hardware/);
  const commitChanged = await repeated(3); commitChanged[1]!.environment.gitCommit = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  assert.throws(() => aggregateBenchmarkResults(commitChanged), /gitCommit/); assert.throws(() => aggregateBenchmarkResults(commitChanged, { override: true }), /identical clean git/i);
  const runtimeChanged = await repeated(3); runtimeChanged[1]!.environment.runtimeVersion = "v23.0.0";
  assert.throws(() => aggregateBenchmarkResults(runtimeChanged), /runtimeVersion/);
  const nodeChanged = await repeated(3); nodeChanged[1]!.environment.nodeVersion = "v23.0.0";
  assert.throws(() => aggregateBenchmarkResults(nodeChanged), /nodeVersion/);
  const versionsChanged = await repeated(3); versionsChanged[1]!.versions = { ...versionsChanged[1]!.versions, runtime: "v23.0.0" };
  assert.throws(() => aggregateBenchmarkResults(versionsChanged), /versions/);
  const dirty = await repeated(3); dirty[1]!.environment.gitDirty = true;
  assert.throws(() => aggregateBenchmarkResults(dirty, { override: true }), /clean git/i);
  const projectChanged = await repeated(3); projectChanged[1]!.backend.supabaseProjectId = "other-project"; projectChanged[1]!.environment.backend.supabaseProjectId = "other-project";
  assert.throws(() => aggregateBenchmarkResults(projectChanged), /supabaseProjectId/);
  const schemaRuns = await repeated(3); (schemaRuns[2] as { schemaVersion: number }).schemaVersion = 2;
  assert.equal(aggregateBenchmarkResults(schemaRuns, { override: true }).compatibilityMismatches[0]!.field, "schemaVersion");
});

test("rejects too few, invalid, and nonpublishable runs for publishable aggregation", async () => {
  const tooFew = await repeated(2);
  assert.throws(() => aggregateBenchmarkResults(tooFew), /at least 3/i);
  const invalid = await repeated(3); invalid[1]!.valid = false; invalid[1]!.validityReasons = ["failed"];
  assert.throws(() => aggregateBenchmarkResults(invalid), /run-2.*valid/i);
  assert.throws(() => aggregateBenchmarkResults(invalid, { override: true }), /run-2.*valid/i);
  const nonpublishable = await repeated(3); for (const result of nonpublishable) { result.publishable = false; result.config.publishable = false; }
  assert.throws(() => aggregateBenchmarkResults(nonpublishable), /run-1.*publishable/i);
  assert.equal(aggregateBenchmarkResults(nonpublishable, { publishable: false }).publishable, false);
});

test("keeps cross-backend aggregates separate", async () => {
  const supabase = await repeated(3); const pocketbase = await repeated(3);
  for (const [index, result] of pocketbase.entries()) { result.runId = `pocket-${index}`; result.backend.name = "pocketbase"; result.environment.backend.name = "pocketbase"; }
  assert.throws(() => aggregateBenchmarkResults([...supabase, ...pocketbase], { override: true }), error => error instanceof AggregationCompatibilityError && error.mismatches.every(item => item.field === "backend.name"));
  assert.deepEqual(Object.keys(aggregateBenchmarkResultsByBackend([...supabase, ...pocketbase])), ["pocketbase", "supabase"]);
});

test("aggregates only common requested-user stages and reports every missing stage", async () => {
  const runs = await repeated(3);
  for (const result of runs.slice(0, 2)) {
    const stage = structuredClone(result.stages[0]!); stage.requestedUsers = 4; stage.achievedUsers = 4; result.stages.push(stage); result.stages.sort((left, right) => left.requestedUsers - right.requestedUsers);
    const resource = structuredClone(result.resources[0]!); resource.name = "stage-4"; result.resources.push(resource);
  }
  const aggregate = aggregateBenchmarkResults(runs);
  assert.deepEqual(aggregate.stages.map(stage => stage.requestedUsers), [1, 2, 10, 20]);
  assert.deepEqual(aggregate.missingStages, [{ requestedUsers: 4, missingRunIds: ["run-3"] }]);
});
