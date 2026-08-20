import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import type { BackendInfo } from "../../src/backend.js";

export const SUPABASE_VERSION = "2.115.0";
export const SUPABASE_PROJECT_ID = "realworldbaasbench";
export const SUPABASE_PORTS = Object.freeze({ api: 55321, db: 55322, studio: 55323, inbucket: 55324, smtp: 55325, pop3: 55326, analytics: 55327, pooler: 55329, shadow: 55330 });
export const LOCAL_BENCHMARK_PASSWORD = "Benchmark-local-only-supabase!";
const MAX_OUTPUT = 1_000_000;

export interface SupabaseOptions {
  repoRoot: string;
  binary: string;
  projectId: string;
  workdir: string;
  ports: typeof SUPABASE_PORTS;
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
  return {
    repoRoot: resolve(repoRoot),
    binary: binary.includes("/") ? (isAbsolute(binary) ? binary : resolve(repoRoot, binary)) : binary,
    projectId: SUPABASE_PROJECT_ID,
    workdir: resolve(repoRoot, "backends/supabase"),
    ports: SUPABASE_PORTS,
  };
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

function ownContainerIds(projectId: string, runningOnly = false): number[] {
  const stdout = runSynchronousProbe("docker", ["ps", runningOnly ? "-q" : "-aq", "--filter", `label=com.supabase.cli.project=${projectId}`], "Docker");
  return stdout.trim() ? stdout.trim().split(/\s+/).map(id => Number.parseInt(id.slice(0, 8), 16)) : [];
}
function removeOwnContainers(projectId: string): void {
  const stdout = runSynchronousProbe("docker", ["ps", "-aq", "--filter", `label=com.supabase.cli.project=${projectId}`], "Docker");
  const ids = stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length) runSynchronousProbe("docker", ["rm", "-f", ...ids], "Docker");
}

export class SupabaseProcess {
  constructor(readonly options = resolveSupabaseOptions()) {}

  async doctor(): Promise<BackendInfo> {
    const version = runSynchronousProbe(this.options.binary, ["--version"], "Supabase CLI");
    if (version.trim() !== SUPABASE_VERSION) throw new Error(`Supabase CLI ${SUPABASE_VERSION} is required`);
    const ids = ownContainerIds(this.options.projectId, true);
    if (ids.length) {
      const status = await this.status();
      return { name: "supabase", version: SUPABASE_VERSION, endpoint: status.API_URL, processIds: ids };
    }
    for (const port of Object.values(this.options.ports)) {
      if (!(await portAvailable(port))) throw new Error(`Supabase benchmark port ${port} is in use by another process`);
    }
    return { name: "supabase", version: SUPABASE_VERSION, endpoint: `http://127.0.0.1:${this.options.ports.api}`, processIds: [] };
  }

  async start(): Promise<SupabaseStatus> {
    if (!ownContainerIds(this.options.projectId, true).length) {
      for (const port of Object.values(this.options.ports)) if (!(await portAvailable(port))) throw new Error(`Supabase benchmark port ${port} is unavailable`);
      await runSupabase(this.options, ["start"]);
    }
    return this.status();
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
    if (!ownContainerIds(this.options.projectId).length) return;
    await runSupabase(this.options, ["stop", "--project-id", this.options.projectId, "--no-backup"]);
    removeOwnContainers(this.options.projectId);
    if (ownContainerIds(this.options.projectId).length) throw new Error("Supabase benchmark containers did not stop");
  }
}

export const supabaseProcess = new SupabaseProcess();
