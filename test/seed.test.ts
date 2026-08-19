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
  let total = 0, finalSize = 0;
  for await (const batch of seedDataset("small", 42, 333)) {
    if (order.at(-1) !== batch.entity) order.push(batch.entity);
    assert.ok(batch.records.length <= 333);
    finalSize = batch.records.length; total += batch.records.length;
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
});

test("representative records, IDs, foreign keys, and owners are stable", async () => {
  const first: Record<string, any> = {};
  for await (const batch of seedDataset("small", 42, 1000)) if (!(batch.entity in first)) first[batch.entity] = batch.records[0];
  assert.deepEqual(first.user, { id: "usr-00000000", email: "user0-cvtb@example.test", displayName: "User 0 9lwi", createdAt: "2020-01-01T14:12:00.000Z", updatedAt: "2020-01-01T11:10:00.000Z" });
  assert.deepEqual(first.membership, { id: "mem-00000000", organizationId: "org-00000000", userId: "usr-00000000", role: "owner", createdAt: "2020-01-01T00:00:00.000Z" });
  assert.equal(entityId("organization", "small", 99), "org-0000002r");
  assert.equal(first.organization.ownerId, first.user.id);
  assert.equal(first.project.organizationId, first.organization.id);
  assert.equal(first.task.projectId, first.project.id);
  assert.equal(first.comment.taskId, first.task.id);
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
  assert.throws(() => entityId("user", "small", -1));
  assert.throws(() => entityId("user", "small", 1.5));
  await assert.rejects(async () => { for await (const _ of seedDataset("nope" as never, 42)) {} });
  await assert.rejects(async () => { for await (const _ of seedDataset("small", 42, 0)) {} });
  await assert.rejects(async () => { for await (const _ of seedDataset("small", 42, 1.5)) {} });
});
