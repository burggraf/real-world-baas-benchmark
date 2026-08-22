import test from "node:test";
import assert from "node:assert/strict";
import { BenchmarkOperationError } from "../src/correctness.js";
import { measureSdkCall, withSdkMeasurement, type SdkMeasurementContext } from "../src/sdk-measurement.js";
import { pocketBaseSdkCall } from "../backends/pocketbase/adapter.js";
import { supabaseSdkCall } from "../backends/supabase/adapter.js";
import { trailBaseSdkCall } from "../backends/trailbase/adapter.js";

const context = (name: string, samples: unknown[], clock: { value: number }): SdkMeasurementContext => ({
  name,
  workflow: "dashboard",
  operationClass: "read",
  kind: "read",
  now: () => ++clock.value,
  sample: sample => samples.push(sample),
});

test("physical SDK calls emit one sample each without an outer adapter sample", async () => {
  const samples: any[] = [];
  const clock = { value: 0 };
  await withSdkMeasurement(context("dashboard", samples, clock), async () => {
    await measureSdkCall(async () => "first");
    await measureSdkCall(async () => "second");
  });
  assert.deepEqual(samples.map(sample => ({ type: sample.type, name: sample.name, success: sample.success })), [
    { type: "sdk", name: "dashboard", success: true },
    { type: "sdk", name: "dashboard", success: true },
  ]);
});

test("physical SDK failures retain normalized safe metadata and do not double count", async () => {
  const samples: any[] = [];
  const clock = { value: 0 };
  await assert.rejects(withSdkMeasurement(context("getTask", samples, clock), async () => {
    await measureSdkCall(async () => "first");
    await measureSdkCall(async () => { throw new BenchmarkOperationError("timeout", { code: "request_timeout", status: 408 }); });
  }));
  assert.equal(samples.length, 2);
  assert.equal(samples[0].success, true);
  assert.deepEqual(samples[1].error, { name: "BenchmarkOperationError", message: "request_timeout", code: "request_timeout", classification: "timeout", status: 408 });
});

test("concurrent SDK measurement contexts remain isolated", async () => {
  const samples: any[] = [];
  const clock = { value: 0 };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await Promise.all([
    withSdkMeasurement(context("dashboard", samples, clock), () => measureSdkCall(async () => { await gate; return "a"; })),
    withSdkMeasurement(context("listTasks", samples, clock), async () => { const result = await measureSdkCall(async () => "b"); release(); return result; }),
  ]);
  assert.deepEqual(new Set(samples.map(sample => sample.name)), new Set(["dashboard", "listTasks"]));
  assert.equal(samples.filter(sample => sample.name === "dashboard").length, 1);
  assert.equal(samples.filter(sample => sample.name === "listTasks").length, 1);
});

test("backend SDK helpers normalize and measure physical failures exactly once", async () => {
  for (const [name, work, classification] of [
    ["pocketbase", () => pocketBaseSdkCall(async () => { throw new DOMException("timeout", "TimeoutError"); }), "timeout"],
    ["supabase", () => supabaseSdkCall(async () => ({ data: null, error: { name: "PostgrestError", status: 500 }, status: 500 })), "backend_health"],
    ["trailbase", () => trailBaseSdkCall(async () => { throw { name: "TimeoutError", status: 408 }; }), "timeout"],
  ] as const) {
    const samples: any[] = [];
    const clock = { value: 0 };
    await assert.rejects(withSdkMeasurement(context(name, samples, clock), work));
    assert.equal(samples.length, 1, name);
    assert.equal(samples[0].success, false, name);
    assert.equal(samples[0].error.classification, classification, name);
  }
});

test("SDK sample observer failures remain strict harness failures", async () => {
  const clock = { value: 0 };
  const failing = context("dashboard", [], clock);
  failing.sample = () => { throw new Error("sample observer failed"); };
  await assert.rejects(withSdkMeasurement(failing, () => measureSdkCall(async () => "value")), /sample observer failed/);
});

test("detached SDK work cannot emit after its measured operation returns", async () => {
  const samples: any[] = [];
  const clock = { value: 0 };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let detached!: Promise<string>;
  await withSdkMeasurement(context("dashboard", samples, clock), async () => {
    detached = gate.then(() => measureSdkCall(async () => "late"));
  });
  release();
  assert.equal(await detached, "late");
  assert.deepEqual(samples, []);
});

test("SDK calls outside a measurement context emit nothing", async () => {
  assert.equal(await measureSdkCall(async () => "setup"), "setup");
});
