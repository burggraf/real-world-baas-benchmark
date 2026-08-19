import assert from "node:assert/strict";
import test from "node:test";
import { loadBackend } from "../src/backend.js";
import type { BenchmarkResult } from "../src/result.js";

test("benchmark results survive JSON round trip", () => {
  const result: BenchmarkResult = {
    schemaVersion: 1, runId: "run-1", startedAt: "2026-01-01T00:00:00Z", publishable: false,
    backend: { name: "pocketbase", version: "0.1", endpoint: "http://localhost" }, dataset: "small", seed: 42,
    environment: { runtime: "node", runtimeVersion: "22", os: "linux", architecture: "x64" },
    config: { name: "quick", publishable: false, dataset: "small", seed: 42, warmupSeconds: 1, stageSeconds: 1, concurrency: [1], maxConcurrency: 1, timeoutMs: 1000, thinkTimeMs: { min: 0, max: 0 }, weights: { dashboard: 100, taskList: 0, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 }, slos: { read: { p95Ms: 1, maxErrorRate: 1 }, write: { p95Ms: 1, maxErrorRate: 1 }, authSearch: { p95Ms: 1, maxErrorRate: 1 } } },
    versions: { node: "22" }, correctness: { findings: [] }, stages: [], resources: [], capacity: { users: 1, saturation: false, reasons: [] }, failures: [], valid: true, validityReasons: [],
  };
  const parsed = JSON.parse(JSON.stringify(result)) as BenchmarkResult;
  assert.equal(parsed.schemaVersion, 1); assert.equal(parsed.backend.name, "pocketbase"); assert.equal(parsed.dataset, "small"); assert.deepEqual(parsed.stages, []); assert.equal(parsed.valid, true); assert.equal(parsed.capacity.users, 1);
});

test("stage metrics expose units in field names and values", () => {
  const stage = {
    requestedUsers: 2, achievedUsers: 2, elapsedSeconds: 1,
    workflowTransactionsPerSecond: 2, workflowTransactionsPerSecondByName: { dashboard: 2 },
    sdkOperationsPerSecond: 3, readOperationsPerSecond: 5, writeOperationsPerSecond: 6,
    operations: { dashboard: { operationCount: 2, errorCount: 0, latencyP50Ms: 10, latencyP95Ms: 20, latencyP99Ms: 30, latencyMinMs: 5, latencyMaxMs: 40 } },
  };
  assert.equal(stage.operations.dashboard.latencyP95Ms, 20);
  assert.equal(stage.sdkOperationsPerSecond, 3);
});

test("loads the PocketBase adapter and remaining named stubs fail clearly", async () => {
  assert.equal((await loadBackend("pocketbase")).name, "pocketbase");
  for (const name of ["supabase", "trailbase"] as const) {
    const backend = await loadBackend(name); assert.equal(backend.name, name);
    await assert.rejects(backend.doctor(), /NotImplemented/);
    await assert.rejects(backend.start(), /NotImplemented/);
    await assert.rejects(backend.reset(), /NotImplemented/);
    await assert.rejects(backend.seed({ name: "small", definition: {} }, 1), /NotImplemented/);
    await assert.rejects(backend.createSession({ email: "a", password: "b" }), /NotImplemented/);
    await assert.rejects(backend.stop(), /NotImplemented/);
  }
});
