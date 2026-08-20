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
  const summary = await runWorkload(backend, { ...config, weights }, { users: [user(backend)], durationMs: 20, graceMs: 0, now: () => ++clock, sleep: async milliseconds => { if (milliseconds === 20) await new Promise<void>(() => {}); } });
  assert.equal(summary.failedWorkflowCount, 0);
  assert.ok(backend.sessions >= 2);
  assert.equal(backend.closedSessions, backend.sessions);
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
        queueMicrotask(release);
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
    sleep: async milliseconds => {
      if (milliseconds === 100) while (ownerCalls === 0) await Promise.resolve();
    },
  });
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

test("authentication resolving after grace expiry is still closed", async () => {
  const backend = createFakeBackend();
  const baseCreate = backend.createSession;
  let resolveAuth!: (session: Awaited<ReturnType<typeof baseCreate>>) => void;
  backend.createSession = credentials => new Promise(resolve => { resolveAuth = resolve; void credentials; });
  const weights = { ...config.weights, dashboard: 100, taskList: 0, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 };
  let clock = 0;
  const stage = await runWorkload(backend, { ...config, weights }, { users: [user(backend)], durationMs: 100, graceMs: 0, now: () => ++clock, sleep: async () => {} });
  assert.equal(stage.graceExpired, true);
  assert.equal(backend.closedSessions, 0);
  const lateSession = await baseCreate(backend.fixture.owner);
  resolveAuth(lateSession);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(backend.closedSessions, 1);
});

test("malformed task enums fail the journey instead of completing it", async () => {
  const backend = createFakeBackend({ malformedEnum: "task-status" });
  const weights = { ...config.weights, dashboard: 0, taskList: 100, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 };
  let clock = 0;
  const summary = await runWorkload(backend, { ...config, weights }, { users: [user(backend)], durationMs: 100, graceMs: 0, now: () => ++clock, sleep: async milliseconds => { if (milliseconds === 100) await new Promise<void>(() => {}); } });
  assert.ok(summary.failedWorkflowCount > 0);
  assert.equal(summary.stageFailed, true);
});

test("malformed pages, missing fields, nested users, and inconsistent hasNext fail", async () => {
  const cases: Array<{ name: string; backend: ReturnType<typeof createFakeBackend>; weights: typeof config.weights }> = [
    { name: "missing task field", backend: createFakeBackend({ malformedPage: true }), weights: { ...config.weights, dashboard: 0, taskList: 100, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 } },
  ];
  const nested = createFakeBackend();
  const nestedCreate = nested.createSession;
  nested.createSession = async credentials => {
    const session = await nestedCreate(credentials);
    const original = session.getTask;
    session.getTask = async input => {
      const value = await original(input);
      return { ...value, creator: { ...value.creator, email: "" } };
    };
    return session;
  };
  cases.push({ name: "nested user field", backend: nested, weights: { ...config.weights, dashboard: 0, taskList: 0, taskDetail: 100, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 } });
  const inconsistent = createFakeBackend();
  const inconsistentCreate = inconsistent.createSession;
  inconsistent.createSession = async credentials => {
    const session = await inconsistentCreate(credentials);
    const original = session.listTasks;
    session.listTasks = async input => ({ ...(await original(input)), hasNext: true });
    return session;
  };
  cases.push({ name: "hasNext consistency", backend: inconsistent, weights: { ...config.weights, dashboard: 0, taskList: 100, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 } });
  for (const item of cases) {
    let clock = 0;
    const summary = await runWorkload(item.backend, { ...config, weights: item.weights }, { users: [user(item.backend)], durationMs: 100, graceMs: 0, now: () => ++clock, sleep: async milliseconds => { if (milliseconds === 100) await new Promise<void>(() => {}); } });
    assert.ok(summary.failedWorkflowCount > 0, item.name);
    assert.equal(summary.stageFailed, true, item.name);
  }
});

test("samples expose exact operation dimensions and failures", async () => {
  const backend = createFakeBackend();
  const samples: any[] = [];
  const weights = { ...config.weights, dashboard: 100, taskList: 0, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 };
  let clock = 0;
  await runWorkload(backend, { ...config, weights }, { users: [user(backend)], durationMs: 100, graceMs: 0, now: () => ++clock, sleep: async milliseconds => { if (milliseconds === 100) await new Promise<void>(() => {}); }, onSample: sample => samples.push(sample) });
  const sdk = samples.find(sample => sample.type === "sdk" && sample.name === "dashboard" && sample.success);
  const workflow = samples.find(sample => sample.type === "workflow" && sample.workflow === "dashboard" && sample.success);
  assert.deepEqual({ kind: sdk.kind, operationClass: sdk.operationClass, success: sdk.success }, { kind: "read", operationClass: "read", success: true });
  assert.deepEqual({ name: workflow.name, kind: workflow.kind, operationClass: workflow.operationClass }, { name: "dashboard", kind: "read", operationClass: "read" });

  const failing = createFakeBackend();
  const baseCreate = failing.createSession;
  failing.createSession = async credentials => {
    const session = await baseCreate(credentials);
    session.dashboard = async () => { throw new Error("deterministic dashboard failure"); };
    return session;
  };
  const failures: any[] = [];
  clock = 0;
  await runWorkload(failing, { ...config, weights }, { users: [user(failing)], durationMs: 100, graceMs: 0, now: () => ++clock, sleep: async milliseconds => { if (milliseconds === 100) await new Promise<void>(() => {}); }, onSample: sample => failures.push(sample) });
  const sdkFailure = failures.find(sample => sample.type === "sdk" && sample.name === "dashboard" && !sample.success);
  assert.equal(sdkFailure.workflow, "dashboard");
  assert.equal(sdkFailure.kind, "read");
  assert.equal(sdkFailure.operationClass, "read");
  assert.match(sdkFailure.error.message, /deterministic/);
});

test("each virtual user keeps its random stream when concurrency changes", async () => {
  const weights = { ...config.weights, dashboard: 50, taskList: 50, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 };
  const trace = async (count: number): Promise<string[]> => {
    const backend = createFakeBackend();
    const ownerTrace: string[] = [];
    const baseCreate = backend.createSession;
    backend.createSession = async credentials => {
      const session = await baseCreate(credentials);
      const dashboard = session.dashboard;
      session.dashboard = async input => { if (credentials.email === backend.fixture.owner.email) ownerTrace.push("dashboard"); return dashboard(input); };
      const listTasks = session.listTasks;
      session.listTasks = async input => { if (credentials.email === backend.fixture.owner.email) ownerTrace.push("taskList"); return listTasks(input); };
      return session;
    };
    let clock = 0;
    const users = [user(backend), { ...user(backend), credentials: backend.fixture.member }].slice(0, count);
    await runWorkload(backend, { ...config, weights }, { users, durationMs: 100, graceMs: 0, now: () => ++clock, sleep: async milliseconds => { if (milliseconds === 100) await new Promise<void>(() => {}); } });
    return ownerTrace;
  };
  const one = await trace(1);
  const two = await trace(2);
  assert.ok(one.length > 0 && two.length > 0);
  const common = Math.min(one.length, two.length);
  assert.deepEqual(two.slice(0, common), one.slice(0, common));
});

test("invalid selection weights and page-size ceiling are rejected", () => {
  assert.throws(() => selectWorkflow({ ...config.weights, dashboard: 19 }, () => 0.1), /100/);
  assert.throws(() => selectWorkflow({ ...config.weights, dashboard: -1 }, () => 0.1), /weight/);
  assert.ok(config.thinkTimeMs.min <= config.thinkTimeMs.max);
});
