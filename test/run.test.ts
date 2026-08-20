import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { runBenchmark, safeErrorMessage } from "../src/run.js";
import type { BackendInfo } from "../src/backend.js";
import type { ResourceSnapshot } from "../src/system.js";

const config = parseConfig({ name: "quick", publishable: false, dataset: "small", seed: 1, warmupSeconds: 1, stageSeconds: 1, concurrency: [1], maxConcurrency: 1, timeoutMs: 1, thinkTimeMs: { min: 0, max: 0 }, weights: { dashboard: 100, taskList: 0, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 }, slos: { read: { p95Ms: 1000, maxErrorRate: 1 }, write: { p95Ms: 1000, maxErrorRate: 1 }, authSearch: { p95Ms: 1000, maxErrorRate: 1 } } });

test("runBenchmark orders lifecycle and excludes warmup samples", async () => {
  const events: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), "bench-run-")); const resultPath = join(dir, "result.json");
  const backend = {
    name: "pocketbase" as const,
    doctor: async () => { events.push("doctor"); return { name: "pocketbase" as const, version: "fake", endpoint: "fake", processIds: [101], processExecutable: "/owned/pocketbase" }; },
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
  assert.deepEqual(events, ["doctor", "start", "doctor", "reset", "doctor", "seed", "fixture", "correctness", "doctor", "warmup", "doctor", "resources", "measured", "doctor", "stop"]);
  const saved = JSON.parse(await readFile(resultPath, "utf8")); assert.equal(saved.stages[0].workflowTransactionsPerSecond, 1000); assert.equal(saved.correctness.findings[0].passed, true);
});

const measuredConfig = (input: Record<string, unknown> = {}) => parseConfig({ name: "measured", publishable: false, dataset: "small", seed: 1, warmupSeconds: 1, stageSeconds: 1, concurrency: [1], maxConcurrency: 1, timeoutMs: 1, thinkTimeMs: { min: 0, max: 0 }, weights: { dashboard: 100, taskList: 0, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 }, slos: { read: { p95Ms: 1000, maxErrorRate: 1 }, write: { p95Ms: 1000, maxErrorRate: 1 }, authSearch: { p95Ms: 1000, maxErrorRate: 1 } }, ...input });
const fixture = { owner: { email: "o", password: "p" }, admin: { email: "a", password: "p" }, member: { email: "m", password: "p" }, outsider: { email: "x", password: "p" }, organizationId: "o", projectId: "p", taskId: "t", ownerMembershipId: "om", memberMembershipId: "mm", adminMembershipId: "am" };
const info = (processIds = [101]): BackendInfo => ({ name: "pocketbase", version: "fake", endpoint: "http://127.0.0.1:1", processIds, processExecutable: "/owned/pocketbase" });
const snapshot = (cpuPercent = 1, timestampMs = 1): ResourceSnapshot => ({ timestampMs, runner: { pid: 1, cpuPercent, rssBytes: 100 }, backend: { totalCpuPercent: 1, totalRssBytes: 100, processes: [{ pid: 101, cpuPercent: 1, rssBytes: 100 }] }, containers: null, containerTotals: null, containerReason: "not required", eventLoop: { p99Ms: 1, maxMs: 2 } });
const summary = (users: number) => ({ requestedUsers: users, startedUsers: users, completedWorkflowCount: 1, failedWorkflowCount: 0, graceExpired: false, stageFailed: false, closeErrors: 0 });

async function fakeRun(options: { config?: ReturnType<typeof measuredConfig>; confirmLarge?: boolean; doctor?: () => Promise<BackendInfo>; phaseFailure?: "start" | "reset" | "seed" | "correctness"; stopFailure?: boolean; unsafeCorrectness?: boolean; workload?: (opts: any) => Promise<any>; resources?: (opts: any) => Promise<any>; overloadThresholds?: { cpuPercent?: number; p99Ms?: number; maxMs?: number; consecutiveSamples?: number }; write?: (path: string, text: string, options: { flag: "wx" }) => Promise<void>; rename?: (from: string, to: string) => Promise<void>; onStop?: (resultPath: string) => void } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "bench-run-hardening-")); const resultPath = join(dir, "result.json"); const events: string[] = []; let workloadCalls = 0; let stopCalls = 0;
  const fail = (phase: string) => { if (options.phaseFailure === phase) throw new Error("Authorization: Bearer abc.def.ghi password=hunter2 api_key=sekret"); };
  const backend = {
    name: "pocketbase" as const,
    doctor: options.doctor ?? (async () => info()),
    start: async () => { events.push("start"); fail("start"); },
    reset: async () => { events.push("reset"); fail("reset"); },
    seed: async () => { events.push("seed"); fail("seed"); },
    stop: async () => { options.onStop?.(resultPath); events.push("stop"); stopCalls++; if (options.stopFailure) throw new Error("stop failed"); },
    createSession: async () => { throw new Error("unused"); },
    seedCorrectnessFixture: async () => fixture,
    buildVirtualUserSpecs: async (_profile: string, count: number) => Array.from({ length: count }, (_, i) => ({ credentials: { email: `u${i}`, password: "p" }, organizationId: "o", projectId: "p", taskId: "t" })),
  };
  const workload = async (_backend: unknown, _config: unknown, opts: any) => { workloadCalls++; if (options.workload) return options.workload(opts); opts.onSample?.({ type: "workflow", name: "dashboard", workflow: "dashboard", operationClass: "read", kind: "read", elapsedMs: 1, success: true }); return summary(opts.users.length); };
  const correctness = async () => { events.push("correctness"); fail("correctness"); return { findings: [{ name: options.unsafeCorrectness ? "password=name-secret" : "ok", passed: !options.unsafeCorrectness, classification: "application" as const, message: options.unsafeCorrectness ? "Authorization: Bearer finding-secret" : undefined, evidence: options.unsafeCorrectness ? "api_key=evidence-secret" : undefined }] }; };
  const resources = options.resources ?? (async () => ({ samples: [snapshot()], valid: true, validityReasons: [] }));
  const output = runBenchmark({ backend: "pocketbase", config: options.config ?? measuredConfig(), resultPath, confirmLarge: options.confirmLarge, dependencies: { loadBackend: async () => backend as any, captureEnvironment: async backendInfo => ({ backend: backendInfo, runtimeVersion: "v1", sdkVersion: "1.0.0" } as any), correctness, workload: workload as any, resources: resources as any, write: options.write, rename: options.rename, overloadThresholds: options.overloadThresholds, now: () => new Date("2026-01-01T00:00:00.000Z"), monotonic: (() => { let value = 0; return () => (value += 1000); })() } });
  return { output, resultPath, dir, events, get workloadCalls() { return workloadCalls; }, get stopCalls() { return stopCalls; } };
}

test("large runs refuse before backend load or filesystem writes unless explicitly confirmed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-run-large-refusal-")); const resultPath = join(dir, "nested", "result.json");
  let loads = 0; let writes = 0;
  await assert.rejects(runBenchmark({
    backend: "pocketbase", config: measuredConfig({ dataset: "large" }), resultPath,
    dependencies: {
      loadBackend: async () => { loads++; throw new Error("backend loaded"); },
      write: async () => { writes++; },
    },
  }), /confirm-large/i);
  assert.equal(loads, 0); assert.equal(writes, 0); assert.equal(existsSync(join(dir, "nested")), false);

  const confirmed = await fakeRun({ config: measuredConfig({ dataset: "large" }), confirmLarge: true });
  assert.equal((await confirmed.output).result.dataset, "large");
  assert.equal(confirmed.stopCalls, 1);
  const medium = await fakeRun({ config: measuredConfig({ dataset: "medium" }) });
  assert.equal((await medium.output).result.dataset, "medium");
});

test("phase failures prevent workload, stop once, and save redacted partial JSON", async () => {
  for (const phase of ["start", "reset", "seed", "correctness"] as const) {
    const run = await fakeRun({ phaseFailure: phase });
    await assert.rejects(run.output); assert.equal(run.workloadCalls, 0); assert.equal(run.stopCalls, 1);
    const text = await readFile(run.resultPath, "utf8"); assert.doesNotMatch(text, /hunter2|sekret|abc\.def\.ghi/); assert.match(text, /REDACTED|correctness checks failed/);
  }
});

test("failed correctness findings save bounded credential-safe partial JSON", async () => {
  const run = await fakeRun({ unsafeCorrectness: true });
  await assert.rejects(run.output, /correctness checks failed/); assert.equal(run.workloadCalls, 0); assert.equal(run.stopCalls, 1);
  const text = await readFile(run.resultPath, "utf8"); assert.doesNotMatch(text, /name-secret|finding-secret|evidence-secret/); assert.match(text, /REDACTED/);
});

test("resource invalidity and default runner overload invalidate measured stages", async () => {
  const unavailable = await fakeRun({ resources: async () => ({ samples: [snapshot()], valid: false, validityReasons: ["resource unavailable"] }) });
  const unavailableOutput = await unavailable.output; assert.equal(unavailableOutput.result.stages[0]!.valid, false); assert.match(unavailableOutput.result.stages[0]!.validityReasons.join(" "), /resource unavailable/);
  const overloaded = await fakeRun({ resources: async () => ({ samples: [snapshot(91, 1), snapshot(91, 2), snapshot(91, 3)], valid: true, validityReasons: [] }) });
  const overloadedOutput = await overloaded.output; assert.equal(overloadedOutput.result.stages[0]!.valid, false); assert.match(overloadedOutput.result.stages[0]!.validityReasons.join(" "), /cpuPercent sustained above threshold/);
});

test("checkpoints the actual run partial through correctness and stages, then removes it after final publish", async () => {
  const writes: Array<{ path: string; text: string; flag: string }> = [];
  const run = await fakeRun({
    write: async (path, text, options) => { writes.push({ path, text, flag: options.flag }); await writeFile(path, text, { encoding: "utf8", mode: 0o600, flag: options.flag }); },
    workload: async opts => { opts.onSample?.({ type: "workflow", name: "dashboard", workflow: "dashboard", operationClass: "read", kind: "read", elapsedMs: 1, success: true }); return summary(opts.users.length); },
  });
  const output = await run.output;
  const partialWrites = writes.filter(item => item.path.includes(".partial.json"));
  assert.equal(partialWrites.length >= 2, true);
  const checkpointResults = partialWrites.map(item => JSON.parse(item.text));
  assert.equal(checkpointResults.some(value => value.stages.length === 0 && value.correctness.findings.length > 0), true);
  assert.equal(checkpointResults.some(value => value.stages.length === 1 && value.resources.length === 1 && value.capacity), true);
  assert.ok(run.events.indexOf("stop") >= 0); assert.equal(existsSync(run.resultPath), true);
  assert.deepEqual(JSON.parse(await readFile(run.resultPath, "utf8")), output.result);
  assert.equal(writes.every(item => item.flag === "wx"), true);
  assert.doesNotMatch(writes.map(item => item.text).join("\n"), /password|hunter2|secret|Bearer/i);
  const partialPath = (await import("node:fs/promises")).readdir(run.dir).then(files => files.find(file => file.endsWith(".partial.json")));
  assert.equal(await partialPath, undefined);
});

test("does not publish the final result until backend cleanup and retains a stop-failure partial", async () => {
  let finalExistsAtStop: boolean | undefined;
  const run = await fakeRun({ stopFailure: true, onStop: path => { finalExistsAtStop = existsSync(path); } });
  await assert.rejects(run.output, /stop failed/);
  assert.equal(finalExistsAtStop, false);
  const saved = JSON.parse(await readFile(run.resultPath, "utf8")); assert.equal(saved.valid, false); assert.deepEqual(saved.failures, ["stop failed"]); assert.match(saved.validityReasons.join(" "), /backend stop failed/);
  const partialName = (await import("node:fs/promises")).readdir(run.dir).then(files => files.find(file => file.endsWith(".partial.json")));
  const partial = await partialName; assert.ok(partial); const partialResult = JSON.parse(await readFile(join(run.dir, partial), "utf8")); assert.deepEqual(partialResult.failures, ["stop failed"]);
});

test("retains the latest actual partial when final publication fails", async () => {
  const run = await fakeRun({ write: async (path, text, options) => { if (path.includes("result.json.tmp-")) throw new Error("publish failed"); await writeFile(path, text, { encoding: "utf8", mode: 0o600, flag: options.flag }); } });
  await assert.rejects(run.output, /publish failed/); assert.equal(existsSync(run.resultPath), false);
  const files = await (await import("node:fs/promises")).readdir(run.dir); const partialName = files.find(file => file.endsWith(".partial.json")); assert.ok(partialName);
  const partialResult = JSON.parse(await readFile(join(run.dir, partialName!), "utf8")); assert.equal(partialResult.valid, true); assert.equal(partialResult.stages.length, 1);
});

test("creates result temporary files exclusively", async () => {
  let flag: string | undefined;
  const run = await fakeRun({ write: async (path, text, options) => { flag = options.flag; await writeFile(path, text, { encoding: "utf8", mode: 0o600, flag: options.flag }); } });
  await run.output; assert.equal(flag, "wx");
});

test("settings are effective, recorded, and final disk result matches return value", async () => {
  let resourceOptions: any;
  const run = await fakeRun({ overloadThresholds: { cpuPercent: 80 }, resources: async opts => { resourceOptions = opts; return { samples: [snapshot()], valid: true, validityReasons: [] }; } });
  const output = await run.output; const saved = JSON.parse(await readFile(run.resultPath, "utf8"));
  assert.deepEqual(saved, output.result); assert.equal(output.result.valid, true); assert.equal(output.result.capacity.users, 1);
  assert.deepEqual(output.result.settings.overloadThresholds, { cpuPercent: 80, p99Ms: 100, maxMs: 250, consecutiveSamples: 3 });
  assert.equal(output.result.settings.maxLatencySamples, 2_000_000); assert.equal(output.result.settings.maxErrorExamples, 100); assert.equal(resourceOptions.intervalMs, output.result.settings.resourceIntervalMs); assert.equal(resourceOptions.maxSamples, output.result.settings.resourceMaxSamples.value);
});

test("PID changes and post-stage doctor failures invalidate rather than silently score", async () => {
  let calls = 0;
  const changed = await fakeRun({ doctor: async () => { calls++; return calls === 5 ? info([202]) : info(); } });
  const changedOutput = await changed.output; assert.equal(changedOutput.result.stages[0]!.valid, false); assert.match(changedOutput.result.stages[0]!.validityReasons.join(" "), /identity.*changed|process.*changed/i);
  calls = 0;
  const unhealthy = await fakeRun({ doctor: async () => { calls++; if (calls === 6) throw new Error("Authorization: Bearer stage-secret"); return info(); } });
  const unhealthyOutput = await unhealthy.output; assert.equal(unhealthyOutput.result.stages[0]!.valid, false); assert.match(unhealthyOutput.result.stages[0]!.validityReasons.join(" "), /post-stage.*failed|health.*failed/i); assert.doesNotMatch(JSON.stringify(unhealthyOutput.result), /stage-secret/);
});

test("configured stages after a conclusive failure are not executed", async () => {
  const requested: number[] = [];
  const run = await fakeRun({ config: measuredConfig({ concurrency: [1, 10, 20, 40], maxConcurrency: 40 }), workload: async opts => {
    if (opts.onSample) {
      const users = opts.users.length; requested.push(users);
      opts.onSample({ type: "workflow", name: "dashboard", workflow: "dashboard", operationClass: "read", kind: "read", elapsedMs: users === 10 ? 2000 : 1, success: true });
    }
    return summary(opts.users.length);
  } });
  const output = await run.output;
  assert.ok(requested.includes(1)); assert.ok(requested.includes(10));
  assert.ok(!requested.includes(20)); assert.ok(!requested.includes(40));
  assert.deepEqual(output.result.stages.map(stage => stage.requestedUsers), [1, 5, 10]);
});

test("schedule runs configured stages, extends after passes, stops at failure, and refines once", async () => {
  const requested: number[] = [];
  const run = await fakeRun({ config: measuredConfig({ concurrency: [1, 4], maxConcurrency: 16 }), workload: async opts => { const users = opts.users.length; if (opts.onSample) { requested.push(users); opts.onSample({ type: "workflow", name: "dashboard", workflow: "dashboard", operationClass: "read", kind: "read", elapsedMs: users === 16 ? 2000 : 1, success: true }); } return summary(users); } });
  const output = await run.output;
  assert.deepEqual(requested, [1, 4, 8, 16, 12]);
  assert.deepEqual(output.result.stages.map(stage => stage.requestedUsers), [1, 4, 8, 12, 16]);
  assert.equal(new Set(output.result.stages.map(stage => stage.requestedUsers)).size, output.result.stages.length); assert.equal(output.result.capacity.users, 12);
});

test("safeErrorMessage does not inspect arbitrary objects", () => {
  assert.equal(safeErrorMessage({ toString: () => "password=leak" }), "command failed");
});
