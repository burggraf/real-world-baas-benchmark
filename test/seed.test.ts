import { strict as assert } from "node:assert";
import test from "node:test";
import { mulberry32 } from "../src/random.js";
import { datasetProfiles, entityId, seedDataset } from "../src/seed.js";

test("Mulberry32 is deterministic", () => {
  const a = mulberry32(42), b = mulberry32(42);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test("profiles and streamed counts", async () => {
  assert.equal(datasetProfiles.small.organizations, 100);
  let count = 0, batchCount = 0, finalSize = 0;
  for await (const batch of seedDataset("small", 42, 333)) {
    batchCount++;
    finalSize = batch.records.length;
    assert.ok(batch.records.length <= 333);
    count += batch.records.length;
  }
  assert.equal(count, 62_600);
  assert.equal(batchCount, [100, 1000, 1000, 500, 10000, 30000, 20000].reduce((sum, n) => sum + Math.ceil(n / 333), 0));
  assert.equal(finalSize, 20);
  assert.equal(entityId("organization", "small", 0), "org-00000000");
  assert.equal(entityId("organization", "small", 99), "org-0000002r");
});

test("seed changes values but not IDs and owners are present", async () => {
  const first = [], second = [];
  for await (const batch of seedDataset("small", 42, 1000)) if (batch.entity === "user") first.push(...batch.records);
  for await (const batch of seedDataset("small", 43, 1000)) if (batch.entity === "user") second.push(...batch.records);
  assert.equal(first[0]?.id, second[0]?.id);
  assert.notEqual((first[0] as { displayName: string }).displayName, (second[0] as { displayName: string }).displayName);
  let owners = 0;
  for await (const batch of seedDataset("small", 42, 1000)) if (batch.entity === "membership") owners += batch.records.filter(r => "role" in r && r.role === "owner").length;
  assert.equal(owners, 100);
});

test("invalid inputs rejected", async () => {
  assert.throws(() => mulberry32(-1));
  assert.throws(() => entityId("nope" as never, "small", 0));
  assert.throws(() => entityId("user", "small", -1));
  assert.rejects(async () => { for await (const _ of seedDataset("small", 42, 0)) { /* noop */ } });
});
