import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, type BenchmarkConfig, type OperationClass } from "../src/config.js";
import { evaluateCapacity } from "../src/capacity.js";
import type { OperationClassMetric, StageMetrics } from "../src/result.js";

const config = loadConfig("configs/quick.json");
const classes: OperationClass[] = ["read", "write", "authSearch"];
const metric = (p95Ms = 100, attempted = 20, failed = 0): OperationClassMetric => ({
  attempted, completed: attempted - failed, failed, errorRate: failed / attempted,
  latencyP50Ms: p95Ms / 2, latencyP95Ms: p95Ms, latencyP99Ms: p95Ms, latencyMinMs: 1, latencyMaxMs: p95Ms,
});
const passMetrics = (p95Ms = 100): Record<OperationClass, OperationClassMetric> => Object.fromEntries(classes.map(name => [name, metric(p95Ms)])) as Record<OperationClass, OperationClassMetric>;
const pass = (users: number, tps = users, metrics = passMetrics()): StageMetrics => ({
  requestedUsers: users, achievedUsers: users, elapsedSeconds: 1, workflowTransactionsPerSecond: tps,
  workflowTransactionsPerSecondByName: {}, sdkOperationsPerSecond: 0, readOperationsPerSecond: 0, writeOperationsPerSecond: 0,
  workflowCompletionCountByName: {}, operations: {}, operationClassMetrics: metrics, errorExamples: [], valid: true, validityReasons: [],
});
const withConfig = (changes: Partial<BenchmarkConfig>): BenchmarkConfig => ({ ...config, ...changes });

test("all stages pass and selects the highest users", () => {
  const result = evaluateCapacity([pass(25), pass(50), pass(100)], config);
  assert.equal(result.users, 100);
  assert.equal(result.hasCapacity, true);
  assert.equal(result.stages.every(stage => stage.passed), true);
});

test("latency and boundary error rate fail SLOs", () => {
  const latency = evaluateCapacity([pass(25, 25, passMetrics(501))], config);
  assert.equal(latency.users, 0);
  assert.equal(latency.stages[0]!.passed, false);
  assert.match(latency.stages[0]!.reasons.join(" "), /p95Ms 501/);
  const boundary = evaluateCapacity([pass(25, 25, { ...passMetrics(), read: metric(100, 20, 1) })], config);
  assert.equal(boundary.stages[0]!.passed, false);
  assert.match(boundary.stages[0]!.reasons.join(" "), /errorRate 0.05/);
});

test("achieved concurrency, invalid runner stage, and insufficient samples fail", () => {
  const miss = evaluateCapacity([pass(25)], config, { minAchievedRatio: 0.95 });
  const missed = evaluateCapacity([{ ...pass(25), achievedUsers: 23 }], config);
  assert.equal(missed.stages[0]!.passed, false);
  assert.match(missed.stages[0]!.reasons.join(" "), /achieved\/requested/);
  const invalid = evaluateCapacity([{ ...pass(25), valid: false, validityReasons: ["runner overloaded"] }], config);
  assert.equal(invalid.stages[0]!.invalid, true);
  assert.match(invalid.stages[0]!.reasons.join(" "), /runner overloaded/);
  const few = evaluateCapacity([pass(25, 25, { ...passMetrics(), read: metric(100, 19) })], config);
  assert.equal(few.stages[0]!.passed, false);
  assert.match(few.stages[0]!.reasons.join(" "), /fewer than 20/);
  assert.equal(miss.users, 25);
});

test("no passing stage returns zero and preserves evidence; later pass cannot erase failure", () => {
  const result = evaluateCapacity([{ ...pass(25), valid: false, validityReasons: ["backend unhealthy"] }, { ...pass(50) }], config);
  assert.equal(result.users, 0);
  assert.equal(result.hasCapacity, false);
  assert.equal(result.stages[1]!.passed, true);
  assert.match(result.reasons.join(" "), /backend unhealthy/);
});

test("a passing stage followed by failure selects last contiguous pass", () => {
  const result = evaluateCapacity([pass(25), { ...pass(50), operationClassMetrics: { ...passMetrics(), write: metric(751) } }, pass(100)], config);
  assert.equal(result.users, 25);
  assert.equal(result.stages[2]!.passed, true);
});

test("plateau requires material increase, under ten percent gain, and rising active-class p95", () => {
  const result = evaluateCapacity([pass(25, 100, passMetrics(100)), pass(50, 105, passMetrics(120))], config);
  assert.equal(result.saturation, true);
  assert.equal(result.stages[1]!.saturated, true);
  assert.equal(result.users, 25);
  assert.equal(result.saturationEvidence?.previousUsers, 25);
  assert.equal(result.saturationEvidence?.currentUsers, 50);
  assert.equal(result.saturationEvidence?.tpsGain, 0.05);
  for (const [label, current, prior] of [
    ["immaterial increase", pass(28, 105, passMetrics(120)), pass(25, 100, passMetrics(100))],
    ["throughput gain", pass(50, 111, passMetrics(120)), pass(25, 100, passMetrics(100))],
    ["zero baseline", pass(50, 0, passMetrics(120)), pass(25, 0, passMetrics(100))],
    ["flat latency", pass(50, 105, passMetrics(100)), pass(25, 100, passMetrics(100))],
  ] as const) {
    const noPlateau = evaluateCapacity([prior, current], config);
    assert.equal(noPlateau.saturation, false, label);
  }
  const decrease = evaluateCapacity([pass(25, 100, passMetrics(100)), pass(50, 90, passMetrics(120))], config);
  assert.equal(decrease.saturation, true);
  assert.equal(decrease.saturationEvidence?.tpsGain, -0.1);
});

test("zero-weight classes are not required", () => {
  const weights = { ...config.weights, dashboard: 100, taskList: 0, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 };
  const activeConfig = { ...config, weights };
  const readOnly = { read: metric(), write: metric(), authSearch: metric() };
  delete (readOnly as Partial<typeof readOnly>).write;
  delete (readOnly as Partial<typeof readOnly>).authSearch;
  const result = evaluateCapacity([pass(25, 25, readOnly as Record<OperationClass, OperationClassMetric>)], activeConfig);
  assert.equal(result.users, 25);
});

test("malformed stage inputs are rejected without mutating caller stages", () => {
  const stages = [pass(25), pass(50)];
  const before = JSON.stringify(stages);
  assert.throws(() => evaluateCapacity([{ ...pass(25), requestedUsers: Number.NaN }], config), /finite/);
  assert.throws(() => evaluateCapacity([{ ...pass(25), requestedUsers: 0 }], config), /positive/);
  assert.throws(() => evaluateCapacity([{ ...pass(25), operationClassMetrics: { ...passMetrics(), read: { ...metric(), attempted: 2, completed: 2, failed: 1 } } }], config), /attempted/);
  evaluateCapacity(stages, config);
  assert.equal(JSON.stringify(stages), before);
});

void withConfig;
