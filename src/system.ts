import os from "node:os";
import process from "node:process";
import { execFile } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import type { BackendInfo } from "./backend.js";

export type Optional<T> = { value: T | null; reason?: string };
export interface PsProcess { pid: number; cpuPercent: number; rssBytes: number }
export interface DockerStat { containerId: string; cpuPercent: number; memoryBytes: number; blockReadBytes: number; blockWriteBytes: number }
export interface ContainerTotals { cpuPercent: number; memoryBytes: number; blockReadBytes: number; blockWriteBytes: number }
export interface SysctlInfo { model: string | null; logicalCores: number | null; memoryBytes: number | null }
const validNumber = (n: number): boolean => Number.isFinite(n) && n >= 0;
const positive = (n: number): boolean => Number.isSafeInteger(n) && n > 0;

export function parseByteUnit(input: string): number | null {
  const match = input.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB|K|M|G|T)$/i);
  if (!match) return null;
  const raw = match[2]!.toUpperCase(); const unit = raw.length === 1 && raw !== "B" ? `${raw}IB` : raw;
  const binary = ["B", "KIB", "MIB", "GIB", "TIB"].includes(unit);
  const units = ["B", binary ? "KIB" : "KB", binary ? "MIB" : "MB", binary ? "GIB" : "GB", binary ? "TIB" : "TB"];
  const index = units.indexOf(unit); const value = Number(match[1]) * (binary ? 1024 : 1000) ** index;
  return Number.isSafeInteger(value) && validNumber(value) ? value : null;
}

function integer(value: string): number | null { const n = Number(value.trim()); return positive(n) ? n : null; }
export function parseSysctl(text: string): SysctlInfo {
  let model: string | null = null; let logicalCores: number | null = null; let memoryBytes: number | null = null; let processors = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:=]+?)\s*[:=]\s*(.*?)\s*$/); if (!match) continue;
    const key = match[1]!.toLowerCase(); const value = match[2]!;
    if (/machdep\.cpu\.brand_string|hw\.model|model name/.test(key)) model = value || null;
    else if (/^processor$/.test(key)) processors++;
    else if (/logicalcpu|ncpu|cpu\.active/.test(key)) logicalCores = integer(value) ?? logicalCores;
    else if (/memsize/.test(key)) memoryBytes = integer(value) ?? memoryBytes;
  }
  if (processors) logicalCores = processors;
  return { model, logicalCores, memoryBytes };
}
export function parseCpuInfo(text: string): { model: string | null; logicalCores: number | null } {
  let model: string | null = null; let processors = 0;
  for (const line of text.split(/\r?\n/)) { const m = line.match(/^\s*([^:]+):\s*(.*?)\s*$/); if (!m) continue; const key = m[1]!.toLowerCase(); if (key === "model name" || key === "hardware") model ??= m[2]!; if (key === "processor") processors++; }
  return { model, logicalCores: processors || null };
}
export function parseMemInfo(text: string): number | null {
  for (const line of text.split(/\r?\n/)) { const m = line.match(/^MemTotal:\s*([0-9]+)\s*kB\s*$/i); if (m) { const n = Number(m[1]) * 1024; return Number.isSafeInteger(n) ? n : null; } }
  return null;
}
export function parsePs(text: string): PsProcess[] {
  const result: PsProcess[] = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/); if (fields.length < 3) continue;
    const pid = Number(fields[0]); const cpu = Number(fields[1]);
    const parsed = parseByteUnit(fields.slice(2).join(" ")); const rawRss = Number(fields[2]); const rss = parsed ?? (validNumber(rawRss) ? rawRss * 1024 : NaN);
    if (positive(pid) && validNumber(cpu) && validNumber(rss)) result.push({ pid, cpuPercent: cpu, rssBytes: rss });
  }
  return result;
}
function statNumber(value: unknown): number | null { const n = Number(String(value ?? "").replace(/%$/, "").trim()); return validNumber(n) ? n : null; }
export function parseContainerIds(text: string): { ids: string[]; invalid: boolean } {
  const ids: string[] = []; let invalid = false;
  for (const value of text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) { if (!/^[0-9a-f]+$/i.test(value)) invalid = true; else if (!ids.includes(value.toLowerCase())) ids.push(value.toLowerCase()); }
  return { ids, invalid };
}
export function parseDockerStats(text: string, ownedIds?: ReadonlySet<string>): DockerStat[] {
  const result: DockerStat[] = []; const seen = new Set<string>(); const owned = ownedIds ? [...ownedIds].map(id => id.toLowerCase()) : [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>; const raw = typeof row.ID === "string" ? row.ID : typeof row.Container === "string" ? row.Container : ""; const id = raw.toLowerCase();
      if (!/^[0-9a-f]+$/i.test(id)) continue;
      const matches = owned.length ? owned.filter(full => full === id || full.startsWith(id)) : [id]; if (matches.length !== 1 || seen.has(matches[0]!)) continue;
      const cpu = statNumber(row.CPUPerc); const memory = parseByteUnit(String(row.MemUsage ?? "").split("/")[0] ?? ""); const io = String(row.BlockIO ?? "").split("/");
      const read = parseByteUnit(io[0] ?? ""); const write = parseByteUnit(io[1] ?? "");
      if (cpu !== null && memory !== null && read !== null && write !== null) { const full = matches[0]!; result.push({ containerId: full, cpuPercent: cpu, memoryBytes: memory, blockReadBytes: read, blockWriteBytes: write }); seen.add(full); }
    } catch { /* malformed probe rows are unavailable, never zero */ }
  }
  return result;
}

export interface EventLoopSnapshot { p99Ms: number | null; maxMs: number | null; reason?: string }
export interface ProcessResourceSnapshot { pid: number; cpuPercent: number | null; rssBytes: number | null; reason?: string }
export interface ResourceSnapshot { timestampMs: number; runner: ProcessResourceSnapshot; backend: { totalCpuPercent: number | null; totalRssBytes: number | null; processes: ProcessResourceSnapshot[]; reason?: string }; containers: DockerStat[] | null; containerTotals: ContainerTotals | null; containerReason?: string; eventLoop: EventLoopSnapshot }
export type RunnerSnapshot = ResourceSnapshot;
export interface OverloadThresholds { cpuPercent?: number; p99Ms?: number; maxMs?: number; consecutiveSamples?: number }
export function evaluateRunnerOverload(samples: ResourceSnapshot[], thresholds: OverloadThresholds = {}): string | null {
  for (const [key, value] of Object.entries(thresholds)) if (key !== "consecutiveSamples" && value !== undefined && (!validNumber(value) || value < 0)) throw new Error(`${key} must be finite and nonnegative`);
  const count = thresholds.consecutiveSamples ?? 3; if (!positive(count)) throw new Error("consecutiveSamples must be positive");
  for (let i = 0; i < samples.length; i++) { const s = samples[i]!; if (!Number.isFinite(s.timestampMs) || s.timestampMs < 0 || (i > 0 && s.timestampMs <= samples[i - 1]!.timestampMs)) return "invalid snapshot timestamp"; const metrics: Array<[string, number | null]> = [["CPU", s.runner.cpuPercent], ["event-loop p99", s.eventLoop.p99Ms], ["event-loop max", s.eventLoop.maxMs]]; for (const [key, value] of metrics) if (value !== null && !validNumber(value)) return `invalid ${key} metric`; }
  const overloaded = (offset: number, key: "cpuPercent" | "p99Ms" | "maxMs", threshold: number): boolean => samples.slice(offset, offset + count).every(s => { const value = key === "cpuPercent" ? s.runner.cpuPercent : key === "p99Ms" ? s.eventLoop.p99Ms : s.eventLoop.maxMs; return value !== null && value > threshold; });
  for (const [key, threshold] of [["cpuPercent", thresholds.cpuPercent], ["p99Ms", thresholds.p99Ms], ["maxMs", thresholds.maxMs]] as const) if (threshold !== undefined) { for (const s of samples) { const value = key === "cpuPercent" ? s.runner.cpuPercent : key === "p99Ms" ? s.eventLoop.p99Ms : s.eventLoop.maxMs; if (value === null) return `runner ${key} unavailable`; } for (let i = 0; i + count <= samples.length; i++) if (overloaded(i, key, threshold)) return `${key} sustained above threshold`; }
  return null;
}

export interface CommandResult { stdout: string; stderr: string }
export type CommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<CommandResult>;
const defaultRunner: CommandRunner = (command, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => error ? reject(new Error("command failed")) : resolve({ stdout: String(stdout), stderr: String(stderr) }));
});
function version(text: string): string | null { const m = text.match(/\b\d+(?:\.\d+){1,3}\b/); return m?.[0] ?? null; }
function packageVersion(name: string): string | null { try { const metadata = createRequire(import.meta.url)(`${name}/package.json`) as { version?: unknown }; return typeof metadata.version === "string" && /^\d+(?:\.\d+){1,3}$/.test(metadata.version) ? metadata.version : null; } catch { return null; } }
export interface Environment { runtime: string; runtimeVersion: string; os: string; architecture: string; host: string; cpu: string | null; memoryBytes: number | null; release: string; logicalCores: number | null; cpuModel: string | null; totalMemoryBytes: number | null; hostname: string; nodeVersion: string; npmVersion: string | null; gitCommit: string | null; gitDirty: boolean | null; backend: BackendInfo; sdkVersion: string | null; dockerVersion: string | null; supabaseVersion: string | null; unavailable: Record<string, string> }
export type EnvironmentFileReader = (path: string) => Promise<string>;
export async function captureEnvironment(backend: BackendInfo, sdkVersion?: string, runner: CommandRunner = defaultRunner, fileReader: EnvironmentFileReader = path => readFile(path, "utf8")): Promise<Environment> {
  const unavailable: Record<string, string> = {}; const run = async (command: string, args: string[]): Promise<string | null> => { try { return (await runner(command, args, 3000)).stdout.trim(); } catch { return null; } }; const read = async (path: string): Promise<string | null> => { try { return await fileReader(path); } catch { return null; } };
  let model: string | null = null; let cores: number | null = null; let memory: number | null = null;
  if (process.platform === "darwin") { const text = await run("sysctl", ["-a"]); const parsed = parseSysctl(text ?? ""); model = parsed.model; cores = parsed.logicalCores; memory = parsed.memoryBytes; if (text === null) unavailable.cpu = "sysctl probe unavailable"; }
  else { const text = await read("/proc/cpuinfo"); const parsed = parseCpuInfo(text ?? ""); model = parsed.model; cores = parsed.logicalCores; const memText = await read("/proc/meminfo"); memory = parseMemInfo(memText ?? ""); if (text === null) unavailable.cpu = "cpuinfo unavailable"; if (memText === null) unavailable.memoryBytes = "meminfo unavailable"; }
  try { const cpus = os.cpus(); if (!model) model = cpus[0]?.model || null; if (!cores && cpus.length) cores = cpus.length; } catch { /* retain explicit unavailable state */ }
  if (memory === null) { try { const fallback = os.totalmem(); if (Number.isSafeInteger(fallback) && fallback > 0) memory = fallback; } catch { /* unavailable */ } }
  if (model === null) unavailable.cpuModel = unavailable.cpuModel ?? "CPU model unavailable"; if (cores === null) unavailable.logicalCores = "logical core count unavailable"; if (memory === null) unavailable.totalMemoryBytes = "total memory unavailable";
  const commit = await run("git", ["rev-parse", "HEAD"]); const dirtyText = commit === null ? null : await run("git", ["status", "--porcelain"]); const npmText = await run("npm", ["--version"]); const npmVersion = version(npmText ?? "");
  const dockerText = backend.name === "supabase" ? await run("docker", ["--version"]) : null; const supabaseText = backend.name === "supabase" ? await run("supabase", ["--version"]) : null; const dockerVersion = version(dockerText ?? ""); const supabaseVersion = version(supabaseText ?? "");
  const gitCommit = commit && /^[0-9a-f]{40}$/i.test(commit) ? commit : null; const gitDirty = dirtyText === null ? null : dirtyText.length > 0; const sdkPackage = backend.name === "pocketbase" ? "pocketbase" : backend.name === "supabase" ? "@supabase/supabase-js" : "trailbase"; const supplied = sdkVersion === undefined ? null : (/^\d+(?:\.\d+){1,3}$/.test(sdkVersion) ? sdkVersion : null); const detectedSdk = supplied ?? (sdkVersion === undefined ? packageVersion(sdkPackage) : null);
  if (!gitCommit) unavailable.gitCommit = commit === null ? "git commit probe unavailable" : "git commit malformed"; if (gitDirty === null) unavailable.gitDirty = "git status unavailable"; if (!npmVersion) unavailable.npmVersion = npmText === null ? "npm probe unavailable" : "npm version malformed"; if (!dockerVersion) unavailable.dockerVersion = backend.name === "supabase" ? dockerText === null ? "docker probe unavailable" : "docker version malformed" : "not required for selected backend"; if (!supabaseVersion) unavailable.supabaseVersion = backend.name === "supabase" ? supabaseText === null ? "supabase probe unavailable" : "supabase version malformed" : "not required for selected backend"; if (!detectedSdk) unavailable.sdkVersion = sdkVersion === undefined ? "SDK metadata unavailable" : "SDK version malformed";
  return { runtime: "node", runtimeVersion: process.version, os: process.platform, architecture: process.arch, host: os.hostname(), cpu: model, memoryBytes: memory, release: os.release(), logicalCores: cores, cpuModel: model, totalMemoryBytes: memory, hostname: os.hostname(), nodeVersion: process.version, npmVersion, gitCommit, gitDirty, backend, sdkVersion: detectedSdk, dockerVersion, supabaseVersion, unavailable };
}

export interface EventLoopMonitor { percentile(p: number): number; max: number | (() => number); reset(): void; disable(): void }
export interface ResourceSamplerOptions { backend: BackendInfo; maxSamples?: number; runnerPid?: number; commandRunner?: CommandRunner; nowNs?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; eventLoop?: EventLoopMonitor; intervalMs?: number; signal?: AbortSignal; shouldStop?: () => boolean }
const monitor = (): EventLoopMonitor => { const h = monitorEventLoopDelay({ resolution: 10 }); h.enable(); return { percentile: p => h.percentile(p), get max() { return h.max; }, reset: () => h.reset(), disable: () => h.disable() }; };
const monitorMax = (event: EventLoopMonitor): number => typeof event.max === "function" ? event.max() : event.max;
const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => { if (signal?.aborted) return reject(new Error("aborted")); let done = false; const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); error ? reject(error) : resolve(); }; const onAbort = () => finish(new Error("aborted")); const timer = setTimeout(() => finish(), ms); signal?.addEventListener("abort", onAbort, { once: true }); });
function ownedPids(info: BackendInfo, runnerPid: number): number[] { const pids = [runnerPid, ...(info.processIds ?? [])]; if (pids.some(pid => !positive(pid))) throw new Error("processIds must be positive safe integers"); return [...new Set(pids)]; }
async function sampleResourcesOnce(options: ResourceSamplerOptions): Promise<ResourceSnapshot> {
  const pid = options.runnerPid ?? process.pid; if (!positive(pid)) throw new Error("runnerPid must be positive"); const now = options.nowNs ?? (() => Number(process.hrtime.bigint())); const run = options.commandRunner ?? defaultRunner; const info = options.backend;
  const pids = info.name === "supabase" ? [pid] : ownedPids(info, pid); const ps = await run("ps", ["-o", "pid=,pcpu=,rss=", "-p", pids.join(",")], 3000).catch(() => ({ stdout: "", stderr: "" })); const rows = parsePs(ps.stdout); const byPid = new Map(rows.map(row => [row.pid, row]));
  const proc = pids.map(p => { const row = byPid.get(p); return row ? { pid: p, cpuPercent: row.cpuPercent, rssBytes: row.rssBytes } : { pid: p, cpuPercent: null, rssBytes: null, reason: "owned process missing or malformed" }; }); const runner = proc.find(p => p.pid === pid)!; const backendProc = proc.filter(p => p.pid !== pid); const event = options.eventLoop ?? monitor(); const p99 = event.percentile(99); const max = monitorMax(event); const eventLoop = validNumber(p99) && validNumber(max) && max > 0 ? { p99Ms: p99 / 1e6, maxMs: max / 1e6 } : { p99Ms: null, maxMs: null, reason: "not enough event-loop observations" };
  let containers: DockerStat[] | null = null; let containerReason: string | undefined;
  if (info.name === "supabase") { const project = info.supabaseProjectId; if (!project || !/^[A-Za-z0-9_.-]+$/.test(project)) containerReason = "explicit Supabase project ID required"; else { const discovered = await run("docker", ["ps", "-q", "--filter", `label=com.supabase.cli.project=${project}`], 3000).catch(() => ({ stdout: "", stderr: "" })); const parsedIds = parseContainerIds(discovered.stdout ?? ""); const ids = parsedIds.ids; if (parsedIds.invalid) containerReason = "malformed container identity from owned discovery"; else if (!ids.length) containerReason = "no owned containers discovered"; else { const stats = await run("docker", ["stats", "--no-stream", "--format", "{{json .}}", ...ids], 3000).catch(() => ({ stdout: "", stderr: "" })); containers = parseDockerStats(stats.stdout, new Set(ids)); if (containers.length !== ids.length) containerReason = "owned container metrics unavailable"; } } }
  event.reset(); const timestampNs = now(); const timestampMs = timestampNs / 1e6; if (!Number.isFinite(timestampNs) || timestampNs < 0 || !Number.isFinite(timestampMs) || timestampMs < 0) throw new Error("monotonic timestamp must be finite and JSON-safe"); const containerTotals = containers?.length ? { cpuPercent: containers.reduce((a, p) => a + p.cpuPercent, 0), memoryBytes: containers.reduce((a, p) => a + p.memoryBytes, 0), blockReadBytes: containers.reduce((a, p) => a + p.blockReadBytes, 0), blockWriteBytes: containers.reduce((a, p) => a + p.blockWriteBytes, 0) } : null; const snapshot = { timestampMs, runner, backend: { totalCpuPercent: backendProc.length && backendProc.every(p => p.cpuPercent !== null) ? backendProc.reduce((a, p) => a + (p.cpuPercent ?? 0), 0) : null, totalRssBytes: backendProc.length && backendProc.every(p => p.rssBytes !== null) ? backendProc.reduce((a, p) => a + (p.rssBytes ?? 0), 0) : null, processes: backendProc, reason: !backendProc.length ? "no registered backend PIDs" : backendProc.some(p => p.cpuPercent === null || p.rssBytes === null) ? "owned process metric unavailable" : undefined }, containers, containerTotals, containerReason, eventLoop }; return snapshot;
}
export async function sampleResources(options: ResourceSamplerOptions): Promise<ResourceSnapshot> { const event = options.eventLoop ?? monitor(); try { return await sampleResourcesOnce({ ...options, eventLoop: event }); } finally { if (!options.eventLoop) event.disable(); } }
export interface ResourceCollection { samples: ResourceSnapshot[]; valid: boolean; validityReasons: string[] }
export async function collectResources(options: ResourceSamplerOptions): Promise<ResourceCollection> {
  const max = options.maxSamples ?? 100; if (!positive(max)) throw new Error("maxSamples must be a positive safe integer"); const samples: ResourceSnapshot[] = []; const event = options.eventLoop ?? monitor(); const sleep = options.sleep ?? defaultSleep;
  const interval = options.intervalMs ?? 1000; if (!Number.isFinite(interval) || interval <= 0) throw new Error("intervalMs must be finite and positive");
  try { if (options.signal?.aborted) return { samples, valid: false, validityReasons: ["aborted before sampling"] }; for (;;) { if (options.signal?.aborted || options.shouldStop?.()) break; if (samples.length >= max) return { samples, valid: false, validityReasons: ["maxSamples ceiling exceeded"] }; samples.push(await sampleResources({ ...options, eventLoop: event })); if (options.signal?.aborted || options.shouldStop?.()) break; await sleep(interval, options.signal); } const metricFailure = samples.some(s => s.runner.cpuPercent === null || s.runner.rssBytes === null); return { samples, valid: samples.length > 0 && !metricFailure, validityReasons: metricFailure ? ["runner metric unavailable"] : samples.length ? [] : ["aborted before sampling"] }; } catch (error) { if (options.signal?.aborted || (error instanceof Error && error.message === "aborted")) { const metricFailure = samples.some(s => s.runner.cpuPercent === null || s.runner.rssBytes === null); return { samples, valid: samples.length > 0 && !metricFailure, validityReasons: metricFailure ? ["runner metric unavailable"] : samples.length ? [] : ["aborted before sampling"] }; } return { samples, valid: false, validityReasons: ["resource sample failed"] }; } finally { event.disable(); }
}
