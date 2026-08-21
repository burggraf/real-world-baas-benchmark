import test from "node:test";
import assert from "node:assert/strict";
import { allSettledValues } from "../src/settle.js";

test("allSettledValues waits for siblings before rejecting", async () => {
  let release!: () => void;
  const sibling = new Promise<number>(resolve => { release = () => resolve(2); });
  let rejected = false;
  const result = allSettledValues([Promise.reject(new Error("first failed")), sibling] as const).then(
    () => undefined,
    error => { rejected = true; return error as Error; },
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rejected, false);
  release();
  assert.match((await result)?.message ?? "", /first failed/);
  assert.equal(rejected, true);
});
