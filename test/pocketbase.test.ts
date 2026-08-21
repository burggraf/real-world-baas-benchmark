import test from "node:test";
import assert from "node:assert/strict";
import PocketBase, { ClientResponseError } from "pocketbase";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPocketBaseArgs, LOCAL_BENCHMARK_PASSWORD, LOCAL_SETUP_PASSWORD, resolvePocketBaseOptions, assertResetDataDirectorySafe, POCKETBASE_EXECUTABLE_SHA256_BY_TARGET, pocketBaseExecutableSha256, PocketBaseProcess } from "../backends/pocketbase/process.js";
import { backend, batchRecord, mapPocketBasePage, mapPocketBaseTask, normalizePocketBaseError, taskListFilter } from "../backends/pocketbase/adapter.js";
import { profileExpectedCounts } from "../src/seed.js";
import { BenchmarkOperationError } from "../src/correctness.js";

test("PocketBase setup and measured users use distinct passwords", () => {
  assert.notEqual(LOCAL_SETUP_PASSWORD, LOCAL_BENCHMARK_PASSWORD);
});

test("PocketBase pins executable digests for every supported target before version probing", async () => {
  assert.deepEqual(POCKETBASE_EXECUTABLE_SHA256_BY_TARGET, {
    "darwin-arm64": "804f9ef353684c1c6b03eaaa33ad7b3fef1eda8eb66ec5ecb113730a07f7a210",
    "darwin-x64": "3e6092e9825030ff9b48a685efd8d688ad87c17f4ea9d6a7cd9fc1e17b3d0748",
    "linux-arm64": "bb6f2e3373c7cdbed7f7919a203856f29d713d04cdc550dfec359d5d1437e5b3",
    "linux-x64": "88370d5f6fa4820cd2414fa53c6e168d3dd0e33b7a7fd9ff914265492a7aa3b6",
  });
  assert.equal(pocketBaseExecutableSha256(process.platform, process.arch), POCKETBASE_EXECUTABLE_SHA256_BY_TARGET[`${process.platform}-${process.arch}` as keyof typeof POCKETBASE_EXECUTABLE_SHA256_BY_TARGET]);
  assert.throws(() => pocketBaseExecutableSha256("win32", "x64"), /unsupported.*win32.*x64/i);
  const root = await mkdtemp(join(tmpdir(), "pocketbase-pin-"));
  try {
    const fake = join(root, "pocketbase");
    await writeFile(fake, "spoofed version 0.39.11");
    const options = resolvePocketBaseOptions({ POCKETBASE_BIN: fake, POCKETBASE_DATA_DIR: join(root, "data"), POCKETBASE_URL: "http://127.0.0.1:65534" }, root);
    await assert.rejects(new PocketBaseProcess(options).doctor("win32", "x64"), /unsupported.*win32.*x64/i);
    await assert.rejects(new PocketBaseProcess(options).doctor(), /SHA-256/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("PocketBase rejects noncanonical seed counts before setup", async () => {
  await assert.rejects(backend.seed({ name: "small", definition: { ...profileExpectedCounts("small"), users: 999 } }, 42), /profile/i);
});

test("PocketBase reset refuses repository ancestors and unowned non-empty data", () => {
  assert.throws(() => assertResetDataDirectorySafe("/tmp/repo", "/tmp", false), /ancestor/);
  assert.throws(() => assertResetDataDirectorySafe("/tmp/repo", "/tmp/repo/.data/pocketbase", false), /ownership/);
  assert.doesNotThrow(() => assertResetDataDirectorySafe("/tmp/repo", "/tmp/repo/.data/pocketbase", true));
});

test("PocketBase process options use absolute explicit paths and listener arguments", () => {
  const root = "/tmp/benchmark repository";
  const options = resolvePocketBaseOptions({
    POCKETBASE_BIN: ".tools/pocketbase",
    POCKETBASE_URL: "http://127.0.0.1:8190",
    POCKETBASE_DATA_DIR: ".data/pb-test",
  }, root);

  assert.equal(options.binary, "/tmp/benchmark repository/.tools/pocketbase");
  assert.equal(options.dataDir, "/tmp/benchmark repository/.data/pb-test");
  assert.equal(options.migrationsDir, "/tmp/benchmark repository/backends/pocketbase/pb_migrations");
  assert.deepEqual(buildPocketBaseArgs(options, ["serve", "--http=127.0.0.1:8190"]), [
    "--dir=/tmp/benchmark repository/.data/pb-test",
    "--migrationsDir=/tmp/benchmark repository/backends/pocketbase/pb_migrations",
    "serve",
    "--http=127.0.0.1:8190",
  ]);
});

test("PocketBase process options reject non-local or path-bearing endpoints", () => {
  assert.throws(() => resolvePocketBaseOptions({ POCKETBASE_URL: "https://example.test:8090" }, "/tmp/repo"), /local HTTP/);
  assert.throws(() => resolvePocketBaseOptions({ POCKETBASE_URL: "http://127.0.0.1:8090/base" }, "/tmp/repo"), /path/);
});

test("PocketBase record and page mapping preserves nulls and zero-based pages", () => {
  const task = mapPocketBaseTask({
    id: "tsk000000000001",
    project: "prj000000000001",
    creator: "usr000000000001",
    assignee: "",
    title: "Task",
    description: "Description",
    status: "todo",
    priority: "low",
    dueDate: "",
    created: "2026-01-01 00:00:00.000Z",
    updated: "2026-01-01 00:01:00.000Z",
  });
  assert.equal(task.assigneeId, null);
  assert.equal(task.dueDate, null);
  const page = mapPocketBasePage({ page: 2, perPage: 1, totalItems: 3, totalPages: 3, items: [task] }, (item) => item);
  assert.deepEqual(page, { items: [task], page: 1, pageSize: 1, total: 3, hasNext: true });
});

test("PocketBase filters quote untrusted search values", () => {
  const pb = new PocketBase("http://127.0.0.1:8090");
  const filter = taskListFilter(pb, {
    organizationId: "org000000000001",
    projectId: "prj000000000001",
    query: 'x" || id != "',
  });
  assert.match(filter, /organization = "org000000000001"/);
  assert.match(filter, /x\\" \|\| id != \\"/);
});

test("PocketBase page mapping rejects malformed pagination metadata", () => {
  assert.throws(() => mapPocketBasePage({ page: 1, perPage: 10, totalItems: 2, totalPages: 0, items: [] }, (item: unknown) => item), /page_shape/);
  assert.throws(() => mapPocketBasePage({ page: 1, perPage: 10, totalItems: 2, totalPages: 3, items: [] }, (item: unknown) => item), /page_shape/);
});

test("PocketBase batch entry errors retain auth and authorization classifications", () => {
  assert.throws(() => batchRecord([{ status: 401, body: {} }], 0), (error: unknown) => error instanceof BenchmarkOperationError && error.classification === "authentication");
  assert.throws(() => batchRecord([{ status: 403, body: {} }], 0), (error: unknown) => error instanceof BenchmarkOperationError && error.classification === "authorization");
  assert.throws(() => batchRecord([{ status: 404, body: {} }], 0), (error: unknown) => error instanceof BenchmarkOperationError && error.classification === "authorization");
});

test("PocketBase errors preserve safe status and conceal denied not-found", () => {
  const error = normalizePocketBaseError(new ClientResponseError({ status: 404, response: { message: "secret response" } }));
  assert.ok(error instanceof BenchmarkOperationError);
  assert.equal(error.classification, "authorization");
  assert.equal(error.status, 404);
  assert.equal(error.code, "not_found_or_denied");
  assert.equal(error.message.includes("secret"), false);
});
