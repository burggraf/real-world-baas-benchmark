import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";
// Resolve the plain-Node downloader from both source tests and compiled dist tests.
const { cleanupTemporaryDirectories, downloadArchive, downloadBackend, main, extractEntry, listArchive, noClobberDecision, parseArchiveEntries, parseChecksumManifest, selectRelease, selectTarget, sha256, validateDownloadUrl, verifySha256 } = await import(pathToFileURL(resolve("scripts/download-backends.mjs")).href);

const pocketAsset = "pocketbase_0.39.11_linux_amd64.zip";
const pocketDigest = "08b9fcda0d5fd42cb315dc15a36dfa121c993855bd635f01d347c31b4328ec34";

async function temporaryRepository(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(root, "package.json"), "{}\n");
  return root;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function storedZip(entries: Array<[string, Uint8Array]>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name); const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length + data.length); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(0, 6); local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28); nameBytes.copy(local, 30); Buffer.from(data).copy(local, 30 + nameBytes.length); locals.push(local);
    const directory = Buffer.alloc(46 + nameBytes.length); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(0, 8); directory.writeUInt16LE(0, 10); directory.writeUInt16LE(0, 12); directory.writeUInt16LE(0, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(nameBytes.length, 28); directory.writeUInt16LE(0, 30); directory.writeUInt16LE(0, 32); directory.writeUInt16LE(0, 34); directory.writeUInt16LE(0, 36); directory.writeUInt32LE(0, 38); directory.writeUInt32LE(offset, 42); nameBytes.copy(directory, 46); central.push(directory); offset += local.length;
  }
  const body = Buffer.concat(locals); const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(body.length, 16); return Buffer.concat([body, directory, end]);
}

async function downloadTemps(root: string): Promise<string[]> {
  return (await readdir(join(root, ".tools"), { recursive: true }).catch(() => [] as string[]))
    .filter(entry => entry.split("/").some(part => part.startsWith(".download-")));
}

test("checksum manifests require one lowercase SHA-256 and each exact filename", () => {
  assert.deepEqual(parseChecksumManifest(`${pocketDigest}  ${pocketAsset}\n`, [pocketAsset]), { [pocketAsset]: pocketDigest });
  assert.throws(() => parseChecksumManifest(`${pocketDigest}  ${pocketAsset}\n${pocketDigest}  ${pocketAsset}\n`, [pocketAsset]), /duplicate/i);
  assert.throws(() => parseChecksumManifest(`${pocketDigest}  ..\/pocketbase\n`, ["pocketbase"]), /malformed|traversal/i);
  assert.throws(() => parseChecksumManifest(`${pocketDigest} *${pocketAsset}\n`, [pocketAsset]), /malformed/i);
  assert.throws(() => parseChecksumManifest(`${pocketDigest}  other.zip\n`, [pocketAsset]), /exact filename/i);
});

test("target and pinned release selection is exact", () => {
  assert.equal(selectTarget("darwin", "arm64"), "darwin-arm64");
  assert.equal(selectTarget("linux", "x64"), "linux-x64");
  assert.throws(() => selectTarget("win32", "x64"), /unsupported.*win32.*x64/i);
  assert.throws(() => selectTarget("linux", "ia32"), /unsupported.*linux.*ia32/i);

  const release = selectRelease("pocketbase", "linux-x64");
  assert.deepEqual(release, {
    backend: "pocketbase",
    version: "0.39.11",
    target: "linux-x64",
    asset: pocketAsset,
    archiveSha256: pocketDigest,
    executableSha256: "88370d5f6fa4820cd2414fa53c6e168d3dd0e33b7a7fd9ff914265492a7aa3b6",
    binary: "pocketbase",
    destination: ".tools/pocketbase-0.39.11/pocketbase",
    url: `https://github.com/pocketbase/pocketbase/releases/download/v0.39.11/${pocketAsset}`,
  });
  const pinned: Record<string, [string, string, string | null]> = {
    "pocketbase/darwin-arm64": ["pocketbase_0.39.11_darwin_arm64.zip", "9da6fbe11e82c5b1704e56f7457b24682e01c510206c29b798a458119fa2be20", "804f9ef353684c1c6b03eaaa33ad7b3fef1eda8eb66ec5ecb113730a07f7a210"],
    "pocketbase/darwin-x64": ["pocketbase_0.39.11_darwin_amd64.zip", "888892fe5fe64cea4a1441937671e191b32ed8f322fa09d3d7b3ca2fc1d7be29", "3e6092e9825030ff9b48a685efd8d688ad87c17f4ea9d6a7cd9fc1e17b3d0748"],
    "pocketbase/linux-arm64": ["pocketbase_0.39.11_linux_arm64.zip", "8c785618840df7ebba795fdf4eba33a5fed64ac5307ad8023b955b4ebb82048b", "bb6f2e3373c7cdbed7f7919a203856f29d713d04cdc550dfec359d5d1437e5b3"],
    "pocketbase/linux-x64": [pocketAsset, pocketDigest, "88370d5f6fa4820cd2414fa53c6e168d3dd0e33b7a7fd9ff914265492a7aa3b6"],
    "trailbase/darwin-arm64": ["trailbase_v0.33.1_arm64_apple_darwin.zip", "72ca231b0b02c51da587c69b120107312b1dd649bf6140db4f8101d0b58a4622", "cf870bd8daef2a9c5ae26d34267618b29961188ef3be312722f363538ed787fb"],
    "trailbase/darwin-x64": ["trailbase_v0.33.1_x86_64_apple_darwin.zip", "2d6c3d95d0153de320a86510836306e2ab26ba97337f4f7f0bbe67df521713e4", "21cf0e8e27e9c16d92fe0b7520ebf24c22e443f7f00ef03e2eca4262be81ef8d"],
    "trailbase/linux-arm64": ["trailbase_v0.33.1_arm64_linux.zip", "2315984a07a5cec42e271dbb2c824815c4c6c7b5f4d35817bc589eac14b0fb5f", "1ef3c8cdd44bdda20ef730f0ba0398908473eb3e4955aa4180b0dd4b5d9e6cd7"],
    "trailbase/linux-x64": ["trailbase_v0.33.1_x86_64_linux.zip", "82ab64c990ea59251058a69de6a876bc28d50fb508d12e3cd87792dcc108c852", "e5ed11dd162e6109b960a5143449b08348c69931b1de12b1e0242daab5b9def8"],
  };
  for (const [key, [asset, archiveSha256, executableSha256]] of Object.entries(pinned)) {
    const [backend, target] = key.split("/");
    const selected = selectRelease(backend, target);
    assert.deepEqual([selected.asset, selected.archiveSha256, selected.executableSha256], [asset, archiveSha256, executableSha256]);
    assert.equal(selected.url.endsWith(`/${asset}`), true);
  }
  assert.throws(() => selectRelease("other", "linux-x64"), /unsupported backend/i);
  assert.throws(() => selectRelease("trailbase", "win32-x64"), /unsupported target/i);
});

test("SHA-256 verification reports only a bounded label", () => {
  const bytes = Buffer.from("fixture");
  const digest = "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d";
  assert.equal(sha256(bytes), digest);
  assert.equal(verifySha256(bytes, digest, "archive"), digest);
  assert.throws(() => verifySha256(Buffer.from("secret response body"), "0".repeat(64), "archive"), /^Error: archive SHA-256 mismatch$/);
});

test("real unzip listing and extraction remain bounded and shell-free", async (t) => {
  if (spawnSync("unzip", ["-v"], { stdio: "ignore" }).error) { t.skip("unzip is required for archive extraction"); return; }
  const root = await temporaryRepository("backend-unzip-");
  try {
    const archive = join(root, "fixture.zip"); const extracted = join(root, "trail");
    await writeFile(archive, storedZip([["trail", Buffer.from("verified executable")], ["README.md", Buffer.from("docs")]]));
    assert.equal(await listArchive(archive), "trail\nREADME.md\n");
    const result = await extractEntry(archive, "trail", extracted);
    assert.deepEqual(result, { sha256: sha256(Buffer.from("verified executable")), size: 19 });
    assert.deepEqual(await readFile(extracted), Buffer.from("verified executable"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("archive listing rejects traversal and ambiguous root binaries", () => {
  assert.equal(parseArchiveEntries("trail\nREADME.md\ndocs/guide.md\n", "trail"), "trail");
  assert.throws(() => parseArchiveEntries("trail\n../outside\n", "trail"), /unsafe archive entry/i);
  assert.throws(() => parseArchiveEntries("trail\ntrail\n", "trail"), /duplicate|exactly one/i);
  assert.throws(() => parseArchiveEntries("./trail\n", "trail"), /unsafe archive entry|exactly one/i);
  assert.throws(() => parseArchiveEntries("docs/trail\n", "trail"), /exactly one/i);
});

test("GitHub release URL policy keeps the pinned URL exact and allows only signed asset hosts", () => {
  const release = selectRelease("pocketbase", "linux-x64");
  const accepted = [
    release.url,
    `https://release-assets.githubusercontent.com/github-production-release-asset-2e65be/owner/repo/${release.asset}?X-Amz-Signature=abc&X-Amz-Expires=60`,
    `https://objects.githubusercontent.com/github-production-release-asset/${release.asset}?download=1`,
  ];
  for (const url of accepted) assert.equal(validateDownloadUrl(url, release), url);
  const rejected = [
    `${release.url}?download=1`,
    `https://github.com/other-owner/repo/releases/download/v0.39.11/${release.asset}`,
    `//evil.example/${release.asset}`,
    `https://github.com.evil.example/${release.asset}`,
    `https://release-assets.githubusercontent.com/`,
    `https://release-assets.githubusercontent.com/${release.asset}#fragment`,
    `http://release-assets.githubusercontent.com/${release.asset}`,
    `https://localhost/${release.asset}`,
    `https://127.0.0.1/${release.asset}`,
    `https://user:pass@release-assets.githubusercontent.com/${release.asset}`,
  ];
  for (const url of rejected) assert.throws(() => validateDownloadUrl(url, release), /unapproved URL/i);
});

test("download fetch follows opaque signed GitHub release redirects manually", async () => {
  const root = await temporaryRepository("backend-redirect-");
  const release = selectRelease("pocketbase", "linux-x64");
  const destination = join(root, "archive.zip");
  const calls: string[] = [];
  try {
    await assert.rejects(downloadArchive(release, destination, {
      fetchImpl: async (url: string) => {
        calls.push(url);
        return new Response(null, { status: 302, headers: { location: "https://evil.example/redirect" } });
      },
    }), /unapproved URL/i);
    assert.deepEqual(calls, [release.url]);
    await assert.rejects(lstat(destination), { code: "ENOENT" });

    calls.length = 0;
    const bytes = Buffer.from("fixture archive");
    const opaque = `https://release-assets.githubusercontent.com/github-production-release-asset-2e65be/owner/repo/${release.asset}?X-Amz-Signature=signed&X-Amz-Expires=60`;
    const result = await downloadArchive(release, destination, {
      fetchImpl: async (url: string) => {
        calls.push(url);
        if (calls.length === 1) return new Response(null, { status: 302, headers: { location: opaque } });
        const response = new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
        Object.defineProperty(response, "url", { value: opaque });
        return response;
      },
    });
    assert.equal(result.sha256, sha256(bytes));
    assert.deepEqual(calls, [release.url, opaque]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("download fetch rejects oversized and failed response streams without body details", async () => {
  const root = await temporaryRepository("backend-fetch-limits-");
  const release = selectRelease("pocketbase", "linux-x64");
  try {
    await assert.rejects(downloadArchive(release, join(root, "large.zip"), {
      fetchImpl: async () => ({ status: 200, ok: true, url: release.url, headers: { get: () => String(128 * 1024 * 1024 + 1) }, body: new ReadableStream() }),
    }), /byte ceiling/i);
    const failedBody = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from("partial")); controller.error(new Error("secret stream body")); } });
    const failedPath = join(root, "failed.zip");
    await assert.rejects(downloadArchive(release, failedPath, {
      fetchImpl: async () => ({ status: 200, ok: true, url: release.url, headers: { get: () => null }, body: failedBody }),
    }), error => error instanceof Error && /download failed or timed out/i.test(error.message) && !error.message.includes("secret stream body"));
    await assert.rejects(lstat(failedPath), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("download cleanup removes a temp directory when its initial chmod fails", async () => {
  const root = await temporaryRepository("backend-chmod-cleanup-");
  try {
    await assert.rejects(downloadBackend("pocketbase", { repoRoot: root, platform: "linux", arch: "x64", chmod: async () => { throw new Error("chmod denied"); } }), /chmod denied/);
    assert.deepEqual(await downloadTemps(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing destination retains only a private verified executable", async () => {
  const root = await temporaryRepository("backend-missing-");
  const archiveBytes = Buffer.from("archive fixture");
  const executableBytes = Buffer.from("verified executable");
  const release = { backend: "fixture", version: "1", target: "linux-x64", asset: "fixture.zip", archiveSha256: sha256(archiveBytes), executableSha256: sha256(executableBytes), binary: "fixture", destination: ".tools/fixture-1/fixture", url: "https://github.com/example/example/releases/download/v1/fixture.zip" };
  try {
    const result = await downloadBackend("fixture", { repoRoot: root, release, download: async (_release: unknown, archive: string) => { await writeFile(archive, archiveBytes); return { sha256: sha256(archiveBytes), size: archiveBytes.length }; }, runner: { listArchive: async () => "fixture\n", extractEntry: async (_a: string, _e: string, destination: string) => { await writeFile(destination, executableBytes, { mode: 0o600 }); return { sha256: sha256(executableBytes), size: executableBytes.length }; } } });
    assert.equal(result.status, "missing");
    assert.deepEqual(result.instructions, { source: join(result.retainedStaging!, "extracted"), destination: join(root, ".tools/fixture-1/fixture"), parent: join(root, ".tools/fixture-1"), sha256: sha256(executableBytes), mode: "0755" });
    assert.equal((await lstat(result.retainedStaging!)).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(result.retainedStaging!), ["extracted"]);
    assert.equal((await lstat(result.instructions.source)).mode & 0o777, 0o600);
    await assert.rejects(lstat(join(root, ".tools")), { code: "ENOENT" });
    await rm(result.retainedStaging!, { recursive: true, force: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("existing identical, mismatch, symlink, and nonregular destinations are read-only and clean staging", async () => {
  const root = await temporaryRepository("backend-destinations-");
  const archiveBytes = Buffer.from("archive fixture"); const executableBytes = Buffer.from("verified executable");
  const release = { backend: "fixture", version: "1", target: "linux-x64", asset: "fixture.zip", archiveSha256: sha256(archiveBytes), executableSha256: sha256(executableBytes), binary: "fixture", destination: ".tools/fixture-1/fixture", url: "https://github.com/example/example/releases/download/v1/fixture.zip" };
  const staged: string[] = [];
  const run = async (prepare?: (destination: string) => Promise<void>) => { const destination = join(root, release.destination); await prepare?.(destination); return downloadBackend("fixture", { repoRoot: root, release, activeTemps: { add: (path: string) => { staged.push(path); }, delete: () => true }, download: async (_r: unknown, archive: string) => { await writeFile(archive, archiveBytes); return { sha256: sha256(archiveBytes), size: archiveBytes.length }; }, runner: { listArchive: async () => "fixture\n", extractEntry: async (_a: string, _e: string, d: string) => { await writeFile(d, executableBytes); return { sha256: sha256(executableBytes), size: executableBytes.length }; } } }); };
  const assertLastStageRemoved = async () => { await assert.rejects(lstat(staged.at(-1)!), { code: "ENOENT" }); };
  try {
    await mkdir(join(root, ".tools/fixture-1"), { recursive: true });
    await writeFile(join(root, release.destination), executableBytes);
    assert.equal((await run()).status, "unchanged");
    await assertLastStageRemoved();
    assert.deepEqual(await readdir(join(root, ".tools")), ["fixture-1"]);
    await rm(join(root, release.destination));
    await assert.rejects(run(async d => { await writeFile(d, "different"); }), /refusing to replace/i);
    await assertLastStageRemoved();
    await assert.rejects(run(async d => { await rm(d); await symlink(join(root, "outside"), d); }), /non-regular|symlink/i);
    await assertLastStageRemoved();
    await assert.rejects(run(async d => { await rm(d); await mkdir(d); }), /non-regular/i);
    await assertLastStageRemoved();
    assert.deepEqual(await readdir(join(root, ".tools/fixture-1")), ["fixture"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("main removes retained staging when a later backend download fails", async () => {
  const first = await mkdtemp(join(tmpdir(), "backend-retained-first-"));
  try {
    let calls = 0;
    const code = await main([], { downloadBackend: async (backend: string) => {
      calls++;
      if (calls === 1) return { backend, target: "linux-x64", destination: "/tmp/missing", status: "missing", executableSha256: "0".repeat(64), retainedStaging: first, instructions: {} };
      throw new Error("later backend failed");
    }});
    assert.equal(code, 1);
    assert.equal(calls, 2);
    await assert.rejects(lstat(first), { code: "ENOENT" });
  } finally { await rm(first, { recursive: true, force: true }); }
});

test("invalid unzip extraction removes its partial destination", async t => {
  if (spawnSync("unzip", ["-v"], { stdio: "ignore" }).error) { t.skip("unzip is required for archive extraction"); return; }
  const root = await temporaryRepository("backend-invalid-zip-"); const archive = join(root, "invalid.zip"); const destination = join(root, "partial");
  try { await writeFile(archive, "not a zip"); await assert.rejects(extractEntry(archive, "fixture", destination), /archive extraction failed|unzip/i); await assert.rejects(lstat(destination), { code: "ENOENT" }); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("archive mismatch is rejected without leaking a response body and temps are cleaned", async () => {
  const root = await temporaryRepository("backend-archive-mismatch-");
  let listed = false;
  try {
    await assert.rejects(downloadBackend("pocketbase", {
      repoRoot: root,
      platform: "linux",
      arch: "x64",
      fetchImpl: async () => new Response("server secret", { status: 200 }),
      runner: {
        listArchive: async () => { listed = true; return "pocketbase\n"; },
        extractEntry: async () => { throw new Error("must not extract"); },
      },
    }), error => error instanceof Error && /archive SHA-256 mismatch/.test(error.message) && !error.message.includes("server secret"));
    assert.equal(listed, false);
    assert.deepEqual(await downloadTemps(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("TrailBase extracted digest mismatch is rejected after archive verification", async () => {
  const root = await temporaryRepository("backend-extracted-mismatch-");
  const archiveBytes = Buffer.from("archive fixture"); const wrong = Buffer.from("wrong executable");
  const release = { backend: "trailbase", version: "1", target: "darwin-arm64", asset: "trail.zip", archiveSha256: sha256(archiveBytes), executableSha256: sha256(Buffer.from("expected executable")), binary: "trail", destination: ".tools/trailbase-1/trail", url: "https://github.com/example/example/releases/download/v1/trail.zip" };
  try {
    await assert.rejects(downloadBackend("trailbase", {
      repoRoot: root, release,
      download: async (_release: unknown, archive: string) => { await writeFile(archive, archiveBytes); return { sha256: sha256(archiveBytes), size: archiveBytes.length }; },
      runner: { listArchive: async () => "trail\nREADME.md\n", extractEntry: async (_a: string, _e: string, destination: string) => { await writeFile(destination, wrong); return { sha256: sha256(wrong), size: wrong.length }; } },
    }), /executable SHA-256 mismatch/);
    assert.deepEqual(await downloadTemps(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
