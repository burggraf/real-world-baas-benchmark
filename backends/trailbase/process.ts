import { existsSync } from "node:fs";
import { access, appendFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { BackendInfo } from "../../src/backend.js";

export const TRAILBASE_VERSION = "0.33.1";
export const LOCAL_SETUP_EMAIL = "setup@trailbase.bench.test";
export const LOCAL_SETUP_PASSWORD = "TrailBase-setup-only-39!";
export const LOCAL_BENCHMARK_PASSWORD = "Benchmark-local-only-39!";
const OWNER_FILE = ".bench-trailbase-owner.json";
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;

export interface TrailBaseProcessOptions {
  repoRoot: string;
  binary: string;
  dataDir: string;
  migrationsDir: string;
  endpoint: string;
  listen: string;
  logFile: string;
}

function findRepoRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (parse(current).root !== current) {
    if (existsSync(join(current, "package.json"))) return current;
    current = dirname(current);
  }
  throw new Error("Could not locate benchmark repository root");
}

const absolute = (root: string, value: string): string => isAbsolute(value) ? value : resolve(root, value);

export function resolveTrailBaseOptions(
  env: { TRAILBASE_BIN?: string; TRAILBASE_URL?: string; TRAILBASE_DATA_DIR?: string } = process.env,
  repoRoot = findRepoRoot(),
): TrailBaseProcessOptions {
  const endpointUrl = new URL(env.TRAILBASE_URL || "http://127.0.0.1:8090");
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (endpointUrl.protocol !== "http:" || !localHosts.has(endpointUrl.hostname) || endpointUrl.username || endpointUrl.password) {
    throw new Error("TRAILBASE_URL must be a local HTTP endpoint");
  }
  if (endpointUrl.pathname !== "/" || endpointUrl.search || endpointUrl.hash) {
    throw new Error("TRAILBASE_URL must not contain a path, query, or fragment");
  }
  const port = endpointUrl.port || "80";
  const root = resolve(repoRoot);
  const dataDir = absolute(root, env.TRAILBASE_DATA_DIR || ".data/trailbase");
  return {
    repoRoot: root,
    binary: absolute(root, env.TRAILBASE_BIN || `.tools/trailbase-${TRAILBASE_VERSION}/trailbase`),
    dataDir,
    migrationsDir: join(root, "backends/trailbase/migrations"),
    endpoint: endpointUrl.origin,
    listen: `${endpointUrl.hostname === "::1" ? "[::1]" : endpointUrl.hostname}:${port}`,
    logFile: join(root, ".data/logs/trailbase.log"),
  };
}

export function buildTrailBaseArgs(options: TrailBaseProcessOptions, command: readonly string[]): string[] {
  return ["--depot", options.dataDir, ...command];
}

function running(child: ChildProcess | undefined): child is ChildProcess {
  return !!child && child.exitCode === null && child.signalCode === null;
}

function findTrailBaseProcessUsing(dataDir: string): number | undefined {
  if (process.platform === "win32") return undefined;
  const result = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8", shell: false });
  if (result.error || result.status !== 0) return undefined;
  const marker = resolve(dataDir);
  for (const line of result.stdout.split("\n")) {
    if (!line.includes(marker) || !line.toLowerCase().includes("trail") || !line.includes("--depot")) continue;
    const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0] || "", 10);
    if (Number.isInteger(pid) && pid !== process.pid) return pid;
  }
  return undefined;
}

async function health(endpoint: string): Promise<boolean> {
  try {
    // v0.33.1 has no health route; a bounded GET to the auth endpoint proves the listener.
    const response = await fetch(`${endpoint}/api/auth/v1/login`, { signal: AbortSignal.timeout(750) });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function portAvailable(listen: string): Promise<boolean> {
  const split = listen.lastIndexOf(":");
  const host = listen.slice(0, split).replace(/^\[|\]$/g, "");
  const port = Number(listen.slice(split + 1));
  return new Promise((resolveResult) => {
    const server = createServer();
    server.once("error", () => resolveResult(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolveResult(true)));
  });
}

export function assertResetDataDirectorySafe(repoRoot: string, dataDir: string, owned: boolean): void {
  const root = resolve(repoRoot);
  const resolved = resolve(dataDir);
  const home = resolve(process.env.HOME || parse(resolved).root);
  const isAncestor = (parent: string, child: string): boolean => child === parent || child.startsWith(`${parent}/`);
  if (resolved === parse(resolved).root || resolved === root || resolved === home || isAncestor(resolved, root)) {
    throw new Error("Refusing to remove a filesystem root, repository, home, or ancestor path");
  }
  if (!owned) throw new Error("Refusing to remove data directory without verified ownership");
}

async function readOwner(dataDir: string): Promise<{ pid: number; binary: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(join(dataDir, OWNER_FILE), "utf8")) as { pid?: unknown; binary?: unknown };
    return typeof value.pid === "number" && typeof value.binary === "string" ? { pid: value.pid, binary: value.binary } : undefined;
  } catch {
    return undefined;
  }
}

export class TrailBaseProcess {
  readonly options: TrailBaseProcessOptions;
  private child?: ChildProcess;

  constructor(options = resolveTrailBaseOptions()) {
    this.options = options;
  }

  async doctor(): Promise<BackendInfo> {
    await access(this.options.binary);
    await access(join(this.options.repoRoot, "backends/trailbase/config.textproto"));
    await access(this.options.migrationsDir);
    const version = spawnSync(this.options.binary, ["--version"], { encoding: "utf8", shell: false });
    if (version.error || version.status !== 0 || !version.stdout.includes(`v${TRAILBASE_VERSION}`)) {
      throw new Error(`Expected TrailBase ${TRAILBASE_VERSION} binary`);
    }
    if (running(this.child)) {
      if (!await health(this.options.endpoint)) throw new Error("Owned TrailBase process is unhealthy");
    } else if (!await portAvailable(this.options.listen)) {
      throw new Error(`TrailBase port is already in use at ${this.options.endpoint}`);
    }
    return {
      name: "trailbase",
      version: TRAILBASE_VERSION,
      endpoint: this.options.endpoint,
      processIds: running(this.child) && this.child.pid ? [this.child.pid] : [],
      deviations: ["TrailBase list-rule denial returns an empty page; protected record denial is concealed as 404."],
    };
  }

  async start(): Promise<void> {
    if (running(this.child)) {
      if (!await health(this.options.endpoint)) throw new Error("Owned TrailBase process is unhealthy");
      return;
    }
    await this.doctor();
    await mkdir(this.options.dataDir, { recursive: true });
    await mkdir(dirname(this.options.logFile), { recursive: true });
    const child = spawn(this.options.binary, buildTrailBaseArgs(this.options, ["run", "--address", this.options.listen]), {
      cwd: this.options.repoRoot,
      detached: false,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const writeLog = (chunk: Buffer | string) => {
      const safe = String(chunk).replace(/(password\s*[:=]\s*)['"]?[^'"\s]+/gi, "$1[REDACTED]");
      void appendFile(this.options.logFile, safe.slice(0, 64 * 1024));
    };
    child.stdout?.on("data", writeLog);
    child.stderr?.on("data", writeLog);
    this.child = child;
    try {
      await writeFile(join(this.options.dataDir, OWNER_FILE), JSON.stringify({ pid: child.pid, binary: this.options.binary }), { mode: 0o600 });
    } catch (error) {
      await this.stop();
      throw error;
    }
    let startupError: Error | undefined;
    child.once("error", (error) => { startupError = error; });
    child.once("exit", () => { if (this.child === child) this.child = undefined; });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (startupError || !running(child)) {
        this.child = undefined;
        throw new Error("TrailBase process exited during startup");
      }
      if (await health(this.options.endpoint)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    await this.stop();
    throw new Error("TrailBase health check timed out");
  }

  async reset(): Promise<void> {
    await this.stop();
    const externalPid = findTrailBaseProcessUsing(this.options.dataDir);
    if (externalPid) throw new Error("Refusing to reset data directory used by an externally-owned TrailBase process");
    const owner = await readOwner(this.options.dataDir);
    const entries = await readdir(this.options.dataDir).catch(() => [] as string[]);
    const ownerProcessAlive = owner ? (() => { try { process.kill(owner.pid, 0); return true; } catch { return false; } })() : false;
    if (owner && resolve(owner.binary) !== resolve(this.options.binary)) throw new Error("Refusing to remove data directory owned by another binary");
    assertResetDataDirectorySafe(this.options.repoRoot, this.options.dataDir, !entries.length || (!!owner && !ownerProcessAlive));
    await rm(this.options.dataDir, { recursive: true, force: true });
    await mkdir(this.options.dataDir, { recursive: true });
    await mkdir(dirname(this.options.logFile), { recursive: true });
    await mkdir(join(this.options.dataDir, "migrations", "main"), { recursive: true });
    await cp(this.options.migrationsDir, join(this.options.dataDir, "migrations", "main"), { recursive: true });
    const config = join(this.options.repoRoot, "backends/trailbase/config.textproto");
    await cp(config, join(this.options.dataDir, "config.textproto"));
    await this.start();
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!running(child)) {
      this.child = undefined;
      return;
    }
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, STOP_TIMEOUT_MS))]);
    if (running(child)) {
      child.kill("SIGKILL");
      await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, STOP_TIMEOUT_MS))]);
    }
    if (running(child)) throw new Error("Owned TrailBase process did not stop");
    if (this.child === child) this.child = undefined;
  }

  private async runCommand(command: readonly string[], containsSecret = false): Promise<void> {
    const result = spawnSync(this.options.binary, buildTrailBaseArgs(this.options, command), {
      cwd: this.options.repoRoot,
      encoding: "utf8",
      shell: false,
      maxBuffer: 4 * 1024 * 1024,
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    if (!containsSecret && output) await appendFile(this.options.logFile, output);
    if (result.error || result.status !== 0 || /failed to apply migration/i.test(output)) {
      throw new Error(containsSecret ? "TrailBase setup command failed" : `TrailBase ${command[0]} command failed`);
    }
  }
}

export const trailBaseProcess = new TrailBaseProcess();
