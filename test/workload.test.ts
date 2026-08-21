import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseConfig } from "../src/config.js";
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

test("already-aborted workloads do not authenticate users", async () => {
  const backend = createFakeBackend();
  const controller = new AbortController();
  controller.abort();
  const summary = await runWorkload(backend, config, { users: [user(backend)], signal: controller.signal, durationMs: 100, graceMs: 0, now: () => 0, sleep: async () => {} });
  assert.equal(summary.startedUsers, 0);
  assert.equal(backend.sessions, 0);
});

test("fractional validated weights are selectable", () => {
  const raw = JSON.parse(JSON.stringify(config)) as any;
  raw.weights.dashboard = 12.5;
  raw.weights.taskList = 32.5;
  const fractional = parseConfig(raw);
  assert.equal(selectWorkflow(fractional.weights, () => 0.1), "dashboard");
  assert.equal(selectWorkflow(fractional.weights, () => 0.2), "taskList");
});

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

test("stage deadline gives an in-flight workflow grace before transport cancellation", async () => {
  const backend = createFakeBackend();
  const baseCreate = backend.createSession;
  let started = false;
  let cancelCalls = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  backend.createSession = async credentials => {
    const session = await baseCreate(credentials);
    const dashboard = session.dashboard;
    session.dashboard = async input => { started = true; await pending; return dashboard(input); };
    session.cancelPending = () => { cancelCalls++; release(); };
    return session;
  };
  const weights = { ...config.weights, dashboard: 100, taskList: 0, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 };
  const summary = await runWorkload(backend, { ...config, weights }, {
    users: [user(backend)], durationMs: 10, graceMs: 20, now: () => 0,
    sleep: async milliseconds => {
      if (milliseconds === 10) while (!started) await Promise.resolve();
      if (milliseconds === 20) { release(); await new Promise<void>(() => {}); }
    },
  });
  assert.equal(cancelCalls, 0);
  assert.equal(summary.completedWorkflowCount, 1);
  assert.equal(summary.failedWorkflowCount, 0);
  assert.equal(summary.graceExpired, false);
  assert.equal(summary.stageFailed, false);
});

test("grace expiry cancels an in-flight workflow before cleanup", async () => {
  const backend = createFakeBackend();
  const baseCreate = backend.createSession;
  let started = false;
  let graceStarted = false;
  let cancelledBeforeGrace = false;
  let operationSettled = false;
  let measuredEnded = false;
  let samplesAfterMeasurement = 0;
  let cancelCalls = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  backend.createSession = async credentials => {
    const session = await baseCreate(credentials);
    session.dashboard = async () => {
      started = true;
      try { await pending; throw Object.assign(new Error("cancelled"), { name: "AbortError" }); }
      finally { operationSettled = true; }
    };
    session.cancelPending = () => { cancelCalls++; if (!graceStarted) cancelledBeforeGrace = true; release(); };
    return session;
  };
  const weights = { ...config.weights, dashboard: 100, taskList: 0, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 };
  const summary = await runWorkload(backend, { ...config, weights }, {
    users: [user(backend)], durationMs: 10, graceMs: 20, now: () => 0,
    sleep: async milliseconds => {
      if (milliseconds === 10) while (!started) await Promise.resolve();
      if (milliseconds === 20) graceStarted = true;
    },
    onSample: () => { if (measuredEnded) samplesAfterMeasurement++; },
    onMeasuredEnd: () => { assert.equal(operationSettled, true); measuredEnded = true; },
  });
  assert.equal(cancelledBeforeGrace, false);
  assert.equal(cancelCalls, 1);
  assert.equal(summary.graceExpired, true);
  assert.equal(summary.stageFailed, true);
  assert.equal(measuredEnded, true);
  assert.equal(samplesAfterMeasurement, 0);
  assert.equal(backend.closedSessions, 1);
});

test("prepares sessions in ordered batches of ten and measures only after preparation", async () => {
  const backend = createFakeBackend();
  const baseCreate = backend.createSession;
  const users = Array.from({ length: 21 }, (_, index) => ({ ...user(backend), credentials: { ...backend.fixture.owner, email: `user-${index}@bench.test` } }));
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  backend.createSession = async credentials => {
    calls.push(credentials.email);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>(resolve => queueMicrotask(resolve));
    inFlight--;
    return baseCreate(backend.fixture.owner);
  };
  let starts = 0;
  let ends = 0;
  const summary = await runWorkload(backend, config, { users, durationMs: 0, graceMs: 0, onMeasuredStart: () => { starts++; assert.equal(calls.length, 21); }, onMeasuredEnd: () => { ends++; } });
  assert.equal(maxInFlight, 10);
  assert.deepEqual(calls, users.map(item => item.credentials.email));
  assert.equal(starts, 1);
  assert.equal(ends, 1);
  assert.equal(summary.startedUsers, 21);
  assert.equal(backend.closedSessions, 21);
});

test("preparation failure stops later batches, closes successes, and emits no secret samples", async () => {
  const backend = createFakeBackend();
  const baseCreate = backend.createSession;
  const users = Array.from({ length: 21 }, (_, index) => ({ ...user(backend), credentials: { ...backend.fixture.owner, email: `user-${index}@bench.test` } }));
  const calls: string[] = [];
  backend.createSession = async credentials => {
    calls.push(credentials.email);
    if (credentials.email === "user-10@bench.test") throw new Error("password=secret payload");
    return baseCreate(backend.fixture.owner);
  };
  const samples: any[] = [];
  let starts = 0;
  const summary = await runWorkload(backend, config, { users, durationMs: 0, graceMs: 0, onSample: sample => samples.push(sample), onMeasuredStart: () => { starts++; } });
  assert.equal(summary.preparationFailed, true);
  assert.equal(summary.preparationFailureCount, 1);
  assert.equal(summary.stageFailed, true);
  assert.equal(summary.startedUsers, 0);
  assert.equal(calls.length, 20);
  assert.equal(backend.closedSessions, 19);
  assert.equal(starts, 0);
  assert.deepEqual(samples, []);
  assert.doesNotMatch(JSON.stringify(summary), /secret|payload|password/i);
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

test("boundary authentication is unmeasured while sign-out/in authentication is measured", async () => {
  const backend = createFakeBackend();
  const weights = { ...config.weights, dashboard: 0, taskList: 0, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 100 };
  let clock = 0;
  const samples: any[] = [];
  const summary = await runWorkload(backend, { ...config, weights }, { users: [user(backend)], durationMs: 20, graceMs: 0, now: () => ++clock, sleep: async milliseconds => { if (milliseconds === 20) await new Promise<void>(() => {}); }, onSample: sample => samples.push(sample) });
  assert.equal(summary.failedWorkflowCount, 0);
  assert.ok(samples.some(sample => sample.type === "sdk" && sample.name === "createSession"));
  assert.ok(samples.some(sample => sample.type === "sdk" && sample.name === "close"));
  assert.equal(samples.filter(sample => sample.type === "sdk" && sample.name === "createSession").length, backend.sessions - 1);
  assert.equal(backend.closedSessions, backend.sessions);
});

test("measurement end waits for blocked workers before cleanup", async () => {
  const backend = createFakeBackend();
  const baseCreate = backend.createSession;
  let release!: () => void;
  let blocked = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  backend.createSession = async credentials => {
    const session = await baseCreate(credentials);
    const dashboard = session.dashboard;
    session.dashboard = async input => { blocked = true; await pending; return dashboard(input); };
    return session;
  };
  const weights = { ...config.weights, dashboard: 100, taskList: 0, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 };
  let ended = 0;
  let settled = false;
  const stage = runWorkload(backend, { ...config, weights }, { users: [user(backend)], durationMs: 20, graceMs: 0, now: () => 0, sleep: async () => {}, onMeasuredEnd: () => { ended++; throw new Error("end failed"); } });
  for (let i = 0; i < 100 && !blocked; i++) await Promise.resolve();
  await Promise.resolve();
  void stage.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(blocked, true);
  assert.equal(settled, false);
  assert.equal(ended, 0);
  assert.equal(backend.closedSessions, 0);
  release();
  const summary = await stage;
  assert.equal(ended, 1);
  assert.equal(summary.stageFailed, true);
  assert.equal(backend.closedSessions, 1);
});

test("a failed measurement-start callback does not invoke measurement-end", async () => {
  const backend = createFakeBackend();
  let ended = 0;
  const summary = await runWorkload(backend, config, { users: [user(backend)], durationMs: 0, graceMs: 0, onMeasuredStart: () => { throw new Error("start failed"); }, onMeasuredEnd: () => { ended++; } });
  assert.equal(summary.stageFailed, true);
  assert.equal(ended, 0);
  assert.equal(backend.closedSessions, 1);
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
    sleep: async (milliseconds, signal) => { if (!controller.signal.aborted && milliseconds !== 100 && milliseconds !== 0) { thinks++; controller.abort(); } if (signal?.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" }); },
  });
  assert.equal(thinks, 1);
  assert.equal(summary.completedWorkflowCount, 1);
  assert.equal(backend.closedSessions, 1);
});

test("aborted preparation closes a late same-batch session without samples", async () => {
  const backend = createFakeBackend();
  const baseCreate = backend.createSession;
  let resolveAuth!: (session: Awaited<ReturnType<typeof baseCreate>>) => void;
  backend.createSession = credentials => new Promise(resolve => { resolveAuth = resolve; void credentials; });
  const controller = new AbortController();
  const samples: any[] = [];
  const stage = runWorkload(backend, config, { users: [user(backend)], signal: controller.signal, durationMs: 100, graceMs: 0, onSample: sample => samples.push(sample) });
  controller.abort();
  const lateSession = await baseCreate(backend.fixture.owner);
  resolveAuth(lateSession);
  const summary = await stage;
  assert.equal(summary.preparationFailed, true);
  assert.equal(summary.stageFailed, true);
  assert.equal(summary.startedUsers, 0);
  assert.equal(backend.closedSessions, 1);
  assert.equal(samples.length, 0);
});

test("unsafe page metadata fails the journey", async () => {
  const backend = createFakeBackend();
  const baseCreate = backend.createSession;
  backend.createSession = async credentials => {
    const session = await baseCreate(credentials);
    const original = session.listTasks;
    session.listTasks = async input => ({ ...(await original(input)), page: Number.MAX_SAFE_INTEGER + 1 });
    return session;
  };
  const weights = { ...config.weights, dashboard: 0, taskList: 100, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 };
  let clock = 0;
  const summary = await runWorkload(backend, { ...config, weights }, { users: [user(backend)], durationMs: 100, graceMs: 0, now: () => ++clock, sleep: async milliseconds => { if (milliseconds === 100) await new Promise<void>(() => {}); } });
  assert.ok(summary.failedWorkflowCount > 0);
  assert.equal(summary.stageFailed, true);
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
  const malformedProfile = createFakeBackend();
  const malformedProfileCreate = malformedProfile.createSession;
  malformedProfile.createSession = async credentials => {
    const session = await malformedProfileCreate(credentials);
    const original = session.updateProfile;
    session.updateProfile = async input => ({ ...(await original(input)), email: "" });
    return session;
  };
  cases.push({ name: "profile required fields", backend: malformedProfile, weights: { ...config.weights, dashboard: 0, taskList: 0, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 100, signIn: 0 } });
  for (const item of cases) {
    let clock = 0;
    const summary = await runWorkload(item.backend, { ...config, weights: item.weights }, { users: [user(item.backend)], durationMs: 100, graceMs: 0, now: () => ++clock, sleep: async milliseconds => { if (milliseconds === 100) await new Promise<void>(() => {}); } });
    assert.ok(summary.failedWorkflowCount > 0, item.name);
    assert.equal(summary.stageFailed, true, item.name);
  }
});

test("reauthenticated sessions are closed once without retaining old sessions", async () => {
  const backend = createFakeBackend();
  const weights = { ...config.weights, dashboard: 0, taskList: 0, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 100 };
  let clock = 0;
  const summary = await runWorkload(backend, { ...config, weights }, { users: [user(backend)], durationMs: 100, graceMs: 0, now: () => ++clock, sleep: async milliseconds => { if (milliseconds === 100) await new Promise<void>(() => {}); } });
  assert.ok(backend.sessions > 2);
  assert.equal(backend.closedSessions, backend.sessions);
  assert.equal(summary.stageFailed, false);
});

test("null task assignee remains valid while creator is required", async () => {
  const backend = createFakeBackend();
  const baseCreate = backend.createSession;
  backend.createSession = async credentials => {
    const session = await baseCreate(credentials);
    const original = session.getTask;
    session.getTask = async input => ({ ...(await original(input)), assignee: null });
    return session;
  };
  const weights = { ...config.weights, dashboard: 0, taskList: 0, taskDetail: 100, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 };
  let clock = 0;
  const summary = await runWorkload(backend, { ...config, weights }, { users: [user(backend)], durationMs: 100, graceMs: 0, now: () => ++clock, sleep: async milliseconds => { if (milliseconds === 100) await new Promise<void>(() => {}); } });
  assert.equal(summary.failedWorkflowCount, 0);
});

test("null task creator emits invalid-response SDK and workflow failures", async () => {
  const backend = createFakeBackend();
  const baseCreate = backend.createSession;
  backend.createSession = async credentials => {
    const session = await baseCreate(credentials);
    const original = session.getTask;
    session.getTask = async input => ({ ...(await original(input)), creator: null } as any);
    return session;
  };
  const weights = { ...config.weights, dashboard: 0, taskList: 0, taskDetail: 100, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 0 };
  const samples: any[] = [];
  let clock = 0;
  const summary = await runWorkload(backend, { ...config, weights }, { users: [user(backend)], durationMs: 100, graceMs: 0, now: () => ++clock, sleep: async milliseconds => { if (milliseconds === 100) await new Promise<void>(() => {}); }, onSample: sample => samples.push(sample) });
  assert.ok(summary.failedWorkflowCount > 0);
  assert.equal(summary.stageFailed, true);
  assert.ok(samples.some(sample => sample.type === "sdk" && sample.name === "getTask" && !sample.success && sample.error?.name === "Error"));
  assert.ok(samples.some(sample => sample.type === "workflow" && sample.workflow === "taskDetail" && !sample.success && sample.error?.message.includes("creator")));
});

test("measured close failure emits close and workflow failures without suppressing another user", async () => {
  const backend = createFakeBackend();
  const baseCreate = backend.createSession;
  let closeCalls = 0;
  backend.createSession = async credentials => {
    const session = await baseCreate(credentials);
    const close = session.close;
    session.close = async () => { closeCalls++; if (closeCalls === 1) throw new Error("measured close failed"); await close(); };
    return session;
  };
  const weights = { ...config.weights, dashboard: 0, taskList: 0, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 100 };
  const samples: any[] = [];
  const summary = await runWorkload(backend, { ...config, weights }, { users: [user(backend), { ...user(backend), credentials: backend.fixture.member }], durationMs: 20, graceMs: 0, sleep: async milliseconds => { if (milliseconds === 20) await new Promise<void>(() => {}); }, onSample: sample => samples.push(sample) });
  assert.equal(summary.stageFailed, true);
  assert.ok(samples.some(sample => sample.type === "sdk" && sample.name === "close" && !sample.success));
  assert.ok(samples.some(sample => sample.type === "workflow" && sample.workflow === "signOutIn" && !sample.success));
  assert.ok(samples.some(sample => sample.type === "workflow" && sample.workflow === "signOutIn" && sample.success));
});

test("close failures are retried during final cleanup", async () => {
  const backend = createFakeBackend();
  const baseCreate = backend.createSession;
  let closeCalls = 0;
  backend.createSession = async credentials => {
    const session = await baseCreate(credentials);
    const original = session.close;
    session.close = async () => { closeCalls++; if (closeCalls === 1) throw new Error("transient close"); await original(); };
    return session;
  };
  const weights = { ...config.weights, dashboard: 0, taskList: 0, taskDetail: 0, createTask: 0, updateTask: 0, addComment: 0, search: 0, profileUpdate: 0, signIn: 100 };
  let clock = 0;
  await runWorkload(backend, { ...config, weights }, { users: [user(backend)], durationMs: 0, graceMs: 0, now: () => ++clock, sleep: async () => {} });
  assert.ok(closeCalls >= 2);
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

test("five full-profile seed streams meet the publishable operation-class sample floor in virtual time", async () => {
  const full = loadConfig("configs/full.json");
  const counts = { read: 0, write: 0, authSearch: 0 };
  let workflows = 0;
  for (let index = 0; index < 5; index++) {
    const backend = createFakeBackend();
    const streamConfig = { ...full, seed: (full.seed + Math.imul(index, 0x9e3779b9)) >>> 0 };
    let clock = 0;
    await runWorkload(backend, streamConfig, {
      users: [user(backend)], durationMs: 300_000, graceMs: 5_000, now: () => clock,
      sleep: async (milliseconds, signal) => {
        if (milliseconds === 300_000) return new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
        clock += milliseconds;
      },
      onSample: sample => { if (sample.type === "workflow" && sample.success) { workflows++; counts[sample.operationClass]++; } },
    });
  }
  assert.equal(workflows, 491);
  assert.deepEqual(counts, { read: 304, write: 161, authSearch: 26 });
  assert.ok(Object.values(counts).every(count => count >= 20));
});

test("invalid selection weights and page-size ceiling are rejected", () => {
  assert.throws(() => selectWorkflow({ ...config.weights, dashboard: 19 }, () => 0.1), /100/);
  assert.throws(() => selectWorkflow({ ...config.weights, dashboard: -1 }, () => 0.1), /weight/);
  assert.ok(config.thinkTimeMs.min <= config.thinkTimeMs.max);
});
