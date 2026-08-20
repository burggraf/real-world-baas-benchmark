import assert from "node:assert/strict";
import test from "node:test";
import { buildSeedVirtualUserSpecs, entityId, profileExpectedCounts, seedDataset, type EntityName } from "../src/seed.js";

const entities: EntityName[] = ["user", "organization", "membership", "project", "task", "comment", "activity"];
const countKey: Record<EntityName, keyof ReturnType<typeof profileExpectedCounts>> = {
  user: "users", organization: "organizations", membership: "memberships", project: "projects", task: "tasks", comment: "comments", activity: "activities",
};

test("medium profile fully streams bounded batches in canonical order with valid boundary foreign keys", async t => {
  const batchSize = 257;
  const expected = profileExpectedCounts("medium");
  const counts = new Map<EntityName, number>();
  const boundaries = new Map<EntityName, { first: Record<string, unknown>; last: Record<string, unknown> }>();
  const order: EntityName[] = [];
  let total = 0;
  const started = performance.now();

  for await (const batch of seedDataset("medium", 42, batchSize)) {
    assert.ok(batch.records.length > 0 && batch.records.length <= batchSize);
    if (order.at(-1) !== batch.entity) order.push(batch.entity);
    const records = batch.records as unknown as Record<string, unknown>[];
    const boundary = boundaries.get(batch.entity);
    boundaries.set(batch.entity, { first: boundary?.first ?? records[0]!, last: records.at(-1)! });
    counts.set(batch.entity, (counts.get(batch.entity) ?? 0) + records.length);
    total += records.length;
  }

  t.diagnostic(`medium seed generation elapsed: ${(performance.now() - started).toFixed(1)} ms`);
  assert.deepEqual(order, entities);
  assert.deepEqual(Object.fromEntries(entities.map(entity => [entity, counts.get(entity)])), {
    user: 10_000, organization: 1_000, membership: 10_000, project: 5_000, task: 100_000, comment: 300_000, activity: 200_000,
  });
  assert.equal(total, 626_000);

  const validId = (value: unknown, entity: EntityName) => {
    assert.equal(typeof value, "string");
    assert.match(value as string, new RegExp(`^${entityId(entity, "medium", 0).slice(0, 4)}[0-9a-z]{11}$`));
    const ordinal = Number.parseInt((value as string).slice(4), 36);
    assert.ok(ordinal >= 0 && ordinal < expected[countKey[entity]]);
  };
  const validForeignKeys = (entity: EntityName, record: Record<string, unknown>) => {
    validId(record.id, entity);
    if (entity === "organization") validId(record.ownerId, "user");
    if (entity === "membership") { validId(record.organizationId, "organization"); validId(record.userId, "user"); }
    if (entity === "project") validId(record.organizationId, "organization");
    if (entity === "task") { validId(record.projectId, "project"); validId(record.creatorId, "user"); if (record.assigneeId !== null) validId(record.assigneeId, "user"); }
    if (entity === "comment") { validId(record.taskId, "task"); validId(record.authorId, "user"); }
    if (entity === "activity") {
      validId(record.organizationId, "organization"); if (record.projectId !== null) validId(record.projectId, "project"); validId(record.actorId, "user");
      validId(record.subjectId, record.subjectType === "task" ? "task" : "project");
    }
  };
  for (const entity of entities) {
    const boundary = boundaries.get(entity)!;
    validForeignKeys(entity, boundary.first); validForeignKeys(entity, boundary.last);
    assert.equal(boundary.first.id, entityId(entity, "medium", 0));
    assert.equal(boundary.last.id, entityId(entity, "medium", expected[countKey[entity]] - 1));
  }

  assert.equal(boundaries.get("organization")!.last.ownerId, entityId("user", "medium", 999));
  assert.deepEqual(
    [boundaries.get("membership")!.last.organizationId, boundaries.get("membership")!.last.userId],
    [entityId("organization", "medium", 999), entityId("user", "medium", 9_999)],
  );
  assert.deepEqual(
    [boundaries.get("task")!.last.projectId, boundaries.get("task")!.last.creatorId, boundaries.get("task")!.last.assigneeId],
    [entityId("project", "medium", 4_999), entityId("user", "medium", 9_999), entityId("user", "medium", 3_999)],
  );
  assert.deepEqual(
    [boundaries.get("comment")!.last.taskId, boundaries.get("comment")!.last.authorId],
    [entityId("task", "medium", 99_999), entityId("user", "medium", 9_999)],
  );
  assert.deepEqual(
    [boundaries.get("activity")!.last.organizationId, boundaries.get("activity")!.last.projectId, boundaries.get("activity")!.last.actorId, boundaries.get("activity")!.last.subjectId],
    [entityId("organization", "medium", 999), entityId("project", "medium", 4_999), entityId("user", "medium", 7_999), entityId("project", "medium", 4_999)],
  );
});

test("medium virtual-user specs accept the exact user boundary and remain deterministic without secret diagnostics", async () => {
  const password = "not-for-diagnostics";
  const build = (count: number) => buildSeedVirtualUserSpecs("medium", count, 42, (_id, canonical) => canonical, password);
  const specs = await build(profileExpectedCounts("medium").users);
  assert.equal(specs.length, 10_000);
  assert.equal(specs.every(spec => spec.credentials.password === password), true);
  assert.equal(specs[0]!.organizationId, entityId("organization", "medium", 0));
  assert.equal(specs.at(-1)!.organizationId, entityId("organization", "medium", 999));
  assert.equal(specs.at(-1)!.projectId, entityId("project", "medium", 4_999));
  assert.equal(specs.at(-1)!.taskId, entityId("task", "medium", 9_999));

  const publicSummary = (values: Awaited<ReturnType<typeof build>>) => values.map(spec => ({ email: spec.credentials.email, organizationId: spec.organizationId, projectId: spec.projectId, taskId: spec.taskId }));
  assert.deepEqual(publicSummary(await build(2)), publicSummary(await build(2)));
  await assert.rejects(build(10_001), /exceed/i);
});
