import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initClient } from "trailbase";
import { BenchmarkOperationError, runCorrectness } from "../src/correctness.js";
import { datasetProfiles } from "../src/seed.js";

const live = process.env.BENCH_LIVE === "1";
const denied = (error: unknown): boolean => error instanceof BenchmarkOperationError && error.classification === "authorization";

type LiveState = {
  dataDir: string;
  logFile: string;
  endpoint: string;
  modules: typeof import("../backends/trailbase/adapter.js");
  processModule: typeof import("../backends/trailbase/process.js");
};
let statePromise: Promise<LiveState> | undefined;

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Failed to allocate local test port"));
      server.close(error => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function liveState(): Promise<LiveState> {
  if (!statePromise) statePromise = (async () => {
    await mkdir(resolve(".data"), { recursive: true });
    const dataDir = await mkdtemp(resolve(".data/trailbase-live-"));
    const endpoint = `http://127.0.0.1:${await freePort()}`;
    process.env.TRAILBASE_DATA_DIR = dataDir;
    process.env.TRAILBASE_URL = endpoint;
    const [modules, processModule] = await Promise.all([
      import("../backends/trailbase/adapter.js"),
      import("../backends/trailbase/process.js"),
    ]);
    return { dataDir, logFile: join(dirname(dataDir), `${basename(dataDir)}.log`), endpoint, modules, processModule };
  })();
  return statePromise;
}

function processesFor(dataDir: string): string[] {
  return execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" }).split("\n").filter(line => line.includes("--depot") && line.includes(dataDir) && line.toLowerCase().includes("trail"));
}

async function assertStopped(state: LiveState): Promise<void> {
  assert.deepEqual((await state.modules.backend.doctor()).processIds, []);
  assert.deepEqual(processesFor(state.dataDir), []);
  await assert.rejects(fetch(`${state.endpoint}/api/auth/v1/login`, { signal: AbortSignal.timeout(750) }));
}

after(async () => {
  if (!statePromise) return;
  const state = await statePromise;
  await state.modules.backend.stop().catch(() => undefined);
  await rm(state.dataDir, { recursive: true, force: true });
  await rm(state.logFile, { force: true });
});

test("TrailBase live lifecycle, shared correctness, and tenant boundaries", { skip: live ? false : "set BENCH_LIVE=1 to run", timeout: 600_000 }, async () => {
  const state = await liveState();
  const { backend, seedTrailBaseCorrectnessFixture } = state.modules;
  const { TrailBaseProcess, resolveTrailBaseOptions, LOCAL_BENCHMARK_PASSWORD, LOCAL_SETUP_PASSWORD } = state.processModule;
  try {
    const unowned = await mkdtemp(resolve(".data/trailbase-unowned-"));
    try {
      await writeFile(join(unowned, "do-not-delete"), "owned by someone else");
      const options = resolveTrailBaseOptions({ TRAILBASE_DATA_DIR: unowned, TRAILBASE_URL: `http://127.0.0.1:${await freePort()}` });
      await assert.rejects(new TrailBaseProcess(options).reset(), /ownership/);
      assert.equal(await readFile(join(unowned, "do-not-delete"), "utf8"), "owned by someone else");
    } finally { await rm(unowned, { recursive: true, force: true }); }

    const empty = await mkdtemp(resolve(".data/trailbase-empty-"));
    const emptyOptions = resolveTrailBaseOptions({ TRAILBASE_DATA_DIR: empty, TRAILBASE_URL: `http://127.0.0.1:${await freePort()}` });
    const emptyProcess = new TrailBaseProcess(emptyOptions);
    try {
      await emptyProcess.start();
      assert.match(await readFile(join(empty, "config.textproto"), "utf8"), /name: "profiles"/);
      assert.match(await readFile(join(empty, "migrations/main/U1787223330__canonical.sql"), "utf8"), /CREATE TABLE IF NOT EXISTS tasks/);
    } finally {
      await emptyProcess.stop();
      assert.deepEqual(processesFor(empty), []);
      await rm(empty, { recursive: true, force: true });
      await rm(emptyOptions.logFile, { force: true });
    }

    await backend.reset();
    assert.equal((await backend.doctor()).processIds?.length, 1);
    assert.match(await readFile(join(state.dataDir, "config.textproto"), "utf8"), /name: "tasks"/);
    assert.match(await readFile(join(state.dataDir, "migrations/main/U1787223330__canonical.sql"), "utf8"), /CREATE TABLE IF NOT EXISTS profiles/);
    await backend.stop();
    await assertStopped(state);
    await backend.start();

    const fixture = await seedTrailBaseCorrectnessFixture();
    const correctness = await runCorrectness(backend, fixture);
    assert.equal(correctness.aborted, false, correctness.abortReason);
    assert.deepEqual(correctness.findings.filter(finding => !finding.passed), []);
    assert.equal(correctness.findings.length, 15);

    const owner = await backend.createSession(fixture.owner);
    const admin = await backend.createSession(fixture.admin);
    const member = await backend.createSession(fixture.member);
    const outsider = await backend.createSession(fixture.outsider);
    try {
      await assert.rejects(outsider.getTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId: fixture.taskId!, comments: { page: 0, pageSize: 10 } }), denied);
      await assert.rejects(admin.updateMembershipRole({ organizationId: fixture.organizationId, membershipId: fixture.foreignMembershipId, role: "admin" }), denied);
      await assert.rejects(member.updateMembershipRole({ organizationId: fixture.organizationId, membershipId: fixture.adminMembershipId, role: "member" }), denied);
      await assert.rejects(owner.createTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, title: "bad assignee", description: "cross tenant", priority: "low", assigneeId: fixture.outsiderUserId }), denied);
      await assert.rejects(owner.updateTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId: fixture.taskId!, assigneeId: fixture.outsiderUserId }), denied);

      const delegated = await owner.createTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, title: "Delegated update", description: "owner created", priority: "low" });
      await member.updateTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId: delegated.id, title: "Member updated" });
      const delegatedActivity = (await member.dashboard({ organizationId: fixture.organizationId, projectId: fixture.projectId, activityPage: { page: 0, pageSize: 100 } })).recentActivity.find(activity => activity.subjectId === delegated.id && activity.action === "updated");
      assert.equal(delegatedActivity?.actorId, fixture.memberUserId);

      const task = await member.createTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, title: "Percent 100%_Done", description: "member created", priority: "low" });
      const wildcardDecoy = await member.createTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, title: "Percent 100XXDone", description: "decoy", priority: "low" });
      const search = await member.searchTasks({ organizationId: fixture.organizationId, projectId: fixture.projectId, query: "100%_Done", page: 0, pageSize: 10 });
      assert.deepEqual(search.items.map(item => item.id), [task.id]);
      assert.ok(!search.items.some(item => item.id === wildcardDecoy.id));
      await member.updateTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId: task.id, title: "activity updated" });
      const comment = await member.addComment({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId: task.id, body: "activity comment" });
      await member.updateComment({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId: task.id, commentId: comment.id, body: "activity comment updated" });

      const promoted = await admin.updateMembershipRole({ organizationId: fixture.organizationId, membershipId: fixture.memberMembershipId, role: "admin" });
      assert.equal(promoted.role, "admin");
      const restored = await admin.updateMembershipRole({ organizationId: fixture.organizationId, membershipId: fixture.memberMembershipId, role: "member" });
      assert.equal(restored.role, "member");

      const dashboard = await owner.dashboard({ organizationId: fixture.organizationId, projectId: fixture.projectId, activityPage: { page: 0, pageSize: 100 } });
      const actions = dashboard.recentActivity.filter(activity => activity.subjectId === task.id).map(activity => activity.action).sort();
      assert.deepEqual(actions, ["comment_updated", "commented", "created", "updated"]);
    } finally {
      await Promise.all([owner.close(), admin.close(), member.close(), outsider.close()]);
    }

    const directMember = initClient(state.endpoint);
    await directMember.login(fixture.member.email, fixture.member.password);
    try {
      const foreign = await directMember.records<Record<string, unknown>>("tasks").list({ filters: [{ column: "organizationId", op: "equal", value: fixture.secondOrganizationId }], pagination: { limit: 10, offset: 0 }, count: true });
      assert.deepEqual(foreign.records, []);
      await assert.rejects(directMember.records("tasks").create({ publicId: "fxbad0000000001", organizationId: fixture.secondOrganizationId, projectId: fixture.secondProjectId, creatorId: fixture.memberUserId, assigneeId: null, title: "bad", description: "bad", status: "todo", priority: "low", dueDate: null }), error => (error as { status?: number }).status === 403);
      const ownTask = await directMember.records<Record<string, unknown>>("tasks").list({ filters: [{ column: "publicId", op: "equal", value: fixture.taskId! }], pagination: { limit: 1, offset: 0 } });
      assert.equal(ownTask.records.length, 1);
      await assert.rejects(directMember.records("tasks").update(Number(ownTask.records[0]!.id), { assigneeId: fixture.outsiderUserId }));
      const ownMembership = await directMember.records<Record<string, unknown>>("memberships").list({ filters: [{ column: "publicId", op: "equal", value: fixture.memberMembershipId }], pagination: { limit: 1, offset: 0 } });
      await assert.rejects(directMember.records("memberships").update(Number(ownMembership.records[0]!.id), { role: "admin" }), error => (error as { status?: number }).status === 403);
      await assert.rejects(directMember.records("activities").create({ publicId: "fxbad0000000002", organizationId: fixture.organizationId, projectId: fixture.projectId, actorId: fixture.memberUserId, action: "bad", subjectType: "task", subjectId: fixture.taskId }));
    } finally { await directMember.logout(); }

    const db = new DatabaseSync(join(state.dataDir, "data/main.db"), { readOnly: true });
    try {
      const auth = db.prepare("SELECT email, unverified_email, admin FROM _user WHERE email LIKE ? ORDER BY email").all(`%${"@trailbase.bench.test"}`) as { email: string; unverified_email: string | null; admin: number }[];
      assert.equal(auth.length, 5);
      assert.ok(auth.every(user => user.unverified_email === null));
      assert.equal(auth.find(user => user.email === "setup@trailbase.bench.test")?.admin, 1);
    } finally { db.close(); }

    const log = await readFile(state.logFile, "utf8");
    assert.doesNotMatch(log, new RegExp(LOCAL_SETUP_PASSWORD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(log, new RegExp(LOCAL_BENCHMARK_PASSWORD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(log, /password:\s*\[REDACTED\]/i);
  } finally {
    await backend.stop();
    await assertStopped(state);
  }
});

test("TrailBase full small seed clears repeatably and verifies auth plus table counts", { skip: live && process.env.BENCH_LIVE_SEED === "1" ? false : "set BENCH_LIVE=1 BENCH_LIVE_SEED=1 to run", timeout: 1_800_000 }, async () => {
  const state = await liveState();
  try {
    await state.modules.backend.reset();
    const profile = { name: "small" as const, definition: { ...datasetProfiles.small } };
    await state.modules.backend.seed(profile, 42);
    await state.modules.backend.seed(profile, 42);
  } finally {
    await state.modules.backend.stop();
    await assertStopped(state);
  }
});
