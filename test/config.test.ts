import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadConfig, parseConfig } from "../src/config.js";

const quick = loadConfig("configs/quick.json");
const full = loadConfig("configs/full.json");

test("loads every required value from the approved quick and full configurations", () => {
  const weights = { dashboard: 20, taskList: 25, taskDetail: 15, createTask: 10, updateTask: 12, addComment: 10, search: 5, profileUpdate: 1, signIn: 2 };
  const slos = { read: { p95Ms: 500, maxErrorRate: 0.01 }, write: { p95Ms: 750, maxErrorRate: 0.01 }, authSearch: { p95Ms: 1000, maxErrorRate: 0.01 } };
  assert.deepEqual(quick, {
    name: "quick", publishable: false, dataset: "small", seed: 42, warmupSeconds: 5, stageSeconds: 15,
    concurrency: [1, 5, 10], maxConcurrency: 10, timeoutMs: 5000, thinkTimeMs: { min: 1000, max: 5000 }, weights, slos,
  });
  assert.deepEqual(full, {
    name: "full", publishable: true, dataset: "medium", seed: 42, warmupSeconds: 120, stageSeconds: 300,
    concurrency: [1, 5, 10, 25, 50], maxConcurrency: 1000, timeoutMs: 5000, thinkTimeMs: { min: 1000, max: 5000 }, weights, slos,
  });
});

test("parses JSON text through the unknown boundary", () => {
  assert.equal(parseConfig(JSON.parse(readFileSync("configs/quick.json", "utf8"))).seed, 42);
  assert.throws(() => parseConfig(null), /object/i);
});

const valid = () => ({
  name: "x", publishable: false, dataset: "small", seed: 1,
  warmupSeconds: 1, stageSeconds: 2, concurrency: [1, 2], maxConcurrency: 2,
  timeoutMs: 1, thinkTimeMs: { min: 0, max: 1 },
  weights: { dashboard: 20, taskList: 25, taskDetail: 15, createTask: 10, updateTask: 12, addComment: 10, search: 5, profileUpdate: 1, signIn: 2 },
  slos: { read: { p95Ms: 500, maxErrorRate: 0.01 }, write: { p95Ms: 750, maxErrorRate: 0.01 }, authSearch: { p95Ms: 1000, maxErrorRate: 0.01 } },
});
const rejects = (change: (v: any) => void, pattern = /invalid|expected|unknown|positive|increas|100|missing|extra|finite|range/i) => {
  const value = valid(); change(value); assert.throws(() => parseConfig(value), pattern);
};

test("rejects malformed top-level, nested, and primitive values", () => {
  rejects(v => v.extra = 1, /Invalid top-level/);
  rejects(v => v.publishable = "no", /boolean/);
  rejects(v => v.dataset = "huge", /dataset/);
  rejects(v => v.name = 2, /string/);
  rejects(v => v.thinkTimeMs.extra = 1, /Invalid think/i);
  rejects(v => v.weights.dashboard = "20", /number/);
  rejects(v => v.slos.read.extra = 1, /Invalid.*SLO/i);
});

test("rejects invalid durations, concurrency, and think-time", () => {
  for (const change of [
    (v: any) => v.warmupSeconds = 0, (v: any) => v.stageSeconds = -1,
    (v: any) => v.timeoutMs = Infinity, (v: any) => v.concurrency = [1, 1],
    (v: any) => v.concurrency = [2, 1], (v: any) => v.concurrency = [1, 1.5],
    (v: any) => v.maxConcurrency = 1, (v: any) => v.thinkTimeMs = { min: 2, max: 1 },
    (v: any) => v.seed = NaN,
  ]) rejects(change);
});

test("rejects invalid or incomplete workflow weights", () => {
  rejects(v => { delete v.weights.search; }, /weights.*keys|missing/i);
  rejects(v => v.weights.other = 1, /weights.*keys|unknown/i);
  rejects(v => v.weights.dashboard = -1, /weight|100/i);
  rejects(v => v.weights.dashboard = 21, /100/i);
  rejects(v => v.weights.dashboard = Infinity, /finite/i);
});

test("rejects invalid or incomplete SLOs", () => {
  rejects(v => { delete v.slos.read; }, /slo.*keys|missing/i);
  rejects(v => v.slos.other = { p95Ms: 1, maxErrorRate: 0 }, /slo.*keys|unknown/i);
  rejects(v => v.slos.read.p95Ms = 0, /p95|positive/i);
  rejects(v => v.slos.read.maxErrorRate = 1.1, /error/i);
  rejects(v => v.slos.read.maxErrorRate = -0.1, /error/i);
});
