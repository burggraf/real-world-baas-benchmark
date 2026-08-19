import test from "node:test";
import assert from "node:assert/strict";
import { backend, seedPocketBaseCorrectnessFixture } from "../backends/pocketbase/adapter.js";
import { runCorrectness } from "../src/correctness.js";
import { datasetProfiles } from "../src/seed.js";

const live = process.env.BENCH_LIVE === "1";

test("PocketBase live correctness", { skip: live ? false : "set BENCH_LIVE=1 to run" }, async () => {
  try {
    await backend.reset();
    const fixture = await seedPocketBaseCorrectnessFixture();
    const result = await runCorrectness(backend, fixture);
    assert.equal(result.aborted, false, result.abortReason);
    assert.deepEqual(result.findings.filter((finding) => !finding.passed), []);
  } finally {
    await backend.stop();
    await backend.stop();
  }
});

test("PocketBase full small seed", {
  skip: live && process.env.BENCH_LIVE_SEED === "1" ? false : "set BENCH_LIVE=1 BENCH_LIVE_SEED=1 to run",
}, async () => {
  try {
    await backend.reset();
    await backend.seed({ name: "small", definition: { ...datasetProfiles.small } }, 42);
  } finally {
    await backend.stop();
    await backend.stop();
  }
});
