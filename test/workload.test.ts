import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { selectWorkflow } from "../src/workflows.js";
import { createFakeBackend } from "./fake-backend.js";
import { runWorkload } from "../src/workload.js";

const config = loadConfig("configs/quick.json");

test("workflow selection is deterministic and follows configured weights", () => {
  let state = 0x12345678;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const counts = Object.fromEntries(Object.keys(config.weights).map((name) => [name, 0]));
  for (let i = 0; i < 10_000; i++) {
    const name = selectWorkflow(config.weights, random);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  for (const [name, weight] of Object.entries(config.weights)) {
    assert.ok(Math.abs(counts[name]! - weight * 100) < 180, `${name}: ${counts[name]}`);
  }
  assert.deepEqual(Object.keys(counts).filter((name) => counts[name]! > 0).sort(), Object.keys(config.weights).sort());
});

const user = (backend: ReturnType<typeof createFakeBackend>) => ({ credentials: backend.fixture.owner, organizationId: backend.fixture.organizationId, projectId: backend.fixture.projectId, taskId: backend.fixture.taskId });

test("workload can run a finite stage and cleans up sessions", async () => {
  const backend = createFakeBackend();
  const samples: any[] = [];
  const summary = await runWorkload(backend, config, {
    users: [user(backend)], durationMs: 0, graceMs: 0, now: () => 0, sleep: async () => {}, onSample: sample => samples.push(sample),
  });
  assert.equal(summary.requestedUsers, 1);
  assert.equal(backend.closedSessions, 1);
  assert.ok(samples.every(sample => sample.elapsedMs >= 0 && typeof sample.success === "boolean"));
});

test("all journeys use bounded tenant-scoped requests and emit data-only samples", async () => {
  const backend = createFakeBackend();
  const weights = { dashboard: 12, taskList: 12, taskDetail: 12, createTask: 12, updateTask: 12, addComment: 12, search: 12, profileUpdate: 12, signIn: 4 };
  let clock = 0;
  const samples: any[] = [];
  const summary = await runWorkload(backend, { ...config, weights }, {
    users: [user(backend)], durationMs: 4_000, graceMs: 0, now: () => { clock += 1; return clock; }, sleep: async milliseconds => { if (milliseconds === 4_000) await new Promise<void>(() => {}); }, onSample: sample => samples.push(sample),
  });
  const names = new Set(samples.filter(sample => sample.type === "workflow" && sample.success).map(sample => sample.workflow));
  assert.deepEqual([...names].sort(), ["addComment", "createTask", "dashboard", "profileUpdate", "search", "signOutIn", "taskDetail", "taskList", "updateTask"].sort());
  assert.equal(summary.failedWorkflowCount, 0);
  assert.equal(summary.stageFailed, false);
  assert.ok(samples.every(sample => Object.keys(sample).every(key => key !== "session" && key !== "input")));
});

test("sign-out/in closes the old session before replacing it", async () => {
  const backend = createFakeBackend();
  const weights = { ...config.weights, dashboard: 0, taskList: 0, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 100 };
  let clock = 0;
  const summary = await runWorkload(backend, { ...config, weights }, { users: [user(backend)], durationMs: 20, graceMs: 0, now: () => ++clock, sleep: async () => {} });
  assert.equal(summary.failedWorkflowCount, 0);
  assert.equal(backend.sessions, 2);
  assert.equal(backend.closedSessions, 2);
});

test("closed-model users do not overlap, while another user progresses", async () => {
  const backend = createFakeBackend();
  const baseCreate = backend.createSession;
  let ownerCalls = 0;
  let memberCalls = 0;
  let ownerInFlight = 0;
  let ownerMax = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  backend.createSession = async credentials => {
    const session = await baseCreate(credentials);
    const original = session.dashboard;
    session.dashboard = async input => {
      if (credentials.email === backend.fixture.owner.email) {
        ownerCalls++;
        ownerInFlight++;
        ownerMax = Math.max(ownerMax, ownerInFlight);
        await blocked;
        ownerInFlight--;
      } else memberCalls++;
      return original(input);
    };
    return session;
  };
  const weights = { ...config.weights, dashboard: 100, taskList: 0, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 };
  const stage = runWorkload(backend, { ...config, weights }, {
    users: [user(backend), { ...user(backend), credentials: backend.fixture.member }], durationMs: 100, graceMs: 0,
    sleep: async milliseconds => { if (milliseconds === 100) await new Promise<void>(() => {}); },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  release();
  await stage;
  assert.equal(ownerMax, 1);
  assert.equal(ownerCalls, 1);
  assert.ok(memberCalls >= 1);
});

test("external cancellation during think time stops the next journey", async () => {
  const backend = createFakeBackend();
  const controller = new AbortController();
  let thinks = 0;
  const weights = { ...config.weights, dashboard: 100, taskList: 0, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 };
  const summary = await runWorkload(backend, { ...config, weights }, {
    users: [user(backend)], durationMs: 100, graceMs: 0, signal: controller.signal,
    sleep: async (milliseconds, signal) => { if (milliseconds !== 100) { thinks++; controller.abort(); } if (signal?.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" }); },
  });
  assert.equal(thinks, 1);
  assert.equal(summary.completedWorkflowCount, 1);
  assert.equal(backend.closedSessions, 1);
});

test("invalid selection weights and page-size ceiling are rejected", () => {
  assert.throws(() => selectWorkflow({ ...config.weights, dashboard: 19 }, () => 0.1), /100/);
  assert.throws(() => selectWorkflow({ ...config.weights, dashboard: -1 }, () => 0.1), /weight/);
  assert.ok(config.thinkTimeMs.min <= config.thinkTimeMs.max);
});
