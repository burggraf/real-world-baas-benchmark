import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { access, appendFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type { BackendInfo } from "../../src/backend.js";

export const TRAILBASE_VERSION = "0.33.1";
export const TRAILBASE_BINARY_SHA256 = "cf870bd8daef2a9c5ae26d34267618b29961188ef3be312722f363538ed787fb";
export const LOCAL_SETUP_EMAIL = "setup@trailbase.bench.test";
export const LOCAL_SETUP_PASSWORD = "TrailBase-setup-only-39!";
export const LOCAL_BENCHMARK_PASSWORD = "Benchmark-local-only-39!";
const OWNER_FILE = ".bench-trailbase-owner.json";
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;
const SETUP_TIMEOUT_MS = 15_000;
const SETUP_MAX_BUFFER = 4 * 1024 * 1024;
const EMAIL = /^[a-z0-9][a-z0-9.+_-]{0,63}@[a-z0-9.-]+\.[a-z]{2,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TrailBaseProcessOptions {
  repoRoot: string;
  binary: string;
  dataDir: string;
  migrationsDir: string;
  endpoint: string;
  listen: string;
  logFile: string;
}

interface OwnerMarker { pid: number; binary: string }

export function assertTrailBaseVersionOutput(output: string): void {
  const firstLine = output.split(/\r?\n/, 1)[0] || "";
  const match = /^trail v(?<version>\d+\.\d+\.\d+)-0-g[0-9a-f]+ \(\d{4}-\d{2}-\d{2}\)$/.exec(firstLine);
  if (match?.groups?.version !== TRAILBASE_VERSION) throw new Error(`Expected exact TrailBase ${TRAILBASE_VERSION} version output`);
}

export async function trailBaseBinarySha256(binary: string): Promise<string> {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(binary);
    input.once("error", reject);
    input.on("data", chunk => hash.update(chunk));
    input.once("end", () => resolveDigest(hash.digest("hex")));
  });
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
    binary: absolute(root, env.TRAILBASE_BIN || `.tools/trailbase-${TRAILBASE_VERSION}/trail`),
    dataDir,
    migrationsDir: join(root, "backends/trailbase/migrations"),
    endpoint: endpointUrl.origin,
    listen: `${endpointUrl.hostname === "::1" ? "[::1]" : endpointUrl.hostname}:${port}`,
    logFile: join(dirname(dataDir), `${basename(dataDir)}.log`),
  };
}

export function buildTrailBaseArgs(options: TrailBaseProcessOptions, command: readonly string[]): string[] {
  return ["--depot", options.dataDir, ...command];
}

function running(child: ChildProcess | undefined): child is ChildProcess {
  return !!child && child.exitCode === null && child.signalCode === null;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function findTrailBaseProcessUsing(dataDir: string): number | undefined {
  if (process.platform === "win32") return undefined;
  const result = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8", shell: false, timeout: SETUP_TIMEOUT_MS, maxBuffer: SETUP_MAX_BUFFER });
  if (result.error || result.status !== 0) return undefined;
  const marker = resolve(dataDir);
  for (const line of result.stdout.split("\n")) {
    if (!line.includes(marker) || !line.toLowerCase().includes("trail") || !line.includes("--depot")) continue;
    const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0] || "", 10);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) return pid;
  }
  return undefined;
}

async function health(endpoint: string): Promise<boolean> {
  try {
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
  return new Promise(resolveResult => {
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

async function readOwner(dataDir: string): Promise<OwnerMarker | undefined> {
  try {
    const value = JSON.parse(await readFile(join(dataDir, OWNER_FILE), "utf8")) as { pid?: unknown; binary?: unknown };
    if (!Number.isInteger(value.pid) || Number(value.pid) <= 0 || typeof value.binary !== "string" || !isAbsolute(value.binary)) return undefined;
    return { pid: Number(value.pid), binary: value.binary };
  } catch {
    return undefined;
  }
}

function validateEmail(email: string): void {
  if (email.length > 254 || !EMAIL.test(email)) throw new Error("Invalid setup email");
}

function uuidFromBlob(value: unknown): string {
  if (!(value instanceof Uint8Array) || value.length !== 16) throw new Error("Invalid TrailBase auth UUID");
  const hex = Buffer.from(value).toString("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!UUID.test(uuid)) throw new Error("Invalid TrailBase auth UUID");
  return uuid;
}

function redact(value: string): string {
  return value
    .replace(/(password\s*[:=]\s*)['"]?[^'"\s]+['"]?/gi, "$1[REDACTED]")
    .replace(/("password(?:_repeat)?"\s*:\s*)"[^"]*"/gi, "$1\"[REDACTED]\"");
}

export class TrailBaseProcess {
  readonly options: TrailBaseProcessOptions;
  private child?: ChildProcess;
  private prepared = false;

  constructor(options = resolveTrailBaseOptions()) {
    this.options = options;
  }

  private async assertOwned(): Promise<OwnerMarker> {
    const owner = await readOwner(this.options.dataDir);
    if (!owner || resolve(owner.binary) !== resolve(this.options.binary)) throw new Error("TrailBase depot is not owned by this lifecycle");
    if (running(this.child) && owner.pid !== this.child.pid) throw new Error("TrailBase ownership marker does not match the owned process");
    return owner;
  }

  private async assertStartSafe(): Promise<void> {
    const entries = await readdir(this.options.dataDir).catch(() => [] as string[]);
    if (!entries.length || this.prepared) return;
    const owner = await readOwner(this.options.dataDir);
    if (!owner || resolve(owner.binary) !== resolve(this.options.binary)) throw new Error("Refusing to start with an unowned nonempty TrailBase depot");
    if (processAlive(owner.pid)) throw new Error("Refusing to replace a live TrailBase depot owner");
  }

  async doctor(): Promise<BackendInfo> {
    await access(this.options.binary);
    await access(join(this.options.repoRoot, "backends/trailbase/config.textproto"));
    await access(this.options.migrationsDir);
    const digest = await trailBaseBinarySha256(this.options.binary);
    if (digest !== TRAILBASE_BINARY_SHA256) throw new Error(`Expected TrailBase executable SHA-256 ${TRAILBASE_BINARY_SHA256}`);
    const version = spawnSync(this.options.binary, ["--version"], { encoding: "utf8", shell: false, timeout: SETUP_TIMEOUT_MS, maxBuffer: SETUP_MAX_BUFFER });
    if (version.error || version.status !== 0) throw new Error(`Expected TrailBase ${TRAILBASE_VERSION} binary`);
    assertTrailBaseVersionOutput(version.stdout);
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
      processExecutable: running(this.child) && this.child.pid ? this.options.binary : undefined,
      deviations: [
        "TrailBase list-rule denial returns an empty page rather than an authorization response.",
        "The v0.33.1 release schema and CLI verify command are incompatible; setup verifies registered users with a constrained owned-depot transaction.",
      ],
    };
  }

  async start(): Promise<void> {
    if (running(this.child)) {
      if (!await health(this.options.endpoint)) throw new Error("Owned TrailBase process is unhealthy");
      return;
    }
    await this.doctor();
    await this.assertStartSafe();
    await mkdir(this.options.dataDir, { recursive: true });
    if (!(await readdir(this.options.dataDir)).length) {
      await mkdir(join(this.options.dataDir, "migrations"), { recursive: true });
      await cp(this.options.migrationsDir, join(this.options.dataDir, "migrations", "main"), { recursive: true });
      await cp(join(this.options.repoRoot, "backends/trailbase/config.textproto"), join(this.options.dataDir, "config.textproto"));
    }
    await mkdir(dirname(this.options.logFile), { recursive: true });
    const child = spawn(this.options.binary, buildTrailBaseArgs(this.options, ["run", "--address", this.options.listen]), {
      cwd: this.options.repoRoot,
      detached: false,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.prepared = false;
    try {
      await writeFile(join(this.options.dataDir, OWNER_FILE), JSON.stringify({ pid: child.pid, binary: this.options.binary }), { mode: 0o600 });
    } catch (error) {
      await this.stop();
      throw error;
    }

    let stdout = "", stderr = "";
    const logLines = (kind: "stdout" | "stderr", chunk: Buffer | string): void => {
      let pending = (kind === "stdout" ? stdout : stderr) + String(chunk);
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      if (kind === "stdout") stdout = pending; else stderr = pending;
      if (lines.length) void appendFile(this.options.logFile, redact(`${lines.join("\n")}\n`).slice(0, 64 * 1024)).catch(() => undefined);
    };
    const flushLogs = (): void => {
      const pending = `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`;
      stdout = ""; stderr = "";
      if (pending) void appendFile(this.options.logFile, redact(pending).slice(0, 64 * 1024)).catch(() => undefined);
    };
    child.stdout?.on("data", chunk => logLines("stdout", chunk));
    child.stderr?.on("data", chunk => logLines("stderr", chunk));
    let startupError = false;
    child.once("error", () => { startupError = true; });
    child.once("exit", () => { flushLogs(); if (this.child === child) this.child = undefined; });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (startupError || !running(child)) {
        if (running(child)) await this.stop();
        throw new Error("TrailBase process exited during startup");
      }
      if (await health(this.options.endpoint)) return;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
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
    if (owner && resolve(owner.binary) !== resolve(this.options.binary)) throw new Error("Refusing to remove data directory owned by another binary");
    const owned = !entries.length || (!!owner && !processAlive(owner.pid));
    assertResetDataDirectorySafe(this.options.repoRoot, this.options.dataDir, owned);
    await rm(this.options.dataDir, { recursive: true, force: true });
    await rm(this.options.logFile, { force: true });
    await mkdir(join(this.options.dataDir, "migrations"), { recursive: true });
    await cp(this.options.migrationsDir, join(this.options.dataDir, "migrations", "main"), { recursive: true });
    await cp(join(this.options.repoRoot, "backends/trailbase/config.textproto"), join(this.options.dataDir, "config.textproto"));
    this.prepared = true;
    try { await this.start(); } finally { this.prepared = false; }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!running(child)) {
      this.child = undefined;
      return;
    }
    const exited = new Promise<void>(resolveExit => child.once("exit", () => resolveExit()));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise(resolveWait => setTimeout(resolveWait, STOP_TIMEOUT_MS))]);
    if (running(child)) {
      child.kill("SIGKILL");
      await Promise.race([exited, new Promise(resolveWait => setTimeout(resolveWait, STOP_TIMEOUT_MS))]);
    }
    if (running(child)) throw new Error("Owned TrailBase process did not stop");
    if (this.child === child) this.child = undefined;
  }

  private runCommand(command: readonly string[]): void {
    const result = spawnSync(this.options.binary, buildTrailBaseArgs(this.options, command), {
      cwd: this.options.repoRoot,
      encoding: "utf8",
      shell: false,
      timeout: SETUP_TIMEOUT_MS,
      maxBuffer: SETUP_MAX_BUFFER,
    });
    // Setup output is deliberately discarded: CLI diagnostics can contain auth identifiers.
    void redact(`${result.stdout || ""}${result.stderr || ""}`);
    if (result.error || result.status !== 0) throw new Error(`TrailBase ${command.slice(0, 2).join(" ")} setup command failed`);
  }

  private async whileStopped(work: () => void): Promise<void> {
    await this.assertOwned();
    if (!running(this.child)) throw new Error("TrailBase setup requires its owned server to be running");
    await this.stop();
    try { work(); } finally { await this.start(); }
  }

  async verifyRegisteredUsers(emails: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(emails)];
    if (unique.length !== emails.length || !unique.length) throw new Error("Expected unique registered users");
    for (const email of unique) validateEmail(email);
    const ids = new Map<string, string>();
    await this.whileStopped(() => {
      const db = new DatabaseSync(join(this.options.dataDir, "data", "main.db"), { timeout: SETUP_TIMEOUT_MS });
      db.function("is_email", (value: SQLOutputValue) => typeof value === "string" && value.length <= 254 && EMAIL.test(value) ? 1 : 0);
      db.function("is_uuid", (value: SQLOutputValue) => value instanceof Uint8Array && value.length === 16 ? 1 : 0);
      try {
        db.exec("BEGIN IMMEDIATE");
        const find = db.prepare("SELECT id FROM _user WHERE unverified_email = ? AND email IS NULL");
        const verify = db.prepare("UPDATE _user SET email = unverified_email, unverified_email = NULL WHERE id = ? AND unverified_email = ? AND email IS NULL");
        const checked = db.prepare("SELECT id FROM _user WHERE id = ? AND email = ? AND unverified_email IS NULL");
        for (const email of unique) {
          const found = find.get(email) as { id?: unknown } | undefined;
          const id = found?.id;
          const uuid = uuidFromBlob(id);
          const result = verify.run(id as Uint8Array, email);
          if (Number(result.changes) !== 1 || !checked.get(id as Uint8Array, email)) throw new Error("TrailBase registered-user verification failed");
          ids.set(email, uuid);
        }
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      } finally {
        db.close();
      }
    });
    return ids;
  }

  async promoteVerifiedUser(email: string): Promise<void> {
    validateEmail(email);
    await this.whileStopped(() => this.runCommand(["admin", "promote", email]));
  }

  async deleteVerifiedUsers(emails: readonly string[]): Promise<void> {
    const unique = [...new Set(emails)];
    for (const email of unique) validateEmail(email);
    if (!unique.length) return;
    await this.whileStopped(() => { for (const email of unique) this.runCommand(["user", "delete", email]); });
  }

  async authUsersWithSuffix(suffix: string): Promise<{ email: string; verified: boolean }[]> {
    await this.assertOwned();
    if (!/^@[a-z0-9.-]+\.[a-z]{2,}$/i.test(suffix)) throw new Error("Invalid setup email suffix");
    const db = new DatabaseSync(join(this.options.dataDir, "data", "main.db"), { readOnly: true, timeout: SETUP_TIMEOUT_MS });
    try {
      const pattern = `%${suffix}`;
      const rows = db.prepare("SELECT email, unverified_email FROM _user WHERE email LIKE ? OR unverified_email LIKE ? ORDER BY COALESCE(email, unverified_email)").all(pattern, pattern) as { email?: unknown; unverified_email?: unknown }[];
      return rows.map(value => {
        const email = typeof value.email === "string" ? value.email : value.unverified_email;
        if (typeof email !== "string") throw new Error("Invalid TrailBase auth email");
        validateEmail(email);
        return { email, verified: typeof value.email === "string" && value.unverified_email === null };
      });
    } finally {
      db.close();
    }
  }

}

export const trailBaseProcess = new TrailBaseProcess();
