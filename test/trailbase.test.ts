import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildTrailBaseArgs,
  TrailBaseProcess,
  resolveTrailBaseOptions,
  assertResetDataDirectorySafe,
  LOCAL_SETUP_PASSWORD,
  LOCAL_BENCHMARK_PASSWORD,
  TRAILBASE_BINARY_SHA256,
  TRAILBASE_EXECUTABLE_SHA256_BY_TARGET,
  assertTrailBaseVersionOutput,
  trailBaseBinarySha256,
  trailBaseExecutableSha256,
} from "../backends/trailbase/process.js";
import {
  backend,
  mapTrailBaseTask,
  trailBaseTaskFilters,
  normalizeTrailBaseError,
  recordInternalId,
} from "../backends/trailbase/adapter.js";
import { profileExpectedCounts } from "../src/seed.js";

test("TrailBase rejects noncanonical seed counts before setup", async () => {
  const { activities: _, ...missing } = profileExpectedCounts("small");
  await assert.rejects(backend.seed({ name: "small", definition: missing }, 42), /profile/i);
});

test("TrailBase options are local, absolute, and use the pinned trail executable", () => {
  const options = resolveTrailBaseOptions({ TRAILBASE_URL: "http://127.0.0.1:8191", TRAILBASE_DATA_DIR: ".data/tb" }, "/tmp/repo");
  assert.equal(options.binary, "/tmp/repo/.tools/trailbase-0.33.1/trail");
  assert.equal(options.dataDir, "/tmp/repo/.data/tb");
  assert.deepEqual(buildTrailBaseArgs(options, ["run", "--address", options.listen]), ["--depot", "/tmp/repo/.data/tb", "run", "--address", "127.0.0.1:8191"]);
  assert.throws(() => resolveTrailBaseOptions({ TRAILBASE_URL: "https://127.0.0.1:8191" }, "/tmp/repo"), /local HTTP/);
  assert.throws(() => resolveTrailBaseOptions({ TRAILBASE_URL: "http://127.0.0.1:8191/x" }, "/tmp/repo"), /path/);
});

test("TrailBase derives its default endpoint from the shared port base", () => {
  assert.equal(resolveTrailBaseOptions({ BENCH_PORT_BASE: "18000" }, "/tmp/repo").endpoint, "http://127.0.0.1:18000");
  assert.equal(resolveTrailBaseOptions({ BENCH_PORT_BASE: "18000", TRAILBASE_URL: "http://127.0.0.1:19000" }, "/tmp/repo").endpoint, "http://127.0.0.1:19000");
});

test("TrailBase reset safety requires strict ownership", () => {
  assert.notEqual(LOCAL_SETUP_PASSWORD, LOCAL_BENCHMARK_PASSWORD);
  assert.throws(() => assertResetDataDirectorySafe("/tmp/repo", "/tmp", false), /ancestor/);
  assert.throws(() => assertResetDataDirectorySafe("/tmp/repo", "/tmp/repo/.data/tb", false), /ownership/);
  assert.doesNotThrow(() => assertResetDataDirectorySafe("/tmp/repo", "/tmp/repo/.data/tb", true));
});

test("TrailBase binary pin verifies the exact version and executable digest", async () => {
  assert.doesNotThrow(() => assertTrailBaseVersionOutput("trail v0.33.1-0-g5c0ff313 (2026-08-19)\nsqlite: 3.53.2\n"));
  assert.throws(() => assertTrailBaseVersionOutput("trail v0.33.10-0-gbad (2026-08-19)\n"), /0\.33\.1/);
  assert.throws(() => assertTrailBaseVersionOutput("trail v0.33.1 garbage\n"), /version output/);
  assert.deepEqual(TRAILBASE_EXECUTABLE_SHA256_BY_TARGET, {
    "darwin-arm64": "cf870bd8daef2a9c5ae26d34267618b29961188ef3be312722f363538ed787fb",
    "darwin-x64": "21cf0e8e27e9c16d92fe0b7520ebf24c22e443f7f00ef03e2eca4262be81ef8d",
    "linux-arm64": "1ef3c8cdd44bdda20ef730f0ba0398908473eb3e4955aa4180b0dd4b5d9e6cd7",
    "linux-x64": "e5ed11dd162e6109b960a5143449b08348c69931b1de12b1e0242daab5b9def8",
  });
  assert.equal(TRAILBASE_BINARY_SHA256, trailBaseExecutableSha256(process.platform, process.arch));
  assert.throws(() => trailBaseExecutableSha256("win32", "x64"), /unsupported.*win32.*x64/i);
  assert.equal(await trailBaseBinarySha256(resolve(".tools/trailbase-0.33.1/trail")), TRAILBASE_BINARY_SHA256);

  const temp = await mkdtemp(join(tmpdir(), "trailbase-pin-"));
  try {
    const fake = join(temp, "trail");
    await writeFile(fake, "not the pinned executable");
    const options = resolveTrailBaseOptions({ TRAILBASE_BIN: fake, TRAILBASE_DATA_DIR: join(temp, "depot"), TRAILBASE_URL: "http://127.0.0.1:65534" });
    await assert.rejects(new TrailBaseProcess(options).doctor("win32", "x64"), /unsupported.*win32.*x64/i);
    await assert.rejects(new TrailBaseProcess(options).doctor(), /SHA-256/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("TrailBase mapping validates enums and preserves nulls", () => {
  const task = mapTrailBaseTask({ id: 7, publicId: "tsk000000000001", projectId: "prj000000000001", creatorId: "usr000000000001", assigneeId: null, title: "x", description: "", status: "todo", priority: "low", dueDate: null, createdAt: "2026", updatedAt: "2026" });
  assert.equal(task.id, "tsk000000000001");
  assert.equal(task.assigneeId, null);
  assert.equal(task.dueDate, null);
  assert.throws(() => mapTrailBaseTask({ ...task, id: 7, publicId: task.id, status: "bad" }), /record_enum/);
});

test("TrailBase record mutations require the internal integer primary key", () => {
  assert.equal(recordInternalId({ id: 42, publicId: "tsk000000000001" }), 42);
  assert.throws(() => recordInternalId({ id: "tsk000000000001", publicId: "tsk000000000001" }), /record_id/);
  assert.throws(() => recordInternalId({ publicId: "tsk000000000001" }), /record_id/);
});

test("TrailBase filters bind tenant context and search only actual titles", () => {
  const filters = trailBaseTaskFilters({ organizationId: "org", projectId: "prj", page: 0, pageSize: 10, query: "100%_done" });
  assert.deepEqual(filters.slice(0, 2), [
    { column: "organizationId", op: "equal", value: "org" },
    { column: "projectId", op: "equal", value: "prj" },
  ]);
  assert.deepEqual(filters[2], { column: "title", op: "regexp", value: "(?i:100%_done)" });
  assert.doesNotMatch(JSON.stringify(filters), /description/);
});

test("TrailBase error normalization redacts remote response text", () => {
  const error = normalizeTrailBaseError({ status: 403, message: "secret" });
  assert.equal(error.classification, "authorization");
  assert.equal(error.message.includes("secret"), false);
  assert.equal(normalizeTrailBaseError({ status: 500 }).classification, "backend_health");
  assert.equal(normalizeTrailBaseError({ status: "503" }).classification, "backend_health");
});

test("TrailBase setup commands are bounded, shell-free, and never add users with password argv", async () => {
  const source = await readFile(resolve("backends/trailbase/process.ts"), "utf8");
  assert.match(source, /shell: false/);
  assert.match(source, /timeout: SETUP_TIMEOUT_MS/);
  assert.match(source, /maxBuffer: SETUP_MAX_BUFFER/);
  assert.doesNotMatch(source, /\["user",\s*"add"/);
  assert.match(source, /UPDATE _user SET email = unverified_email, unverified_email = NULL/);
  assert.match(source, /Number\(result\.changes\) !== 1/);
});

test("TrailBase strict schema uses one auth-linked profile identity and tenant constraints", async () => {
  const sql = await readFile(resolve("backends/trailbase/migrations/U1787223330__canonical.sql"), "utf8");
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS users/);
  for (const table of ["profiles", "organizations", "memberships", "projects", "tasks", "comments", "activities"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(\\s*id INTEGER PRIMARY KEY`));
  }
  assert.match(sql, /authId BLOB NOT NULL UNIQUE/);
  assert.match(sql, /displayName TEXT NOT NULL[^\n]*CHECK\(length\(displayName\) > 0\)/);
  assert.match(sql, /title TEXT NOT NULL[^\n]*CHECK\(length\(title\) > 0\)/);
  assert.match(sql, /body TEXT NOT NULL[^\n]*CHECK\(length\(body\) > 0\)/);
  assert.match(sql, /REFERENCES _user\(id\)/);
  assert.match(sql, /FOREIGN KEY\(organizationId,\s*creatorId\) REFERENCES memberships\(organizationId,\s*userId\)/);
  assert.match(sql, /FOREIGN KEY\(organizationId,\s*assigneeId\) REFERENCES memberships\(organizationId,\s*userId\)/);
  assert.match(sql, /FOREIGN KEY\(organizationId,\s*projectId,\s*taskId\) REFERENCES tasks\(organizationId,\s*projectId,\s*publicId\)/);
  assert.match(sql, /profiles_identity_frozen/);
  assert.match(sql, /_ownerMembershipId TEXT NOT NULL UNIQUE/);
  assert.match(sql, /organizations_owner_membership/);
  assert.match(sql, /FOREIGN KEY\(organizationId,\s*_activityActorId\) REFERENCES memberships\(organizationId,\s*userId\)/);
  assert.match(sql, /task_activity_updated/);
  assert.match(sql, /comment_activity_updated/);
  assert.match(sql, /'comment_updated'/);
  assert.match(sql, /tasks_status ON tasks\(organizationId, projectId, status, createdAt, publicId\)/);
  assert.match(sql, /tasks_assignee ON tasks\(organizationId, projectId, assigneeId, createdAt, publicId\)/);
});

test("TrailBase config has exact authenticated tenant ACLs and no world access", async () => {
  const config = await readFile(resolve("backends/trailbase/config.textproto"), "utf8");
  assert.doesNotMatch(config, /acl_world/);
  for (const api of ["profiles", "organizations", "memberships", "projects", "tasks", "comments", "activities"]) {
    assert.match(config, new RegExp(`name: \"${api}\"`));
  }
  assert.match(config, /profiles\.authId = _USER_\.id/);
  assert.match(config, /create_access_rule/);
  assert.match(config, /_REQ_\.creatorId/);
  assert.match(config, /_REQ_\.authorId/);
  assert.match(config, /profiles\.publicId = _REQ_\._activityActorId/);
  assert.match(config, /requestedProject\.organizationId = _REQ_\.organizationId AND requestedProject\.publicId = _REQ_\.projectId/);
  assert.match(config, /requestedAssignee\.organizationId = _REQ_\.organizationId AND requestedAssignee\.userId = _REQ_\.assigneeId/);
  assert.match(config, /updatedAssignee\.organizationId = _ROW_\.organizationId AND updatedAssignee\.userId = _REQ_\.assigneeId/);
  assert.match(config, /requestedTask\.organizationId = _REQ_\.organizationId AND requestedTask\.projectId = _REQ_\.projectId AND requestedTask\.publicId = _REQ_\.taskId/);
  assert.match(config, /role IN \('owner','admin'\)/);
  assert.match(config, /name: "activities"[^]*acl_authenticated: \[CREATE, READ, DELETE\]/);
  assert.match(config, /_user\.admin = TRUE/);
  assert.doesNotMatch(config, /name: "activities"[^]*acl_authenticated: \[[^\]]*UPDATE/);
  const processSource = await readFile(resolve("backends/trailbase/process.ts"), "utf8");
  assert.doesNotMatch(processSource, /protected record denial is concealed as 404/);
});
