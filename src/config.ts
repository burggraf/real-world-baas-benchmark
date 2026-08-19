import { readFileSync } from "node:fs";

export type WorkflowName = "dashboard" | "taskList" | "taskDetail" | "createTask" | "updateTask" | "addComment" | "search" | "profileUpdate" | "signIn";
export type OperationClass = "read" | "write" | "authSearch";
export type BenchmarkConfig = {
  name: string;
  publishable: boolean;
  dataset: "small" | "medium" | "large";
  seed: number;
  warmupSeconds: number;
  stageSeconds: number;
  concurrency: number[];
  maxConcurrency: number;
  timeoutMs: number;
  thinkTimeMs: { min: number; max: number };
  weights: Record<WorkflowName, number>;
  slos: Record<OperationClass, { p95Ms: number; maxErrorRate: number }>;
};

const workflows: WorkflowName[] = ["dashboard", "taskList", "taskDetail", "createTask", "updateTask", "addComment", "search", "profileUpdate", "signIn"];
const operations: OperationClass[] = ["read", "write", "authSearch"];
const keys = (value: object, expected: readonly string[], label: string) => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) throw new Error(`Invalid ${label} keys`);
};
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected ${label} object`);
  return value as Record<string, unknown>;
};
const string = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw new Error(`Expected ${label} string`);
  return value;
};
const boolean = (value: unknown, label: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`Expected ${label} boolean`);
  return value;
};
const finite = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Expected finite ${label} number`);
  return value;
};
const positive = (value: unknown, label: string): number => {
  const n = finite(value, label);
  if (n <= 0) throw new Error(`Expected positive ${label}`);
  return n;
};

export function parseConfig(value: unknown): BenchmarkConfig {
  const raw = object(value, "config");
  keys(raw, ["name", "publishable", "dataset", "seed", "warmupSeconds", "stageSeconds", "concurrency", "maxConcurrency", "timeoutMs", "thinkTimeMs", "weights", "slos"], "top-level");
  const dataset = string(raw.dataset, "dataset");
  if (dataset !== "small" && dataset !== "medium" && dataset !== "large") throw new Error("Invalid dataset");
  const concurrencyValue = raw.concurrency;
  if (!Array.isArray(concurrencyValue) || concurrencyValue.length === 0) throw new Error("Expected concurrency array");
  const concurrency = concurrencyValue.map((n, i) => {
    const number = positive(n, `concurrency[${i}]`);
    if (!Number.isInteger(number)) throw new Error("Concurrency must contain positive integers");
    return number;
  });
  for (let i = 1; i < concurrency.length; i++) if (concurrency[i]! <= concurrency[i - 1]!) throw new Error("Concurrency stages must increase");
  const maxConcurrency = positive(raw.maxConcurrency, "maxConcurrency");
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < concurrency[concurrency.length - 1]!) throw new Error("Invalid maxConcurrency");
  const think = object(raw.thinkTimeMs, "thinkTimeMs");
  keys(think, ["min", "max"], "thinkTimeMs");
  const min = finite(think.min, "thinkTimeMs.min");
  const max = finite(think.max, "thinkTimeMs.max");
  if (min < 0 || max < 0 || min > max) throw new Error("Invalid think-time range");
  const weightsRaw = object(raw.weights, "weights");
  keys(weightsRaw, workflows, "weights");
  const weights = Object.fromEntries(workflows.map(name => [name, finite(weightsRaw[name], `weight ${name}`)])) as Record<WorkflowName, number>;
  if (Object.values(weights).some(n => n < 0) || Object.values(weights).reduce((a, b) => a + b, 0) !== 100) throw new Error("Workflow weights must be nonnegative and total 100");
  const slosRaw = object(raw.slos, "slos");
  keys(slosRaw, operations, "SLO");
  const slos = Object.fromEntries(operations.map(name => {
    const slo = object(slosRaw[name], `SLO ${name}`);
    keys(slo, ["p95Ms", "maxErrorRate"], `SLO ${name}`);
    const p95Ms = positive(slo.p95Ms, `${name}.p95Ms`);
    const maxErrorRate = finite(slo.maxErrorRate, `${name}.maxErrorRate`);
    if (maxErrorRate < 0 || maxErrorRate > 1) throw new Error(`Invalid ${name}.maxErrorRate`);
    return [name, { p95Ms, maxErrorRate }];
  })) as Record<OperationClass, { p95Ms: number; maxErrorRate: number }>;
  return {
    name: string(raw.name, "name"), publishable: boolean(raw.publishable, "publishable"), dataset, seed: finite(raw.seed, "seed"),
    warmupSeconds: positive(raw.warmupSeconds, "warmupSeconds"), stageSeconds: positive(raw.stageSeconds, "stageSeconds"), concurrency,
    maxConcurrency, timeoutMs: positive(raw.timeoutMs, "timeoutMs"), thinkTimeMs: { min, max }, weights, slos,
  };
}

export function loadConfig(path: string): BenchmarkConfig {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}
