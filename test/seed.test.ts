import { strict as assert } from "node:assert";
import test from "node:test";
import { mulberry32 } from "../src/random.js";
import { datasetProfiles, entityId, profileMetadata, seedDataset } from "../src/seed.js";

test("Mulberry32 has the documented deterministic sequence", () => {
  const a = mulberry32(42), b = mulberry32(42);
  assert.deepEqual([a(), a(), a()], [0.6011037519201636, 0.44829055899754167, 0.8524657934904099]);
  assert.deepEqual([b(), b(), b()], [0.6011037519201636, 0.44829055899754167, 0.8524657934904099]);
});

test("all profile metadata includes memberships without enumerating data", () => {
  assert.deepEqual(profileMetadata.small, { ...datasetProfiles.small, memberships: 1_000 });
  assert.deepEqual(profileMetadata.medium, { ...datasetProfiles.medium, memberships: 10_000 });
  assert.deepEqual(profileMetadata.large, { ...datasetProfiles.large, memberships: 100_000 });
});

test("small profile streams bounded batches in dependency order", async () => {
  const order: string[] = [], counts = new Map<string, number>();
  let total = 0, finalSize = 0, finalActivity: any;
  for await (const batch of seedDataset("small", 42, 333)) {
    if (order.at(-1) !== batch.entity) order.push(batch.entity);
    assert.ok(batch.records.length <= 333);
    finalSize = batch.records.length; total += batch.records.length;
    if (batch.entity === "activity") finalActivity = batch.records.at(-1);
    counts.set(batch.entity, (counts.get(batch.entity) ?? 0) + batch.records.length);
    const record = batch.records[0] as unknown as Record<string, unknown>;
    for (const key of ["organizationId", "userId", "projectId", "taskId", "creatorId", "authorId", "actorId", "subjectId"]) {
      const value = record[key];
      if (typeof value === "string") assert.match(value, /^[a-z]+-[0-9a-z]{8}$/);
    }
  }
  assert.deepEqual(order, ["user", "organization", "membership", "project", "task", "comment", "activity"]);
  assert.deepEqual([...counts.values()], [1000, 100, 1000, 500, 10000, 30000, 20000]);
  assert.equal(total, 62_600); assert.equal(finalSize, 20);
  assert.deepEqual(finalActivity, { id: "act-00000ffj", organizationId: "org-0000002r", projectId: "prj-000000dv", actorId: "usr-000000m7", action: "created", subjectType: "project", subjectId: "prj-000000dv", createdAt: "2020-01-14T21:19:00.000Z" });
});

test("representative records, IDs, foreign keys, and owners are stable", async () => {
  const first: Record<string, any> = {};
  for await (const batch of seedDataset("small", 42, 1000)) if (!(batch.entity in first)) first[batch.entity] = batch.records[0];
  assert.deepEqual(first.user, { id: "usr-00000000", email: "user0-9lwi@example.test", displayName: "User 0 i9rl", createdAt: "2020-01-01T10:01:00.000Z", updatedAt: "2020-01-01T21:11:00.000Z" });
  assert.deepEqual(first.membership, { id: "mem-00000000", organizationId: "org-00000000", userId: "usr-00000000", role: "owner", createdAt: "2020-01-01T00:00:00.000Z" });
  assert.equal(entityId("organization", "small", 99), "org-0000002r");
  assert.equal(first.organization.ownerId, first.user.id);
  assert.equal(first.project.organizationId, first.organization.id);
  assert.equal(first.task.projectId, first.project.id);
  assert.equal(first.comment.taskId, first.task.id);
});

test("tenant-scoped assignments and authors match memberships", async () => {
  const membershipOrg = new Map<string, string>(), projectOrg = new Map<string, string>(), taskOrg = new Map<string, string>();
  for await (const batch of seedDataset("small", 42, 1000)) {
    if (batch.entity === "membership") for (const row of batch.records as Array<{ userId: string; organizationId: string }>) membershipOrg.set(row.userId, row.organizationId);
    if (batch.entity === "project") for (const row of batch.records as Array<{ id: string; organizationId: string }>) projectOrg.set(row.id, row.organizationId);
    if (batch.entity === "task") for (const row of batch.records as Array<{ id: string; projectId: string; creatorId: string; assigneeId: string | null }>) {
      const org = projectOrg.get(row.projectId); assert.ok(org); taskOrg.set(row.id, org!);
      assert.equal(membershipOrg.get(row.creatorId), org);
      if (row.assigneeId) assert.equal(membershipOrg.get(row.assigneeId), org);
    }
    if (batch.entity === "comment") for (const row of batch.records as Array<{ taskId: string; authorId: string }>) assert.equal(membershipOrg.get(row.authorId), taskOrg.get(row.taskId));
    if (batch.entity === "activity") for (const row of batch.records as Array<{ organizationId: string; actorId: string }>) assert.equal(membershipOrg.get(row.actorId), row.organizationId);
  }
  assert.equal(membershipOrg.size, 1_000); assert.equal(projectOrg.size, 500); assert.equal(taskOrg.size, 10_000);
});

test("user timestamps never regress while streaming", async () => {
  let checked = 0;
  for await (const batch of seedDataset("small", 42, 257)) if (batch.entity === "user") for (const user of batch.records as Array<{ updatedAt: string; createdAt: string }>) {
    assert.ok(new Date(user.updatedAt).getTime() >= new Date(user.createdAt).getTime());
    checked++;
  }
  assert.equal(checked, 1_000);
});

test("seed changes non-IDs without materializing users", async () => {
  let firstUser: any, secondUser: any;
  for await (const batch of seedDataset("small", 42, 1000)) if (!firstUser && batch.entity === "user") firstUser = batch.records[0];
  for await (const batch of seedDataset("small", 43, 1000)) if (!secondUser && batch.entity === "user") secondUser = batch.records[0];
  assert.equal(firstUser.id, secondUser.id);
  assert.notEqual(firstUser.displayName, secondUser.displayName);
});

test("invalid seed, profile, entity, ordinal, and batch inputs reject", async () => {
  assert.throws(() => mulberry32(-1));
  assert.throws(() => mulberry32(1.5));
  assert.throws(() => entityId("nope" as never, "small", 0));
  assert.throws(() => entityId("user", "nope" as never, 0));
  for (const inherited of ["toString", "constructor", "hasOwnProperty"]) assert.throws(() => entityId("user", inherited as never, 0));
  assert.throws(() => entityId("user", "small", -1));
  assert.throws(() => entityId("user", "small", 1.5));
  await assert.rejects(async () => { for await (const _ of seedDataset("nope" as never, 42)) {} });
  await assert.rejects(async () => { for await (const _ of seedDataset("constructor" as never, 42)) {} });
  await assert.rejects(async () => { for await (const _ of seedDataset("small", 42, 0)) {} });
  await assert.rejects(async () => { for await (const _ of seedDataset("small", 42, 1.5)) {} });
});
