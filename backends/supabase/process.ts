import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import type { BackendInfo } from "../../src/backend.js";
import { parsePortBase } from "../../src/port-base.js";

export const SUPABASE_VERSION = "2.115.0";
export const SUPABASE_PROJECT_ID = "realworldbaasbench";
export interface SupabasePorts { api: number; db: number; studio: number; inbucket: number; smtp: number; pop3: number; analytics: number; pooler: number; shadow: number; }
export const SUPABASE_PORTS: Readonly<SupabasePorts> = Object.freeze({ api: 55321, db: 55322, studio: 55323, inbucket: 55324, smtp: 55325, pop3: 55326, analytics: 55327, pooler: 55329, shadow: 55330 });
export const LOCAL_BENCHMARK_PASSWORD = "Benchmark-local-only-supabase!";
const MAX_OUTPUT = 1_000_000;
const OWNER_FILE = ".bench-supabase-owner.json";

export interface SupabaseOptions {
  repoRoot: string;
  binary: string;
  projectId: string;
  workdir: string;
  ports: Readonly<SupabasePorts>;
  generatedWorkdir: boolean;
}
export interface SupabaseStatus {
  API_URL: string;
  REST_URL?: string;
  ANON_KEY?: string;
  PUBLISHABLE_KEY?: string;
  SERVICE_ROLE_KEY?: string;
  SECRET_KEY?: string;
  [key: string]: unknown;
}

function findRepoRoot(from = dirname(fileURLToPath(import.meta.url))): string {
  let current = resolve(from);
  while (parse(current).root !== current) {
    if (existsSync(join(current, "package.json"))) return current;
    current = dirname(current);
  }
  throw new Error("Could not locate benchmark repository root");
}

export function resolveSupabaseOptions(env: NodeJS.ProcessEnv = process.env, repoRoot = findRepoRoot()): SupabaseOptions {
  const binary = env.SUPABASE_BIN || "supabase";
  const portBase = parsePortBase(env.BENCH_PORT_BASE);
  const root = resolve(repoRoot);
  const ports = portBase === undefined ? SUPABASE_PORTS : Object.freeze({ api: portBase, db: portBase + 1, studio: portBase + 2, inbucket: portBase + 3, smtp: portBase + 4, pop3: portBase + 5, analytics: portBase + 6, pooler: portBase + 8, shadow: portBase + 9 });
  return {
    repoRoot: root,
    binary: binary.includes("/") ? (isAbsolute(binary) ? binary : resolve(repoRoot, binary)) : binary,
    projectId: portBase === undefined ? SUPABASE_PROJECT_ID : `${SUPABASE_PROJECT_ID}-${portBase}`,
    workdir: portBase === undefined ? resolve(root, "backends/supabase") : resolve(root, `.data/supabase-${portBase}`),
    ports,
    generatedWorkdir: portBase !== undefined,
  };
}

async function safeDataRoot(options: SupabaseOptions): Promise<string> {
  const dataRoot = join(options.repoRoot, ".data");
  await mkdir(dataRoot, { recursive: true });
  const stat = await lstat(dataRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing unsafe Supabase data directory");
  return dataRoot;
}

export async function acquireSupabaseLifecycleLock(options: SupabaseOptions): Promise<string> {
  const directory = join(await safeDataRoot(options), "supabase-locks");
  await mkdir(directory, { recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing unsafe Supabase lifecycle lock directory");
  const path = join(directory, `${options.projectId}.lock`);
  try { await writeFile(path, JSON.stringify({ pid: process.pid, projectId: options.projectId, workdir: options.workdir }) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another Supabase lifecycle is active"); throw error; }
  return path;
}

export async function releaseSupabaseLifecycleLock(path: string): Promise<void> { await unlink(path); }

const generatedConfig = (options: SupabaseOptions): string => `project_id = "${options.projectId}"
[api]
port = ${options.ports.api}
[db]
port = ${options.ports.db}
shadow_port = ${options.ports.shadow}
[studio]
port = ${options.ports.studio}
[local_smtp]
port = ${options.ports.inbucket}
smtp_port = ${options.ports.smtp}
pop3_port = ${options.ports.pop3}
[analytics]
port = ${options.ports.analytics}
[db.pooler]
port = ${options.ports.pooler}
`;

export async function prepareSupabaseWorkdir(options: SupabaseOptions): Promise<void> {
  if (!options.generatedWorkdir) return;
  await safeDataRoot(options);
  await mkdir(options.workdir, { recursive: true });
  const stat = await lstat(options.workdir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing non-directory Supabase workdir");
  const markerPath = join(options.workdir, OWNER_FILE);
  const entries = await readdir(options.workdir);
  if (entries.length) {
    let owner: unknown;
    try { owner = JSON.parse(await readFile(markerPath, "utf8")); } catch { throw new Error("Refusing unowned nonempty Supabase workdir"); }
    if (!owner || typeof owner !== "object" || (owner as { projectId?: unknown }).projectId !== options.projectId || (owner as { workdir?: unknown }).workdir !== options.workdir) throw new Error("Refusing unowned or mismatched Supabase workdir");
  } else {
    await writeFile(markerPath, JSON.stringify({ projectId: options.projectId, workdir: options.workdir }) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  const target = join(options.workdir, "supabase");
  const targetStat = await lstat(target).catch(() => undefined);
  if (targetStat && (!targetStat.isDirectory() || targetStat.isSymbolicLink())) throw new Error("Refusing unsafe generated Supabase config directory");
  const migrations = join(target, "migrations");
  const migrationsStat = await lstat(migrations).catch(() => undefined);
  if (migrationsStat && (!migrationsStat.isDirectory() || migrationsStat.isSymbolicLink())) throw new Error("Refusing unsafe generated Supabase migrations directory");
  const config = join(target, "config.toml");
  const configStat = await lstat(config).catch(() => undefined);
  if (configStat && (!configStat.isFile() || configStat.isSymbolicLink())) throw new Error("Refusing unsafe generated Supabase config file");
  await mkdir(migrations, { recursive: true });
  await cp(join(options.repoRoot, "backends/supabase/supabase/migrations"), migrations, { recursive: true, force: true });
  await writeFile(config, generatedConfig(options), { encoding: "utf8", mode: 0o600 });
}

export function buildSupabaseArgs(options: SupabaseOptions, args: readonly string[]): string[] {
  return ["--workdir", options.workdir, ...args];
}

export function supabaseEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...source };
  for (const key of Object.keys(result)) {
    if (key === "SUPABASE_PROJECT_ID" || key === "SUPABASE_WORKDIR" || key === "SUPABASE_NETWORK_ID" || /^SUPABASE_.*_PORT$/.test(key) || /(?:^|_)(?:PASSWORD|TOKEN|KEY|SECRET|CREDENTIAL)(?:_|$)/i.test(key) || /(?:^|_)(?:DATABASE_URL|DB_URL)$/i.test(key) || /^PGPASSWORD$/i.test(key)) delete result[key];
  }
  return result;
}

export function redactSupabaseOutput(value: string): string {
  return value
    .replace(/\b(postgres(?:ql)?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/(["']?\b(?:service[_ ]role|secret|publishable|anon|jwt|database|db|access|refresh)?[ _-]*(?:key|password|token|credential|secret)\b["']?\s*[:=]\s*)["']?[^\s,"'}]+["']?/gi, "$1<redacted>")
    .replace(/(["']?\b(?:[A-Za-z][A-Za-z0-9]*_)*(?:PASSWORD|PASS|TOKEN|KEY|SECRET|CREDENTIAL)(?:_[A-Za-z0-9]+)*["']?\s*[:=]\s*)["']?[^\s,"'}]+["']?/gi, "$1<redacted>");
}

export function parseSupabaseStatus(stdout: string): SupabaseStatus {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error("Invalid Supabase status JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Supabase status JSON");
  const status = parsed as Record<string, unknown>;
  if (typeof status.API_URL !== "string" || !status.API_URL.startsWith("http://127.0.0.1:")) throw new Error("Supabase status is missing a local API URL");
  return status as SupabaseStatus;
}

export function runSynchronousProbe(binary: string, args: readonly string[], label: string, timeoutMs = 10_000): string {
  const result = spawnSync(binary, args, { encoding: "utf8", shell: false, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") throw new Error(`${label} probe timed out`);
  if (result.error || result.status !== 0) throw new Error(`${label} probe failed`);
  return result.stdout;
}

function killProcessGroup(child: ReturnType<typeof spawn>): void {
  if (child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* process may have already exited */ }
  }
  try { child.kill("SIGKILL"); } catch { /* process may have already exited */ }
}

export function runSupabase(options: SupabaseOptions, args: readonly string[], timeoutMs = 300_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(options.binary, buildSupabaseArgs(options, args), {
      cwd: options.repoRoot,
      shell: false,
      detached: true,
      env: supabaseEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", overflow = false, settled = false;
    const append = (current: string, chunk: unknown): string => {
      const next = current + String(chunk);
      if (next.length > MAX_OUTPUT) { overflow = true; killProcessGroup(child); return next.slice(0, MAX_OUTPUT); }
      return next;
    };
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolveRun({ stdout, stderr });
    };
    const timer = setTimeout(() => { killProcessGroup(child); finish(new Error("Supabase command timed out")); }, timeoutMs);
    child.once("error", error => finish(new Error(`Supabase command failed: ${redactSupabaseOutput(error.message)}`)));
    child.once("close", code => {
      if (overflow) return finish(new Error("Supabase command output exceeded limit"));
      if (code !== 0) return finish(new Error(`Supabase command exited ${code}: ${redactSupabaseOutput(stderr).slice(0, 4000)}`));
      finish();
    });
  });
}

export async function portAvailable(port: number): Promise<boolean> {
  return new Promise(resolveResult => {
    const server = createServer();
    server.once("error", () => resolveResult(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolveResult(true)));
  });
}

function ownContainerIds(projectId: string, runningOnly = false): string[] {
  const stdout = runSynchronousProbe("docker", ["ps", runningOnly ? "-q" : "-aq", "--filter", `label=com.supabase.cli.project=${projectId}`], "Docker");
  return stdout.trim() ? stdout.trim().split(/\s+/).filter(id => /^[0-9a-f]+$/i.test(id)) : [];
}
function removeOwnContainers(projectId: string): void {
  const stdout = runSynchronousProbe("docker", ["ps", "-aq", "--filter", `label=com.supabase.cli.project=${projectId}`], "Docker");
  const ids = stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length) runSynchronousProbe("docker", ["rm", "-f", ...ids], "Docker");
}

export function assertSupabaseContainerOwnership(containerIds: readonly string[], lifecycleAcquired: boolean): void {
  if (containerIds.length && !lifecycleAcquired) throw new Error("Refusing Supabase containers owned by another lifecycle");
}

export class SupabaseProcess {
  private lifecycleAcquired = false;
  private lifecycleLock?: string;
  constructor(readonly options = resolveSupabaseOptions()) {}

  private async releaseLifecycleLock(): Promise<void> {
    if (!this.lifecycleLock) return;
    await releaseSupabaseLifecycleLock(this.lifecycleLock);
    this.lifecycleLock = undefined;
  }

  async doctor(): Promise<BackendInfo> {
    const version = runSynchronousProbe(this.options.binary, ["--version"], "Supabase CLI");
    if (version.trim() !== SUPABASE_VERSION) throw new Error(`Supabase CLI ${SUPABASE_VERSION} is required`);
    const allIds = ownContainerIds(this.options.projectId);
    assertSupabaseContainerOwnership(allIds, this.lifecycleAcquired);
    const ids = ownContainerIds(this.options.projectId, true);
    if (ids.length) {
      const status = await this.status();
      return { name: "supabase", version: SUPABASE_VERSION, endpoint: status.API_URL, supabaseProjectId: this.options.projectId };
    }
    for (const port of Object.values(this.options.ports)) {
      if (!(await portAvailable(port))) throw new Error(`Supabase benchmark port ${port} is in use by another process`);
    }
    return { name: "supabase", version: SUPABASE_VERSION, endpoint: `http://127.0.0.1:${this.options.ports.api}`, processIds: [], supabaseProjectId: this.options.projectId };
  }

  async start(): Promise<SupabaseStatus> {
    if (!this.lifecycleLock) this.lifecycleLock = await acquireSupabaseLifecycleLock(this.options);
    try {
      assertSupabaseContainerOwnership(ownContainerIds(this.options.projectId), this.lifecycleAcquired);
      const ids = ownContainerIds(this.options.projectId, true);
      if (!ids.length) {
        await prepareSupabaseWorkdir(this.options);
        for (const port of Object.values(this.options.ports)) if (!(await portAvailable(port))) throw new Error(`Supabase benchmark port ${port} is unavailable`);
        this.lifecycleAcquired = true;
        await runSupabase(this.options, ["start"]);
      }
      return await this.status();
    } catch (error) {
      if (this.lifecycleAcquired) await this.stop().catch(() => undefined);
      else await this.releaseLifecycleLock().catch(() => undefined);
      throw error;
    }
  }

  async status(): Promise<SupabaseStatus> {
    const status = parseSupabaseStatus((await runSupabase(this.options, ["status", "-o", "json"], 60_000)).stdout);
    if (new URL(status.API_URL).port !== String(this.options.ports.api)) throw new Error("Supabase status returned the wrong project endpoint");
    return status;
  }

  async reset(): Promise<SupabaseStatus> {
    await this.start();
    await runSupabase(this.options, ["db", "reset", "--local"]);
    return this.status();
  }

  async stop(): Promise<void> {
    const ids = ownContainerIds(this.options.projectId);
    if (!ids.length) { this.lifecycleAcquired = false; await this.releaseLifecycleLock(); return; }
    if (!this.lifecycleAcquired) return;
    await runSupabase(this.options, ["stop", "--project-id", this.options.projectId, "--no-backup"]);
    removeOwnContainers(this.options.projectId);
    if (ownContainerIds(this.options.projectId).length) throw new Error("Supabase benchmark containers did not stop");
    this.lifecycleAcquired = false;
    await this.releaseLifecycleLock();
  }
}

export const supabaseProcess = new SupabaseProcess();
