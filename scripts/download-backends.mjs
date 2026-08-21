#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
const EXECUTABLE_MAX_BYTES = 128 * 1024 * 1024;
const LIST_MAX_BYTES = 128 * 1024;
const LIST_MAX_ENTRIES = 1024;
const COMMAND_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const SHA256 = /^[0-9a-f]{64}$/;
const TARGETS = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
const MAX_REDIRECTS = 5;

const releases = Object.freeze({
  pocketbase: Object.freeze({
    version: "0.39.11",
    baseUrl: "https://github.com/pocketbase/pocketbase/releases/download/v0.39.11/",
    binary: "pocketbase",
    targets: Object.freeze({
      "darwin-arm64": Object.freeze({ asset: "pocketbase_0.39.11_darwin_arm64.zip", archiveSha256: "9da6fbe11e82c5b1704e56f7457b24682e01c510206c29b798a458119fa2be20", executableSha256: "804f9ef353684c1c6b03eaaa33ad7b3fef1eda8eb66ec5ecb113730a07f7a210" }),
      "darwin-x64": Object.freeze({ asset: "pocketbase_0.39.11_darwin_amd64.zip", archiveSha256: "888892fe5fe64cea4a1441937671e191b32ed8f322fa09d3d7b3ca2fc1d7be29", executableSha256: "3e6092e9825030ff9b48a685efd8d688ad87c17f4ea9d6a7cd9fc1e17b3d0748" }),
      "linux-arm64": Object.freeze({ asset: "pocketbase_0.39.11_linux_arm64.zip", archiveSha256: "8c785618840df7ebba795fdf4eba33a5fed64ac5307ad8023b955b4ebb82048b", executableSha256: "bb6f2e3373c7cdbed7f7919a203856f29d713d04cdc550dfec359d5d1437e5b3" }),
      "linux-x64": Object.freeze({ asset: "pocketbase_0.39.11_linux_amd64.zip", archiveSha256: "08b9fcda0d5fd42cb315dc15a36dfa121c993855bd635f01d347c31b4328ec34", executableSha256: "88370d5f6fa4820cd2414fa53c6e168d3dd0e33b7a7fd9ff914265492a7aa3b6" }),
    }),
  }),
  trailbase: Object.freeze({
    version: "0.33.1",
    baseUrl: "https://github.com/trailbaseio/trailbase/releases/download/v0.33.1/",
    binary: "trail",
    targets: Object.freeze({
      "darwin-arm64": Object.freeze({ asset: "trailbase_v0.33.1_arm64_apple_darwin.zip", archiveSha256: "72ca231b0b02c51da587c69b120107312b1dd649bf6140db4f8101d0b58a4622", executableSha256: "cf870bd8daef2a9c5ae26d34267618b29961188ef3be312722f363538ed787fb" }),
      "darwin-x64": Object.freeze({ asset: "trailbase_v0.33.1_x86_64_apple_darwin.zip", archiveSha256: "2d6c3d95d0153de320a86510836306e2ab26ba97337f4f7f0bbe67df521713e4", executableSha256: "21cf0e8e27e9c16d92fe0b7520ebf24c22e443f7f00ef03e2eca4262be81ef8d" }),
      "linux-arm64": Object.freeze({ asset: "trailbase_v0.33.1_arm64_linux.zip", archiveSha256: "2315984a07a5cec42e271dbb2c824815c4c6c7b5f4d35817bc589eac14b0fb5f", executableSha256: "1ef3c8cdd44bdda20ef730f0ba0398908473eb3e4955aa4180b0dd4b5d9e6cd7" }),
      "linux-x64": Object.freeze({ asset: "trailbase_v0.33.1_x86_64_linux.zip", archiveSha256: "82ab64c990ea59251058a69de6a876bc28d50fb508d12e3cd87792dcc108c852", executableSha256: "e5ed11dd162e6109b960a5143449b08348c69931b1de12b1e0242daab5b9def8" }),
    }),
  }),
});

function safeFilename(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== "." && value !== "..";
}

export function parseChecksumManifest(text, exactFilenames) {
  if (typeof text !== "string" || !Array.isArray(exactFilenames) || exactFilenames.length === 0) throw new Error("Malformed checksum manifest");
  if (exactFilenames.some(name => !safeFilename(name)) || new Set(exactFilenames).size !== exactFilenames.length) throw new Error("Malformed exact filename list");
  const expected = new Set(exactFilenames);
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.some(line => line.length === 0)) throw new Error("Malformed checksum manifest");
  const parsed = {};
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match || !safeFilename(match[2])) throw new Error("Malformed checksum manifest entry");
    const filename = match[2];
    if (!expected.has(filename)) throw new Error(`Checksum manifest does not contain only the exact filename ${exactFilenames.join(", ")}`);
    if (Object.hasOwn(parsed, filename)) throw new Error(`Duplicate checksum filename: ${filename}`);
    parsed[filename] = match[1];
  }
  if (Object.keys(parsed).length !== expected.size || exactFilenames.some(name => !Object.hasOwn(parsed, name))) throw new Error("Checksum manifest is missing an exact filename");
  return Object.freeze(parsed);
}

export function selectTarget(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  if (!TARGETS.has(target)) throw new Error(`Unsupported backend download target ${platform}/${arch}; supported targets are macOS or Linux on arm64 or x64`);
  return target;
}

export function sha256(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("SHA-256 input must be bytes");
  return createHash("sha256").update(bytes).digest("hex");
}

function checkedDigest(value, label) {
  if (!SHA256.test(value)) throw new Error(`Invalid ${label} SHA-256`);
  return value;
}

function safeLabel(label) {
  return typeof label === "string" && /^[A-Za-z0-9 _-]{1,40}$/.test(label) ? label : "payload";
}

export function verifySha256(bytes, expected, label = "payload") {
  checkedDigest(expected, "expected");
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`${safeLabel(label)} SHA-256 mismatch`);
  return actual;
}

export function selectRelease(backend, target = selectTarget()) {
  if (!Object.hasOwn(releases, backend)) throw new Error(`Unsupported backend download: ${String(backend)}`);
  if (!TARGETS.has(target)) throw new Error(`Unsupported target: ${String(target)}`);
  const release = releases[backend];
  const asset = release.targets[target];
  if (!asset) throw new Error(`Unsupported target for ${backend}: ${target}`);
  const url = `${release.baseUrl}${asset.asset}`;
  if (new URL(url).protocol !== "https:" || basename(new URL(url).pathname) !== asset.asset) throw new Error("Invalid pinned release URL");
  return Object.freeze({
    backend,
    version: release.version,
    target,
    asset: asset.asset,
    archiveSha256: checkedDigest(asset.archiveSha256, "archive"),
    executableSha256: asset.executableSha256 ? checkedDigest(asset.executableSha256, "executable") : null,
    binary: release.binary,
    destination: `.tools/${backend}-${release.version}/${release.binary}`,
    url,
  });
}

function inside(parent, child) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function parseArchiveEntries(listing, binary) {
  if (typeof listing !== "string" || !safeFilename(binary) || Buffer.byteLength(listing) > LIST_MAX_BYTES) throw new Error("Invalid or oversized archive listing");
  const entries = listing.split(/\r?\n/);
  if (entries.at(-1) === "") entries.pop();
  if (entries.length === 0 || entries.length > LIST_MAX_ENTRIES || entries.some(entry => entry.length === 0)) throw new Error("Invalid or oversized archive listing");
  const seen = new Set();
  let rootBinaries = 0;
  for (const entry of entries) {
    const directory = entry.endsWith("/");
    const canonical = directory ? entry.slice(0, -1) : entry;
    const parts = canonical.split("/");
    if (!canonical || canonical.length > 4096 || entry.startsWith("/") || entry.includes("\\") || /^[A-Za-z]:/.test(entry) || /[\u0000-\u001f\u007f]/.test(entry) || parts.some(part => !part || part === "." || part === "..")) {
      throw new Error("Unsafe archive entry");
    }
    const key = canonical.toLowerCase();
    if (seen.has(key)) throw new Error("Duplicate or ambiguous archive entry");
    seen.add(key);
    if (!directory && entry === binary) rootBinaries++;
  }
  if (rootBinaries !== 1) throw new Error(`Archive must contain exactly one root binary named ${binary}`);
  return binary;
}

async function hashFile(path, maxBytes = EXECUTABLE_MAX_BYTES) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error("Expected a bounded regular non-symlink file");
  const hash = createHash("sha256");
  const input = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    for await (const chunk of input.createReadStream()) hash.update(chunk);
  } finally { await input.close(); }
  return { sha256: hash.digest("hex"), size: stat.size };
}

export function noClobberDecision(existing, candidate) {
  checkedDigest(candidate?.sha256, "candidate executable");
  if (!Number.isSafeInteger(candidate?.size) || candidate.size <= 0 || candidate.size > EXECUTABLE_MAX_BYTES) throw new Error("Invalid candidate executable size");
  if (existing === null) return "install";
  checkedDigest(existing?.sha256, "existing executable");
  if (!Number.isSafeInteger(existing?.size) || existing.size !== candidate.size || existing.sha256 !== candidate.sha256) throw new Error("Refusing to replace an existing different backend executable");
  return "unchanged";
}

async function validateDestinationParents(repoRoot, destination) {
  const root = resolve(repoRoot);
  const tools = join(root, ".tools");
  const target = resolve(destination);
  if (!inside(tools, target)) throw new Error("Tool destination must be inside the repository-owned .tools directory");
  for (const path of [root, tools]) {
    let stat;
    try { stat = await lstat(path); } catch (error) { if (error?.code === "ENOENT" && path !== root) continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Tool destination parents must be non-symlink directories");
  }
  const parts = relative(tools, dirname(target)).split(sep).filter(Boolean);
  let current = tools;
  for (const part of parts) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Tool destination parents must be non-symlink directories");
    } catch (error) { if (error?.code === "ENOENT") break; throw error; }
  }
}

export async function inspectExisting(source, destination, candidate, options = {}) {
  await validateDestinationParents(options.repoRoot ?? resolve(dirname(destination), "../.."), destination);
  const actualCandidate = await hashFile(source);
  if (actualCandidate.sha256 !== candidate.sha256 || actualCandidate.size !== candidate.size) throw new Error("Candidate executable changed before installation");
  let existing;
  try { existing = await lstat(destination); } catch (error) { if (error?.code === "ENOENT") return "missing"; throw error; }
  if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("Refusing to use a non-regular backend executable destination");
  noClobberDecision(await hashFile(destination), candidate);
  return "unchanged";
}

function operationSignal(signal, timeoutMs) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

export function validateDownloadUrl(url, release) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("Backend download redirected to an unapproved URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error("Backend download redirected to an unapproved URL");
  if (parsed.hostname === "github.com") {
    if (parsed.href !== release.url) throw new Error("Backend download redirected to an unapproved URL");
    return parsed.href;
  }
  if ((parsed.hostname === "release-assets.githubusercontent.com" || parsed.hostname === "objects.githubusercontent.com") && parsed.pathname.length > 1) return parsed.href;
  throw new Error("Backend download redirected to an unapproved URL");
}

export async function downloadArchive(release, destination, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = operationSignal(options.signal, DOWNLOAD_TIMEOUT_MS);
  let current = validateDownloadUrl(release.url, release);
  let response;
  for (let redirects = 0; ; redirects++) {
    try { response = await fetchImpl(current, { redirect: "manual", signal }); }
    catch { throw new Error("Backend download failed or timed out"); }
    if (!response || typeof response.status !== "number") throw new Error("Backend download failed");
    if (response.status >= 300 && response.status < 400) {
      if (redirects >= MAX_REDIRECTS) throw new Error("Backend download exceeded redirect limit");
      const location = response.headers?.get?.("location");
      if (!location) throw new Error("Backend download redirect missing location");
      response.body?.cancel?.();
      current = validateDownloadUrl(new URL(location, current).href, release);
      continue;
    }
    if (!response.ok) throw new Error(`Backend download failed with HTTP ${response.status}`);
    validateDownloadUrl(response.url || current, release);
    break;
  }
  if (!response || !response.body) throw new Error("Backend download returned no body");
  if (!response.body) throw new Error("Backend download returned no body");
  const length = response.headers?.get?.("content-length");
  if (length !== null && length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > ARCHIVE_MAX_BYTES)) throw new Error("Backend archive exceeds the byte ceiling");
  const output = await open(destination, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  let complete = false;
  try {
    try {
      for await (const value of response.body) {
        if (signal.aborted) throw new Error("aborted");
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > ARCHIVE_MAX_BYTES) throw new Error("Backend archive exceeds the byte ceiling");
        hash.update(chunk);
        await output.write(chunk);
      }
      complete = true;
    } catch (error) {
      if (error instanceof Error && error.message === "Backend archive exceeds the byte ceiling") throw error;
      throw new Error("Backend download failed or timed out");
    }
  } finally {
    await output.close();
    if (!complete) await rm(destination, { force: true });
  }
  return { sha256: hash.digest("hex"), size };
}

function spawnBounded(command, args, maxBytes, signal) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure;
    let settled = false;
    const abort = () => { failure ??= new Error("Archive command timed out or was interrupted"); child.kill("SIGKILL"); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) { failure ??= new Error("Archive listing exceeds the byte ceiling"); child.kill("SIGKILL"); }
      else chunks.push(chunk);
    });
    child.stderr.on("data", chunk => { stderrBytes += chunk.length; if (stderrBytes > LIST_MAX_BYTES) { failure ??= new Error("Archive command output exceeds the byte ceiling"); child.kill("SIGKILL"); } });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      error ? rejectRun(error) : resolveRun(value);
    };
    child.once("error", () => finish(new Error("The unzip executable is required")));
    child.once("close", code => finish(failure ?? (code === 0 ? undefined : new Error("Archive listing failed")), Buffer.concat(chunks).toString("utf8")));
  });
}

export async function listArchive(archive, options = {}) {
  return spawnBounded("unzip", ["-Z1", archive], LIST_MAX_BYTES, operationSignal(options.signal, COMMAND_TIMEOUT_MS));
}

export async function extractEntry(archive, entry, destination, options = {}) {
  const signal = operationSignal(options.signal, COMMAND_TIMEOUT_MS);
  const output = await open(destination, "wx", 0o600);
  const child = spawn("unzip", ["-p", archive, entry], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const hash = createHash("sha256");
  let size = 0;
  let stderrBytes = 0;
  let failure;
  const abort = () => { failure ??= new Error("Archive extraction timed out or was interrupted"); child.kill("SIGKILL"); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  child.stderr.on("data", chunk => { stderrBytes += chunk.length; if (stderrBytes > LIST_MAX_BYTES) abort(); });
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", () => rejectExit(new Error("The unzip executable is required")));
    child.once("close", code => failure || code !== 0 ? rejectExit(failure ?? new Error("Archive extraction failed")) : resolveExit());
  });
  try {
    for await (const value of child.stdout) {
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > EXECUTABLE_MAX_BYTES) { failure = new Error("Extracted executable exceeds the byte ceiling"); child.kill("SIGKILL"); break; }
      hash.update(chunk);
      await output.write(chunk);
    }
    await exited;
    if (failure) throw failure;
    return { sha256: hash.digest("hex"), size };
  } finally {
    signal.removeEventListener("abort", abort);
    await output.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (failure || child.exitCode !== 0) await rm(destination, { force: true });
  }
}

const defaultRunner = Object.freeze({ listArchive, extractEntry });

export async function downloadBackend(backend, options = {}) {
  const root = resolve(options.repoRoot ?? dirname(dirname(fileURLToPath(import.meta.url))));
  const target = selectTarget(options.platform ?? process.platform, options.arch ?? process.arch);
  const release = options.release ?? selectRelease(backend, target);
  const destination = resolve(root, release.destination);
  const temporary = await mkdtemp(join(tmpdir(), "real-world-baas-backend-"));
  options.activeTemps?.add(temporary);
  let retained = false;
  try {
    await (options.chmod ?? chmod)(temporary, 0o700);
    const archive = join(temporary, release.asset);
    const extracted = join(temporary, "extracted");
    const download = options.download ?? ((selected, path) => downloadArchive(selected, path, { fetchImpl: options.fetchImpl, signal: options.signal }));
    const archiveResult = await download(release, archive);
    const actualArchive = await hashFile(archive, ARCHIVE_MAX_BYTES).catch(() => null);
    if (!actualArchive || actualArchive.sha256 !== release.archiveSha256 || actualArchive.sha256 !== archiveResult?.sha256 || actualArchive.size !== archiveResult?.size) throw new Error(`${backend} archive SHA-256 mismatch`);
    const runner = options.runner ?? defaultRunner;
    const entry = parseArchiveEntries(await runner.listArchive(archive, { signal: options.signal }), release.binary);
    const executable = await runner.extractEntry(archive, entry, extracted, { signal: options.signal, maxBytes: EXECUTABLE_MAX_BYTES });
    const actualExecutable = await hashFile(extracted, EXECUTABLE_MAX_BYTES).catch(() => null);
    if (!actualExecutable || actualExecutable.sha256 !== executable?.sha256 || actualExecutable.size !== executable?.size || (release.executableSha256 && actualExecutable.sha256 !== release.executableSha256)) throw new Error(`${backend} executable SHA-256 mismatch`);
    await rm(archive, { force: true });
    const status = await inspectExisting(extracted, destination, actualExecutable, { repoRoot: root });
    if (status === "missing") {
      retained = true;
      options.activeTemps?.delete(temporary);
      const instructions = Object.freeze({ source: extracted, destination, parent: dirname(destination), sha256: actualExecutable.sha256, mode: "0755" });
      return Object.freeze({ backend, target, destination, status, executableSha256: actualExecutable.sha256, instructions, retainedStaging: temporary });
    }
    options.activeTemps?.delete(temporary);
    await rm(temporary, { recursive: true, force: true });
    return Object.freeze({ backend, target, destination, status, executableSha256: actualExecutable.sha256 });
  } finally {
    if (!retained) { options.activeTemps?.delete(temporary); await rm(temporary, { recursive: true, force: true }); }
  }
}

export async function cleanupTemporaryDirectories(paths) {
  await Promise.all([...paths].map(path => rm(path, { recursive: true, force: true })));
}

const help = `Usage: node scripts/download-backends.mjs\n\nDownloads and verifies pinned PocketBase 0.39.11 and TrailBase 0.33.1 archives.\nVerified executables are staged privately; existing identical files are retained. Missing files require manual copy and chmod 0755.`;

export async function main(argv = process.argv.slice(2), options = {}) {
  if (argv.length === 1 && argv[0] === "--help") { console.log(help); return 0; }
  if (argv.length !== 0) { console.error("Usage: node scripts/download-backends.mjs [--help]"); return 1; }
  const controller = new AbortController();
  const activeTemps = new Set();
  const retainedTemps = new Set();
  let completed = false;
  let interrupted = false;
  const interrupt = () => { interrupted = true; controller.abort(); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const target = selectTarget();
    // Select both before creating files so unsupported hosts fail without partial work.
    selectRelease("pocketbase", target);
    selectRelease("trailbase", target);
    const download = options.downloadBackend ?? downloadBackend;
    for (const backend of ["pocketbase", "trailbase"]) {
      const result = await download(backend, { signal: controller.signal, activeTemps });
      if (result.retainedStaging) retainedTemps.add(result.retainedStaging);
      console.log(result.status === "missing" ? `${result.backend} missing: ${JSON.stringify(result.instructions)}` : `${result.backend} ${result.status}: ${relative(process.cwd(), result.destination)}`);
    }
    completed = true;
    return 0;
  } catch (error) {
    console.error(interrupted ? "Backend download interrupted" : error instanceof Error ? error.message : "Backend download failed");
    return interrupted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await cleanupTemporaryDirectories(new Set([...activeTemps, ...(completed ? [] : retainedTemps)]));
  }
}

const entryPoint = process.argv[1];
if (entryPoint && resolve(entryPoint) === fileURLToPath(import.meta.url)) void main().then(code => { process.exitCode = code; });
