import test from "node:test";
import assert from "node:assert/strict";
import PocketBase, { ClientResponseError } from "pocketbase";
import { buildPocketBaseArgs, LOCAL_BENCHMARK_PASSWORD, LOCAL_SETUP_PASSWORD, resolvePocketBaseOptions, assertResetDataDirectorySafe } from "../backends/pocketbase/process.js";
import { batchRecord, mapPocketBasePage, mapPocketBaseTask, normalizePocketBaseError, taskListFilter } from "../backends/pocketbase/adapter.js";
import { BenchmarkOperationError } from "../src/correctness.js";

test("PocketBase setup and measured users use distinct passwords", () => {
  assert.notEqual(LOCAL_SETUP_PASSWORD, LOCAL_BENCHMARK_PASSWORD);
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
