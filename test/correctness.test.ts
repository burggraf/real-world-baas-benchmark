import test from "node:test";
import assert from "node:assert/strict";
import { createFakeBackend } from "./fake-backend.js";
import { BenchmarkOperationError, runCorrectness } from "../src/correctness.js";

test("secure fake passes and insecure tenant isolation is found", async () => {
  const insecure = createFakeBackend({ insecureTenantIsolation: true });
  const bad = await runCorrectness(insecure, insecure.fixture);
  assert.equal(bad.findings.find((x) => x.name === "outsider-read-isolated")?.passed, false);

  const secure = createFakeBackend();
  const good = await runCorrectness(secure, secure.fixture);
  assert.equal(good.aborted, false);
  assert.equal(good.findings.some((x) => !x.passed), false);
  assert.equal(new Set(good.findings.map((x) => x.name)).size, good.findings.length);
  assert.equal(secure.closedSessions, 4);
});

test("accepted invalid sign-in closes the returned session", async () => {
  const backend = createFakeBackend({ acceptInvalidLogin: true });
  const result = await runCorrectness(backend, backend.fixture);
  assert.equal(result.findings.find((x) => x.name === "invalid-sign-in")?.passed, false);
  assert.equal(backend.closedSessions, 5);
});

test("malformed data is classified and later checks continue", async () => {
  const backend = createFakeBackend({ failures: { malformed: 1 } });
  const result = await runCorrectness(backend, backend.fixture);
  assert.ok(result.findings.some((x) => x.classification === "invalid_response"));
  assert.ok(result.findings.some((x) => x.name === "required-data"));
});

test("backend health loss aborts", async () => {
  const backend = createFakeBackend({ failures: { backend_health: 1 } });
  const result = await runCorrectness(backend, backend.fixture);
  assert.equal(result.aborted, true);
  assert.ok(result.findings.length < 12);
});

test("application and timeout failures are classified while later checks continue", async () => {
  for (const kind of ["application", "timeout"] as const) {
    const backend = createFakeBackend({ failures: { [kind]: 1 } });
    const result = await runCorrectness(backend, backend.fixture);
    assert.ok(result.findings.some((x) => x.classification === kind));
    assert.ok(result.findings.some((x) => x.name === "required-data"));
  }
});

test("authentication failure is classified and suite continues", async () => {
  const backend = createFakeBackend({ failures: { authentication: 1 } });
  const result = await runCorrectness(backend, backend.fixture);
  assert.equal(result.findings[0]?.classification, "authentication");
  assert.ok(result.findings.some((x) => x.name === "required-data"));
});

test("mismatched membership organization is denied", async () => {
  const backend = createFakeBackend();
  const session = await backend.createSession(backend.fixture.owner);
  await assert.rejects(
    session.updateMembershipRole({
      organizationId: backend.fixture.organizationId,
      membershipId: backend.fixture.foreignMembershipId,
      role: "admin",
    }),
    (error: unknown) => error instanceof BenchmarkOperationError && error.classification === "authorization",
  );
  await session.close();
});

test("pagination preserves one stable combined order", async () => {
  const backend = createFakeBackend();
  const session = await backend.createSession(backend.fixture.owner);
  await session.createTask({
    organizationId: backend.fixture.organizationId,
    projectId: backend.fixture.projectId,
    title: "second",
    description: "second",
    priority: "low",
  });
  const first = await session.listTasks({ organizationId: backend.fixture.organizationId, projectId: backend.fixture.projectId, page: 0, pageSize: 1 });
  const second = await session.listTasks({ organizationId: backend.fixture.organizationId, projectId: backend.fixture.projectId, page: 1, pageSize: 1 });
  const combined = await session.listTasks({ organizationId: backend.fixture.organizationId, projectId: backend.fixture.projectId, page: 0, pageSize: 10 });
  const repeat = await session.listTasks({ organizationId: backend.fixture.organizationId, projectId: backend.fixture.projectId, page: 0, pageSize: 10 });
  const ids = [...first.items, ...second.items].map((task) => task.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, combined.items.map((task) => task.id));
  assert.deepEqual(combined.items.map((task) => task.id), repeat.items.map((task) => task.id));
  await session.close();
});

test("task and comment updates return semantic records", async () => {
  const backend = createFakeBackend();
  const session = await backend.createSession(backend.fixture.owner);
  const task = await session.createTask({
    organizationId: backend.fixture.organizationId,
    projectId: backend.fixture.projectId,
    title: "before",
    description: "description",
    priority: "low",
  });
  const updatedTask = await session.updateTask({
    organizationId: backend.fixture.organizationId,
    projectId: backend.fixture.projectId,
    taskId: task.id,
    title: "after",
  });
  assert.equal(updatedTask.id, task.id);
  assert.equal(updatedTask.projectId, task.projectId);
  assert.equal(updatedTask.creatorId, task.creatorId);
  assert.equal(updatedTask.createdAt, task.createdAt);
  assert.ok(updatedTask.updatedAt);

  const comment = await session.addComment({ organizationId: backend.fixture.organizationId, projectId: backend.fixture.projectId, taskId: task.id, body: "before" });
  const updatedComment = await session.updateComment({ organizationId: backend.fixture.organizationId, projectId: backend.fixture.projectId, taskId: task.id, commentId: comment.id, body: "after" });
  assert.equal(updatedComment.id, comment.id);
  assert.equal(updatedComment.taskId, task.id);
  assert.equal(updatedComment.authorId, comment.authorId);
  assert.equal(updatedComment.body, "after");
  assert.ok(updatedComment.createdAt);
  assert.ok(updatedComment.updatedAt);
  const detail = await session.getTask({ organizationId: backend.fixture.organizationId, projectId: backend.fixture.projectId, taskId: task.id, comments: { page: 0, pageSize: 10 } });
  assert.equal(detail.comments.items.find((item) => item.id === comment.id)?.body, "after");
  await session.close();
});

test("results never contain passwords", async () => {
  const backend = createFakeBackend();
  const result = await runCorrectness(backend, backend.fixture);
  const text = JSON.stringify(result);
  assert.equal(text.includes("owner-pass"), false);
  assert.equal(text.includes("member-pass"), false);
});
