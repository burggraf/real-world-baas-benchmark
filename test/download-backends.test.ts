import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
// Resolve the plain-Node downloader from both source tests and compiled dist tests.
const { downloadBackend, ensureSafeToolsParent, installNoClobber, noClobberDecision, parseArchiveEntries, parseChecksumManifest, selectRelease, selectTarget, sha256, verifySha256 } = await import(pathToFileURL(resolve("scripts/download-backends.mjs")).href);

const pocketAsset = "pocketbase_0.39.11_linux_amd64.zip";
const pocketDigest = "08b9fcda0d5fd42cb315dc15a36dfa121c993855bd635f01d347c31b4328ec34";

async function temporaryRepository(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(root, "package.json"), "{}\n");
  return root;
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
    executableSha256: null,
    binary: "pocketbase",
    destination: ".tools/pocketbase-0.39.11/pocketbase",
    url: `https://github.com/pocketbase/pocketbase/releases/download/v0.39.11/${pocketAsset}`,
  });
  const pinned: Record<string, [string, string, string | null]> = {
    "pocketbase/darwin-arm64": ["pocketbase_0.39.11_darwin_arm64.zip", "9da6fbe11e82c5b1704e56f7457b24682e01c510206c29b798a458119fa2be20", null],
    "pocketbase/darwin-x64": ["pocketbase_0.39.11_darwin_amd64.zip", "888892fe5fe64cea4a1441937671e191b32ed8f322fa09d3d7b3ca2fc1d7be29", null],
    "pocketbase/linux-arm64": ["pocketbase_0.39.11_linux_arm64.zip", "8c785618840df7ebba795fdf4eba33a5fed64ac5307ad8023b955b4ebb82048b", null],
    "pocketbase/linux-x64": [pocketAsset, pocketDigest, null],
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

test("archive listing rejects traversal and ambiguous root binaries", () => {
  assert.equal(parseArchiveEntries("trail\nREADME.md\ndocs/guide.md\n", "trail"), "trail");
  assert.throws(() => parseArchiveEntries("trail\n../outside\n", "trail"), /unsafe archive entry/i);
  assert.throws(() => parseArchiveEntries("trail\ntrail\n", "trail"), /duplicate|exactly one/i);
  assert.throws(() => parseArchiveEntries("./trail\n", "trail"), /unsafe archive entry|exactly one/i);
  assert.throws(() => parseArchiveEntries("docs/trail\n", "trail"), /exactly one/i);
});

test("safe tool parents reject symlinks outside the repository", async () => {
  const root = await temporaryRepository("backend-parent-");
  const outside = await mkdtemp(join(tmpdir(), "backend-outside-"));
  try {
    await symlink(outside, join(root, ".tools"));
    const destination = join(root, ".tools/pocketbase-0.39.11/pocketbase");
    await assert.rejects(ensureSafeToolsParent(root, destination), /non-symlink/i);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("no-clobber install is atomic, executable, and refuses different bytes", async () => {
  const candidate = { sha256: sha256(Buffer.from("verified executable")), size: 19 };
  assert.equal(noClobberDecision(null, candidate), "install");
  assert.equal(noClobberDecision({ ...candidate }, candidate), "unchanged");
  assert.throws(() => noClobberDecision({ sha256: "0".repeat(64), size: candidate.size }, candidate), /refusing to replace/i);

  const root = await temporaryRepository("backend-install-");
  try {
    const destination = join(root, ".tools/pocketbase-0.39.11/pocketbase");
    await ensureSafeToolsParent(root, destination);
    const first = join(root, ".tools/first");
    const bytes = Buffer.from("verified executable");
    await writeFile(first, bytes, { mode: 0o600 });
    assert.equal(await installNoClobber(first, destination, { sha256: sha256(bytes), size: bytes.length }), "installed");
    assert.equal((await lstat(destination)).mode & 0o777, 0o755);

    const same = join(root, ".tools/same");
    await writeFile(same, bytes, { mode: 0o600 });
    assert.equal(await installNoClobber(same, destination, { sha256: sha256(bytes), size: bytes.length }), "unchanged");

    const different = join(root, ".tools/different");
    await writeFile(different, "different", { mode: 0o600 });
    await assert.rejects(installNoClobber(different, destination, { sha256: sha256(Buffer.from("different")), size: 9 }), /refusing to replace/i);
    assert.deepEqual(await readFile(destination), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
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

test("TrailBase extracted digest mismatch is rejected and every temp is cleaned", async () => {
  const root = await temporaryRepository("backend-extracted-mismatch-");
  try {
    await assert.rejects(downloadBackend("trailbase", {
      repoRoot: root,
      platform: "darwin",
      arch: "arm64",
      download: async (release: { archiveSha256: string }, archive: string) => {
        const bytes = Buffer.from("archive fixture");
        await writeFile(archive, bytes, { mode: 0o600 });
        return { sha256: release.archiveSha256, size: bytes.length };
      },
      runner: {
        listArchive: async () => "trail\nREADME.md\n",
        extractEntry: async (_archive: string, _entry: string, destination: string) => {
          const bytes = Buffer.from("wrong executable");
          await writeFile(destination, bytes, { mode: 0o600 });
          return { sha256: sha256(bytes), size: bytes.length };
        },
      },
    }), /executable SHA-256 mismatch/);
    assert.deepEqual(await downloadTemps(root), []);
    await assert.rejects(lstat(join(root, ".tools/trailbase-0.33.1/trail")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
