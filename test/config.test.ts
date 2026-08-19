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

test("rejects an extra top-level key", () => {
  assert.throws(() => parseConfig({ ...valid(), backend: "pocketbase" }), /Invalid top-level/);
});

test("rejects a dataset outside the approved enum", () => {
  assert.throws(() => parseConfig({ ...valid(), dataset: "huge" }), /Invalid dataset/);
});

test("rejects missing top-level fields and wrong field-family types", () => {
  for (const field of ["name", "publishable", "dataset", "seed", "warmupSeconds", "stageSeconds", "concurrency", "maxConcurrency", "timeoutMs", "thinkTimeMs", "weights", "slos"]) {
    rejects(v => delete v[field], /Invalid top-level/);
  }
  for (const change of [
    (v: any) => v.name = 2, (v: any) => v.publishable = "no", (v: any) => v.dataset = [],
    (v: any) => v.seed = "1", (v: any) => v.warmupSeconds = "1", (v: any) => v.stageSeconds = {},
    (v: any) => v.concurrency = {}, (v: any) => v.maxConcurrency = "2", (v: any) => v.timeoutMs = [],
    (v: any) => v.thinkTimeMs = [], (v: any) => v.weights = [], (v: any) => v.slos = [],
  ]) rejects(change);
});

test("rejects invalid durations, concurrency, and think-time", () => {
  for (const change of [
    (v: any) => v.warmupSeconds = 0, (v: any) => v.stageSeconds = -1,
    (v: any) => v.timeoutMs = Infinity, (v: any) => v.seed = NaN,
    (v: any) => v.concurrency = [], (v: any) => v.concurrency = [1, 1],
    (v: any) => v.concurrency = [2, 1], (v: any) => v.concurrency = [1, 1.5],
    (v: any) => v.concurrency = [1, Infinity], (v: any) => v.maxConcurrency = 1,
    (v: any) => v.maxConcurrency = Infinity, (v: any) => v.thinkTimeMs = { min: 2, max: 1 },
    (v: any) => v.thinkTimeMs.min = -1, (v: any) => v.thinkTimeMs.max = NaN,
    (v: any) => v.thinkTimeMs.min = Infinity,
  ]) rejects(change);
});

test("rejects invalid or incomplete workflow weights", () => {
  for (const change of [
    (v: any) => delete v.weights.search, (v: any) => v.weights.other = 1,
    (v: any) => v.weights.dashboard = -1, (v: any) => v.weights.dashboard = 21,
    (v: any) => v.weights.dashboard = Infinity, (v: any) => v.weights.dashboard = "20",
  ]) rejects(change, /weights|weight|100|finite|number/i);
});

test("rejects invalid or incomplete SLOs and nested objects", () => {
  for (const change of [
    (v: any) => delete v.slos.read, (v: any) => v.slos.other = { p95Ms: 1, maxErrorRate: 0 },
    (v: any) => v.slos.read.extra = 1, (v: any) => v.slos.read = [],
    (v: any) => v.slos.read.p95Ms = 0, (v: any) => v.slos.read.p95Ms = Infinity,
    (v: any) => v.slos.read.maxErrorRate = 1.1, (v: any) => v.slos.read.maxErrorRate = -0.1,
    (v: any) => v.slos.read.maxErrorRate = NaN, (v: any) => v.slos.read.p95Ms = "500",
    (v: any) => delete v.thinkTimeMs.min, (v: any) => v.thinkTimeMs.extra = 1,
  ]) rejects(change, /slo|think|p95|error|keys|missing|finite|positive|number/i);
});
