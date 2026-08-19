import { closeSync, existsSync, openSync } from "node:fs";
import { access, appendFile, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { BackendInfo } from "../../src/backend.js";

export const POCKETBASE_VERSION = "0.39.11";
export const LOCAL_SETUP_EMAIL = "setup@pocketbase.bench.test";
export const LOCAL_BENCHMARK_PASSWORD = "Benchmark-local-only-39!";
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;

export interface PocketBaseProcessOptions {
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

export function resolvePocketBaseOptions(
  env: { POCKETBASE_BIN?: string; POCKETBASE_URL?: string; POCKETBASE_DATA_DIR?: string } = process.env,
  repoRoot = findRepoRoot(),
): PocketBaseProcessOptions {
  const endpointUrl = new URL(env.POCKETBASE_URL || "http://127.0.0.1:8090");
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (endpointUrl.protocol !== "http:" || !localHosts.has(endpointUrl.hostname) || endpointUrl.username || endpointUrl.password) {
    throw new Error("POCKETBASE_URL must be a local HTTP endpoint");
  }
  if (endpointUrl.pathname !== "/" || endpointUrl.search || endpointUrl.hash) {
    throw new Error("POCKETBASE_URL must not contain a path, query, or fragment");
  }
  const port = endpointUrl.port || "80";
  const root = resolve(repoRoot);
  const dataDir = absolute(root, env.POCKETBASE_DATA_DIR || ".data/pocketbase");
  return {
    repoRoot: root,
    binary: absolute(root, env.POCKETBASE_BIN || `.tools/pocketbase-${POCKETBASE_VERSION}/pocketbase`),
    dataDir,
    migrationsDir: join(root, "backends/pocketbase/pb_migrations"),
    endpoint: endpointUrl.origin,
    listen: `${endpointUrl.hostname === "::1" ? "[::1]" : endpointUrl.hostname}:${port}`,
    logFile: join(root, ".data/logs/pocketbase.log"),
  };
}

export function buildPocketBaseArgs(options: PocketBaseProcessOptions, command: readonly string[]): string[] {
  return [`--dir=${options.dataDir}`, `--migrationsDir=${options.migrationsDir}`, ...command];
}

function running(child: ChildProcess | undefined): child is ChildProcess {
  return !!child && child.exitCode === null && child.signalCode === null;
}

async function health(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/api/health`, { signal: AbortSignal.timeout(750) });
    if (!response.ok) return false;
    const body = await response.json() as { code?: unknown };
    return body.code === 200;
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

function safeDataDirectory(options: PocketBaseProcessOptions): void {
  const resolved = resolve(options.dataDir);
  const forbidden = new Set([parse(resolved).root, resolve(options.repoRoot), resolve(process.env.HOME || parse(resolved).root)]);
  if (forbidden.has(resolved)) throw new Error("Refusing to remove unsafe POCKETBASE_DATA_DIR");
}

export class PocketBaseProcess {
  readonly options: PocketBaseProcessOptions;
  private child?: ChildProcess;

  constructor(options = resolvePocketBaseOptions()) {
    this.options = options;
  }

  async doctor(): Promise<BackendInfo> {
    await access(this.options.binary);
    const version = spawnSync(this.options.binary, ["--version"], { encoding: "utf8", shell: false });
    if (version.error || version.status !== 0 || !version.stdout.includes(`version ${POCKETBASE_VERSION}`)) {
      throw new Error(`Expected PocketBase ${POCKETBASE_VERSION} binary`);
    }
    if (running(this.child)) {
      if (!await health(this.options.endpoint)) throw new Error("Owned PocketBase process is unhealthy");
    } else if (!await portAvailable(this.options.listen)) {
      throw new Error(`PocketBase port is already in use at ${this.options.endpoint}`);
    }
    return {
      name: "pocketbase",
      version: POCKETBASE_VERSION,
      endpoint: this.options.endpoint,
      processIds: running(this.child) && this.child.pid ? [this.child.pid] : [],
      deviations: ["PocketBase list-rule denial returns an empty page; protected record denial is concealed as 404."],
    };
  }

  async start(): Promise<void> {
    if (running(this.child)) {
      if (!await health(this.options.endpoint)) throw new Error("Owned PocketBase process is unhealthy");
      return;
    }
    await this.doctor();
    await mkdir(this.options.dataDir, { recursive: true });
    await mkdir(dirname(this.options.logFile), { recursive: true });
    const log = openSync(this.options.logFile, "a");
    const child = spawn(this.options.binary, buildPocketBaseArgs(this.options, ["serve", `--http=${this.options.listen}`]), {
      cwd: this.options.repoRoot,
      detached: false,
      shell: false,
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    this.child = child;
    let startupError: Error | undefined;
    child.once("error", (error) => { startupError = error; });
    child.once("exit", () => { if (this.child === child) this.child = undefined; });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (startupError || !running(child)) {
        this.child = undefined;
        throw new Error("PocketBase process exited during startup");
      }
      if (await health(this.options.endpoint)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    await this.stop();
    throw new Error("PocketBase health check timed out");
  }

  async reset(): Promise<void> {
    await this.stop();
    safeDataDirectory(this.options);
    await rm(this.options.dataDir, { recursive: true, force: true });
    await mkdir(this.options.dataDir, { recursive: true });
    await mkdir(dirname(this.options.logFile), { recursive: true });
    await this.runCommand(["migrate", "up"]);
    await this.runCommand(["superuser", "upsert", LOCAL_SETUP_EMAIL, LOCAL_BENCHMARK_PASSWORD], true);
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
    if (running(child)) throw new Error("Owned PocketBase process did not stop");
    if (this.child === child) this.child = undefined;
  }

  private async runCommand(command: readonly string[], containsSecret = false): Promise<void> {
    const result = spawnSync(this.options.binary, buildPocketBaseArgs(this.options, command), {
      cwd: this.options.repoRoot,
      encoding: "utf8",
      shell: false,
      maxBuffer: 4 * 1024 * 1024,
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    if (!containsSecret && output) await appendFile(this.options.logFile, output);
    if (result.error || result.status !== 0 || /failed to apply migration/i.test(output)) {
      throw new Error(containsSecret ? "PocketBase setup command failed" : `PocketBase ${command[0]} command failed`);
    }
  }
}

export const pocketBaseProcess = new PocketBaseProcess();
