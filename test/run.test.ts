import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { runBenchmark } from "../src/run.js";

const config = parseConfig({ name: "quick", publishable: false, dataset: "small", seed: 1, warmupSeconds: 1, stageSeconds: 1, concurrency: [1], maxConcurrency: 1, timeoutMs: 1, thinkTimeMs: { min: 0, max: 0 }, weights: { dashboard: 100, taskList: 0, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 }, slos: { read: { p95Ms: 1000, maxErrorRate: 1 }, write: { p95Ms: 1000, maxErrorRate: 1 }, authSearch: { p95Ms: 1000, maxErrorRate: 1 } } });

test("runBenchmark orders lifecycle and excludes warmup samples", async () => {
  const events: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), "bench-run-")); const resultPath = join(dir, "result.json");
  const backend = {
    name: "pocketbase" as const,
    doctor: async () => { events.push("doctor"); return { name: "pocketbase" as const, version: "fake", endpoint: "fake" }; },
    start: async () => { events.push("start"); }, reset: async () => { events.push("reset"); },
    seed: async () => { events.push("seed"); }, stop: async () => { events.push("stop"); },
    createSession: async () => { throw new Error("unused"); },
    seedCorrectnessFixture: async () => { events.push("fixture"); return { owner: { email: "o", password: "p" }, admin: { email: "a", password: "p" }, member: { email: "m", password: "p" }, outsider: { email: "x", password: "p" }, organizationId: "o", projectId: "p", taskId: "t", ownerMembershipId: "om", memberMembershipId: "mm", adminMembershipId: "am" }; },
    buildVirtualUserSpecs: async () => [{ credentials: { email: "u", password: "p" }, organizationId: "o", projectId: "p", taskId: "t" }],
  };
  let calls = 0;
  const workload = async (_backend: any, _config: any, opts: any) => { events.push(calls++ === 0 ? "warmup" : "measured"); opts.onSample?.({ type: "workflow", name: "dashboard", workflow: "dashboard", operationClass: "read", kind: "read", elapsedMs: 1, success: true }); return { requestedUsers: 1, startedUsers: 1, completedWorkflowCount: 1, failedWorkflowCount: 0, graceExpired: false, stageFailed: false, closeErrors: 0 }; };
  const resources = async () => { events.push("resources"); return { samples: [], valid: true, validityReasons: [] }; };
  await runBenchmark({ backend: "pocketbase", config, resultPath, dependencies: { loadBackend: async () => backend as any, correctness: async () => { events.push("correctness"); return { findings: [{ name: "ok", passed: true, classification: "application" as const }] }; }, workload: workload as any, resources: resources as any, captureEnvironment: async info => ({ backend: info } as any), now: () => new Date("2026-01-01T00:00:00.000Z"), monotonic: (() => { let n = 0; return () => ++n; })() } });
  assert.deepEqual(events.slice(0, 8), ["doctor", "start", "doctor", "reset", "doctor", "seed", "fixture", "correctness"]);
  assert.deepEqual(events.slice(9), ["warmup", "resources", "measured", "stop"]);
  const saved = JSON.parse(await readFile(resultPath, "utf8")); assert.equal(saved.stages[0].workflowTransactionsPerSecond, 1000); assert.equal(saved.correctness.findings[0].passed, true);
});
