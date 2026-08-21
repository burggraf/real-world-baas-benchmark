import { closeSync, existsSync, openSync } from "node:fs";
import { access, appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { BackendInfo } from "../../src/backend.js";

export const POCKETBASE_VERSION = "0.39.11";
export const POCKETBASE_EXECUTABLE_SHA256_BY_TARGET = Object.freeze({
  "darwin-arm64": "804f9ef353684c1c6b03eaaa33ad7b3fef1eda8eb66ec5ecb113730a07f7a210",
  "darwin-x64": "3e6092e9825030ff9b48a685efd8d688ad87c17f4ea9d6a7cd9fc1e17b3d0748",
  "linux-arm64": "bb6f2e3373c7cdbed7f7919a203856f29d713d04cdc550dfec359d5d1437e5b3",
  "linux-x64": "88370d5f6fa4820cd2414fa53c6e168d3dd0e33b7a7fd9ff914265492a7aa3b6",
} as const);
export function pocketBaseExecutableSha256(platform = process.platform, arch = process.arch): string {
  const digest = POCKETBASE_EXECUTABLE_SHA256_BY_TARGET[`${platform}-${arch}` as keyof typeof POCKETBASE_EXECUTABLE_SHA256_BY_TARGET];
  if (!digest) throw new Error(`Unsupported PocketBase target ${platform}/${arch}; supported targets are macOS or Linux on arm64 or x64`);
  return digest;
}
export const LOCAL_SETUP_EMAIL = "setup@pocketbase.bench.test";
export const LOCAL_SETUP_PASSWORD = "PocketBase-setup-only-39!";
export const LOCAL_BENCHMARK_PASSWORD = "Benchmark-local-only-39!";
const OWNER_FILE = ".bench-pocketbase-owner.json";
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

function findPocketBaseProcessUsing(dataDir: string): number | undefined {
  if (process.platform === "win32") return undefined;
  const result = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8", shell: false });
  if (result.error || result.status !== 0) return undefined;
  const marker = `--dir=${resolve(dataDir)}`;
  for (const line of result.stdout.split("\n")) {
    if (!line.includes(marker) || !line.toLowerCase().includes("pocketbase")) continue;
    const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0] || "", 10);
    if (Number.isInteger(pid) && pid !== process.pid) return pid;
  }
  return undefined;
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

export async function pocketBaseBinarySha256(binary: string): Promise<string> {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(binary);
    input.once("error", reject);
    input.on("data", chunk => hash.update(chunk));
    input.once("end", () => resolveDigest(hash.digest("hex")));
  });
}

export class PocketBaseProcess {
  readonly options: PocketBaseProcessOptions;
  private child?: ChildProcess;

  constructor(options = resolvePocketBaseOptions()) {
    this.options = options;
  }

  async doctor(platform = process.platform, arch = process.arch): Promise<BackendInfo> {
    const expectedDigest = pocketBaseExecutableSha256(platform, arch);
    await access(this.options.binary);
    const digest = await pocketBaseBinarySha256(this.options.binary);
    if (digest !== expectedDigest) throw new Error(`Expected PocketBase executable SHA-256 ${expectedDigest}`);
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
      processExecutable: running(this.child) && this.child.pid ? this.options.binary : undefined,
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
    const externalPid = findPocketBaseProcessUsing(this.options.dataDir);
    if (externalPid) throw new Error("Refusing to reset data directory used by an externally-owned PocketBase process");
    const owner = await readOwner(this.options.dataDir);
    const entries = await readdir(this.options.dataDir).catch(() => [] as string[]);
    const ownerProcessAlive = owner ? (() => { try { process.kill(owner.pid, 0); return true; } catch { return false; } })() : false;
    if (owner && resolve(owner.binary) !== resolve(this.options.binary)) throw new Error("Refusing to remove data directory owned by another binary");
    assertResetDataDirectorySafe(this.options.repoRoot, this.options.dataDir, !entries.length || (!!owner && !ownerProcessAlive));
    await rm(this.options.dataDir, { recursive: true, force: true });
    await mkdir(this.options.dataDir, { recursive: true });
    await mkdir(dirname(this.options.logFile), { recursive: true });
    await this.runCommand(["migrate", "up"]);
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
