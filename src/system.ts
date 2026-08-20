import os from "node:os";
import process from "node:process";
import { execFile } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createRequire } from "node:module";
import type { BackendInfo } from "./backend.js";

export type Optional<T> = { value: T | null; reason?: string };
export interface PsProcess { pid: number; cpuPercent: number; rssBytes: number }
export interface DockerStat { containerId: string; cpuPercent: number; memoryBytes: number; blockReadBytes: number; blockWriteBytes: number }
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
function statNumber(value: unknown, percent = false): number | null { const n = Number(String(value ?? "").replace(/%$/, "").trim()); return validNumber(n) && (!percent || n <= 100) ? n : null; }
export function parseDockerStats(text: string, ownedIds?: ReadonlySet<string>): DockerStat[] {
  const result: DockerStat[] = [];
  for (const line of text.split(/\r?\n/)) {
    try {
      const row: any = JSON.parse(line); const id = typeof row.ID === "string" ? row.ID : typeof row.Container === "string" ? row.Container : null;
      if (!id || !/^[0-9a-f]+$/i.test(id) || (ownedIds && !ownedIds.has(id))) continue;
      const cpu = statNumber(row.CPUPerc, true); const memory = parseByteUnit(String(row.MemUsage ?? "").split("/")[0] ?? ""); const io = String(row.BlockIO ?? "").split("/");
      const read = parseByteUnit(io[0] ?? ""); const write = parseByteUnit(io[1] ?? "");
      if (cpu !== null && memory !== null && read !== null && write !== null) result.push({ containerId: id, cpuPercent: cpu, memoryBytes: memory, blockReadBytes: read, blockWriteBytes: write });
    } catch { /* malformed probe rows are unavailable, never zero */ }
  }
  return result;
}

export interface EventLoopSnapshot { p99Ms: number | null; maxMs: number | null; reason?: string }
export interface ProcessResourceSnapshot { pid: number; cpuPercent: number | null; rssBytes: number | null; reason?: string }
export interface ResourceSnapshot { timestampNs: number; runner: ProcessResourceSnapshot; backend: { totalCpuPercent: number | null; totalRssBytes: number | null; processes: ProcessResourceSnapshot[]; reason?: string }; containers: DockerStat[] | null; containerReason?: string; eventLoop: EventLoopSnapshot }
export interface RunnerSnapshot { timestampNs: number; runner: { cpuPercent: number | null; rssBytes: number | null }; eventLoop: EventLoopSnapshot; backend: Record<string, unknown> }
export interface OverloadThresholds { cpuPercent?: number; p99Ms?: number; maxMs?: number; consecutiveSamples?: number }
export function evaluateRunnerOverload(samples: RunnerSnapshot[], thresholds: OverloadThresholds = {}): string | null {
  for (const [key, value] of Object.entries(thresholds)) if (key !== "consecutiveSamples" && value !== undefined && (!validNumber(value) || value < 0)) throw new Error(`${key} must be finite and nonnegative`);
  const count = thresholds.consecutiveSamples ?? 3; if (!positive(count)) throw new Error("consecutiveSamples must be positive");
  if (!samples.length || samples.some(s => !Number.isFinite(s.timestampNs) || s.timestampNs < 0)) return "invalid snapshot timestamp";
  const relevant = samples.slice(-count); if (relevant.length < count) return null;
  const runnerCpu = thresholds.cpuPercent !== undefined && relevant.every(s => s.runner.cpuPercent !== null && s.runner.cpuPercent > thresholds.cpuPercent!);
  const p99 = thresholds.p99Ms !== undefined && relevant.every(s => s.eventLoop.p99Ms !== null && s.eventLoop.p99Ms > thresholds.p99Ms!);
  const max = thresholds.maxMs !== undefined && relevant.every(s => s.eventLoop.maxMs !== null && s.eventLoop.maxMs > thresholds.maxMs!);
  if (runnerCpu) return "runner CPU sustained above threshold"; if (p99) return "event-loop p99 sustained above threshold"; if (max) return "event-loop max sustained above threshold";
  return null;
}

export interface CommandResult { stdout: string; stderr: string }
export type CommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<CommandResult>;
const defaultRunner: CommandRunner = (command, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => error ? reject(new Error("command failed")) : resolve({ stdout: String(stdout), stderr: String(stderr) }));
});
function version(text: string): string | null { const m = text.match(/\b\d+(?:\.\d+){1,3}\b/); return m?.[0] ?? null; }
function packageVersion(name: string): string | null { try { const metadata = createRequire(import.meta.url)(`${name}/package.json`) as { version?: unknown }; return typeof metadata.version === "string" && /^\d+(?:\.\d+){1,3}$/.test(metadata.version) ? metadata.version : null; } catch { return null; } }
export interface Environment { os: string; release: string; arch: string; cpuModel: string | null; logicalCores: number | null; totalMemoryBytes: number | null; hostname: string; nodeVersion: string; npmVersion: string | null; gitCommit: string | null; gitDirty: boolean | null; backend: BackendInfo; sdkVersion: string | null; dockerVersion: string | null; supabaseVersion: string | null; unavailable: Record<string, string> }
export async function captureEnvironment(backend: BackendInfo, sdkVersion?: string, runner: CommandRunner = defaultRunner): Promise<Environment> {
  const unavailable: Record<string, string> = {}; const run = async (command: string, args: string[]): Promise<string | null> => { try { return (await runner(command, args, 3000)).stdout.trim(); } catch { unavailable[command] = "probe unavailable"; return null; } };
  const cpuText = process.platform === "darwin" ? await run("sysctl", ["-a"]) : await run("cat", ["/proc/cpuinfo"]); const cpu = process.platform === "darwin" ? parseSysctl(cpuText ?? "") : parseCpuInfo(cpuText ?? "");
  const memory = process.platform === "linux" ? parseMemInfo((await run("cat", ["/proc/meminfo"])) ?? "") : parseSysctl(cpuText ?? "").memoryBytes;
  if (cpu.logicalCores === null) unavailable.logicalCores = "CPU probe unavailable"; if (memory === null) unavailable.totalMemoryBytes = "memory probe unavailable";
  const commit = await run("git", ["rev-parse", "HEAD"]); const dirtyText = commit === null ? null : await run("git", ["status", "--porcelain"]); const npmText = await run("npm", ["--version"]);
  const dockerText = backend.name === "supabase" ? await run("docker", ["--version"]) : null; const supabaseText = backend.name === "supabase" ? await run("supabase", ["--version"]) : null;
  const gitCommit = commit && /^[0-9a-f]{40}$/i.test(commit) ? commit : null; const gitDirty = dirtyText === null ? null : dirtyText.length > 0;
  if (!gitCommit) unavailable.gitCommit = "git commit unavailable"; if (gitDirty === null) unavailable.gitDirty = "git status unavailable";
  const sdkPackage = backend.name === "pocketbase" ? "pocketbase" : backend.name === "supabase" ? "@supabase/supabase-js" : "trailbase"; const detectedSdk = sdkVersion ?? packageVersion(sdkPackage); if (!detectedSdk) unavailable.sdkVersion = "SDK metadata unavailable";
  return { os: process.platform, release: os.release(), arch: process.arch, cpuModel: cpu.model, logicalCores: cpu.logicalCores, totalMemoryBytes: memory ?? (Number.isSafeInteger(os.totalmem()) ? os.totalmem() : null), hostname: os.hostname(), nodeVersion: process.version, npmVersion: version(npmText ?? ""), gitCommit, gitDirty, backend, sdkVersion: detectedSdk, dockerVersion: version(dockerText ?? ""), supabaseVersion: version(supabaseText ?? ""), unavailable };
}

export interface EventLoopMonitor { percentile(p: number): number; max: number; reset(): void; disable(): void }
export interface ResourceSamplerOptions { backend: BackendInfo; maxSamples?: number; runnerPid?: number; commandRunner?: CommandRunner; nowNs?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; eventLoop?: EventLoopMonitor; intervalMs?: number; signal?: AbortSignal }
const monitor = (): EventLoopMonitor => { const h = monitorEventLoopDelay({ resolution: 10 }); h.enable(); return { percentile: p => h.percentile(p), max: h.max, reset: () => h.reset(), disable: () => h.disable() }; };
const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => { if (signal?.aborted) return reject(new Error("aborted")); let done = false; const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); error ? reject(error) : resolve(); }; const onAbort = () => finish(new Error("aborted")); const timer = setTimeout(() => finish(), ms); signal?.addEventListener("abort", onAbort, { once: true }); });
function ownedPids(info: BackendInfo, runnerPid: number): number[] { const pids = [runnerPid, ...(info.processIds ?? [])]; if (pids.some(pid => !positive(pid))) throw new Error("processIds must be positive safe integers"); return [...new Set(pids)]; }
export async function sampleResources(options: ResourceSamplerOptions): Promise<ResourceSnapshot> {
  const pid = options.runnerPid ?? process.pid; if (!positive(pid)) throw new Error("runnerPid must be positive"); const now = options.nowNs ?? (() => Number(process.hrtime.bigint())); const run = options.commandRunner ?? defaultRunner; const info = options.backend;
  const pids = info.name === "supabase" ? [pid] : ownedPids(info, pid); const ps = await run("ps", ["-o", "pid=,pcpu=,rss=", "-p", pids.join(",")], 3000).catch(() => ({ stdout: "", stderr: "" })); const rows = parsePs(ps.stdout); const byPid = new Map(rows.map(row => [row.pid, row]));
  const proc = pids.map(p => { const row = byPid.get(p); return row ? { pid: p, cpuPercent: row.cpuPercent, rssBytes: row.rssBytes } : { pid: p, cpuPercent: null, rssBytes: null, reason: "owned process missing or malformed" }; }); const runner = proc.find(p => p.pid === pid)!; const backendProc = proc.filter(p => p.pid !== pid); const event = options.eventLoop ?? monitor(); const p99 = event.percentile(99); const max = event.max; const eventLoop = validNumber(p99) && validNumber(max) && max > 0 ? { p99Ms: p99 / 1e6, maxMs: max / 1e6 } : { p99Ms: null, maxMs: null, reason: "not enough event-loop observations" };
  let containers: DockerStat[] | null = null; let containerReason: string | undefined;
  if (info.name === "supabase") { const project = info.supabaseProjectId; if (!project || !/^[A-Za-z0-9_.-]+$/.test(project)) containerReason = "explicit Supabase project ID required"; else { const discovered = await run("docker", ["ps", "-q", "--filter", `label=com.supabase.cli.project=${project}`], 3000).catch(() => ({ stdout: "", stderr: "" })); const ids = (discovered.stdout ?? "").trim().split(/\s+/).filter(id => /^[0-9a-f]+$/i.test(id)); if (!ids.length) containerReason = "no owned containers discovered"; else { const stats = await run("docker", ["stats", "--no-stream", "--format", "{{json .}}", ...ids], 3000).catch(() => ({ stdout: "", stderr: "" })); containers = parseDockerStats(stats.stdout, new Set(ids)); if (containers.length !== ids.length) containerReason = "owned container metrics unavailable"; } } }
  event.reset(); const timestampNs = now(); if (!Number.isFinite(timestampNs) || timestampNs < 0) throw new Error("monotonic timestamp must be finite and nonnegative"); const snapshot = { timestampNs, runner, backend: { totalCpuPercent: backendProc.every(p => p.cpuPercent !== null) ? backendProc.reduce((a, p) => a + (p.cpuPercent ?? 0), 0) : null, totalRssBytes: backendProc.every(p => p.rssBytes !== null) ? backendProc.reduce((a, p) => a + (p.rssBytes ?? 0), 0) : null, processes: backendProc, reason: backendProc.some(p => p.cpuPercent === null || p.rssBytes === null) ? "owned process metric unavailable" : undefined }, containers, containerReason, eventLoop }; if (!options.eventLoop) event.disable(); return snapshot;
}
export interface ResourceCollection { samples: ResourceSnapshot[]; valid: boolean; validityReasons: string[] }
export async function collectResources(options: ResourceSamplerOptions): Promise<ResourceCollection> {
  const max = options.maxSamples ?? 100; if (!positive(max)) throw new Error("maxSamples must be a positive safe integer"); const samples: ResourceSnapshot[] = []; const event = options.eventLoop ?? monitor(); const sleep = options.sleep ?? defaultSleep;
  try { if (options.signal?.aborted) return { samples, valid: false, validityReasons: ["aborted before sampling"] }; for (let i = 0; i < max; i++) { if (options.signal?.aborted) break; samples.push(await sampleResources({ ...options, eventLoop: event })); if (i + 1 < max) await sleep(options.intervalMs ?? 1000, options.signal); } return { samples, valid: !options.signal?.aborted, validityReasons: options.signal?.aborted ? ["aborted"] : [] }; } catch (error) { if (options.signal?.aborted || (error instanceof Error && error.message === "aborted")) return { samples, valid: false, validityReasons: ["aborted"] }; throw error; } finally { event.disable(); }
}
export const captureResources = sampleResources;
export const createResourceCollector = collectResources;
