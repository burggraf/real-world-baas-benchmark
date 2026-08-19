import test from "node:test";
import assert from "node:assert/strict";
import PocketBase, { ClientResponseError } from "pocketbase";
import { backend, seedPocketBaseCorrectnessFixture } from "../backends/pocketbase/adapter.js";
import { BenchmarkOperationError, runCorrectness } from "../src/correctness.js";
import { datasetProfiles } from "../src/seed.js";

const live = process.env.BENCH_LIVE === "1";
const denied = (error: unknown): boolean => error instanceof BenchmarkOperationError && error.classification === "authorization";

test("PocketBase live correctness", { skip: live ? false : "set BENCH_LIVE=1 to run" }, async (t) => {
  let started = false;
  try {
    await backend.reset();
    started = true;
    const fixture = await seedPocketBaseCorrectnessFixture();
    const result = await runCorrectness(backend, fixture);
    assert.equal(result.aborted, false, result.abortReason);
    assert.deepEqual(result.findings.filter((finding) => !finding.passed), []);

    await t.test("membership role updates bind the target to the input organization", async () => {
      const admin = await backend.createSession(fixture.admin);
      try {
        await assert.rejects(admin.updateMembershipRole({
          organizationId: fixture.organizationId,
          membershipId: fixture.foreignMembershipId,
          role: "admin",
        }), denied);
      } finally {
        await admin.close();
      }
    });

    await t.test("cross-tenant assignees are denied by adapter and API rules", async () => {
      const owner = await backend.createSession(fixture.owner);
      try {
        await assert.rejects(owner.createTask({
          organizationId: fixture.organizationId,
          projectId: fixture.projectId,
          title: "cross-tenant assignee",
          description: "must be denied",
          priority: "low",
          assigneeId: fixture.outsiderUserId,
        }), denied);
        await assert.rejects(owner.updateTask({
          organizationId: fixture.organizationId,
          projectId: fixture.projectId,
          taskId: fixture.taskId!,
          assigneeId: fixture.outsiderUserId,
        }), denied);
      } finally {
        await owner.close();
      }

      const direct = new PocketBase(process.env.POCKETBASE_URL || "http://127.0.0.1:8090");
      try {
        await direct.collection("users").authWithPassword(fixture.owner.email, fixture.owner.password);
        await assert.rejects(direct.collection("tasks").create({
          id: "fxbad0000000001",
          organization: fixture.organizationId,
          project: fixture.projectId,
          creator: direct.authStore.record!.id,
          assignee: fixture.outsiderUserId,
          title: "direct cross-tenant assignee",
          description: "must be denied by the API rule",
          status: "todo",
          priority: "low",
        }), (error: unknown) => error instanceof ClientResponseError && error.status === 400);
        await assert.rejects(direct.collection("tasks").update(fixture.taskId!, {
          assignee: fixture.outsiderUserId,
        }), (error: unknown) => error instanceof ClientResponseError && error.status === 404);
        await assert.rejects(direct.collection("organizations").update(fixture.organizationId, {
          owner: fixture.outsiderUserId,
        }), (error: unknown) => error instanceof ClientResponseError && error.status === 404);
      } finally {
        direct.authStore.clear();
        direct.cancelAllRequests();
      }
    });
  } finally {
    await backend.stop();
    if (started) {
      const info = await backend.doctor();
      assert.deepEqual(info.processIds, []);
      await assert.rejects(fetch(`${process.env.POCKETBASE_URL || "http://127.0.0.1:8090"}/api/health`));
    }
  }
});

test("PocketBase full small seed", {
  skip: live && process.env.BENCH_LIVE_SEED === "1" ? false : "set BENCH_LIVE=1 BENCH_LIVE_SEED=1 to run",
}, async () => {
  let started = false;
  try {
    await backend.reset();
    started = true;
    await backend.seed({ name: "small", definition: { ...datasetProfiles.small } }, 42);
  } finally {
    await backend.stop();
    if (started) assert.deepEqual((await backend.doctor()).processIds, []);
  }
});
