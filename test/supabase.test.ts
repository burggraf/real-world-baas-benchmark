import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildSupabaseArgs,
  parseSupabaseStatus,
  redactSupabaseOutput,
  resolveSupabaseOptions,
  runSynchronousProbe,
  supabaseEnvironment,
  SUPABASE_PORTS,
  SUPABASE_PROJECT_ID,
} from "../backends/supabase/process.js";
import {
  createSupabaseClient,
  escapeLikePattern,
  mapSupabaseActivity,
  mapSupabaseComment,
  mapSupabaseMembership,
  mapSupabaseOrganization,
  mapSupabasePage,
  mapSupabaseProject,
  mapSupabaseTask,
  normalizeSupabaseError,
  publicSupabaseConfiguration,
  seedRecord,
} from "../backends/supabase/adapter.js";

test("Supabase lifecycle uses PATH binary, absolute workdir, and scrubbed CLI overrides", () => {
  const options = resolveSupabaseOptions({ SUPABASE_BIN: "supabase" }, "/tmp/benchmark repo");
  assert.equal(options.binary, "supabase");
  assert.equal(options.workdir, "/tmp/benchmark repo/backends/supabase");
  assert.deepEqual(buildSupabaseArgs(options, ["status", "-o", "json"]), ["--workdir", options.workdir, "status", "-o", "json"]);
  const env = supabaseEnvironment({ SUPABASE_PROJECT_ID: "wrong", SUPABASE_DB_PORT: "1", KEEP: "yes" });
  assert.equal(env.SUPABASE_PROJECT_ID, undefined);
  assert.equal(env.SUPABASE_DB_PORT, undefined);
  assert.equal(env.KEEP, "yes");
  assert.equal(SUPABASE_PROJECT_ID, "realworldbaasbench");
  assert.equal(SUPABASE_PORTS.shadow, 55330);
});

test("synchronous lifecycle probes have bounded, payload-safe failures", () => {
  assert.throws(
    () => runSynchronousProbe(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], "test", 20),
    (error: unknown) => error instanceof Error && error.message === "test probe timed out",
  );
  assert.throws(
    () => runSynchronousProbe(process.execPath, ["-e", "console.error('secret payload'); process.exit(2)"], "test", 1_000),
    (error: unknown) => error instanceof Error && error.message === "test probe failed" && !error.message.includes("secret"),
  );
});

test("status parser requires the benchmark local API and logs redact all known secret forms", () => {
  assert.equal(parseSupabaseStatus('{"API_URL":"http://127.0.0.1:55321"}').API_URL, "http://127.0.0.1:55321");
  assert.throws(() => parseSupabaseStatus('{"API_URL":"https://remote.example"}'));
  const redacted = redactSupabaseOutput('SERVICE_ROLE_KEY="secret" token=abc postgres://postgres:password@127.0.0.1/db {"ANON_KEY":"json-secret"}');
  assert.equal(redacted.includes("secret"), false);
  assert.equal(redacted.includes("abc"), false);
  assert.equal(redacted.includes("postgres:password"), false);
  assert.equal(redacted.includes("json-secret"), false);
});

test("measured client configuration retains no service credential", () => {
  assert.deepEqual(publicSupabaseConfiguration({ API_URL: "http://127.0.0.1:55321", ANON_KEY: "anon", SERVICE_ROLE_KEY: "service" }), {
    url: "http://127.0.0.1:55321",
    publicKey: "anon",
  });
});

test("domain mappings remove snake_case fields and preserve nullable values", () => {
  const timestamp = "2026-01-01T00:00:00Z";
  assert.deepEqual(mapSupabaseOrganization({ id: "org", name: "Org", owner_id: "usr", created_at: timestamp }), { id: "org", name: "Org", ownerId: "usr", createdAt: timestamp });
  assert.deepEqual(mapSupabaseProject({ id: "prj", organization_id: "org", name: "P", status: "active", created_at: timestamp, updated_at: timestamp }), { id: "prj", organizationId: "org", name: "P", status: "active", createdAt: timestamp, updatedAt: timestamp });
  const mappedTask = mapSupabaseTask({ id: "tsk", project_id: "prj", creator_id: "usr", assignee_id: null, title: "T", description: "D", status: "todo", priority: "low", due_date: null, created_at: timestamp, updated_at: timestamp });
  assert.equal(mappedTask.assigneeId, null); assert.equal(mappedTask.dueDate, null); assert.equal("project_id" in mappedTask, false);
  assert.equal(mapSupabaseComment({ id: "cmt", task_id: "tsk", author_id: "usr", body: "B", created_at: timestamp, updated_at: timestamp }).authorId, "usr");
  assert.equal(mapSupabaseActivity({ id: "act", organization_id: "org", project_id: null, actor_id: "usr", action: "created", subject_type: "task", subject_id: "tsk", created_at: timestamp }).projectId, null);
  assert.equal(mapSupabaseMembership({ id: "mem", organization_id: "org", user_id: "usr", role: "member", created_at: timestamp }).organizationId, "org");
  assert.deepEqual(mapSupabasePage([mappedTask], 0, 1, 2), { items: [mappedTask], page: 0, pageSize: 1, total: 2, hasNext: true });
});

test("search escapes Postgres pattern metacharacters and errors expose no payload", () => {
  assert.equal(escapeLikePattern("100%_\\done"), "100\\%\\_\\\\done");
  const error = normalizeSupabaseError({ status: 403, code: "42501", message: "secret payload" });
  assert.equal(error.classification, "authorization");
  assert.equal(error.code, "42501");
  assert.equal(error.message.includes("secret"), false);
  assert.equal(normalizeSupabaseError({ status: 400, code: "invalid_credentials" }).classification, "authentication");
  assert.equal(normalizeSupabaseError({ name: "AuthSessionMissingError" }).classification, "authentication");
  assert.ok(createSupabaseClient("http://127.0.0.1:55321", "anon", "realworldbaasbench"));
});

test("migration indexes ilike and safely enforces immutable keys for every mutable table", () => {
  const sql = readFileSync("backends/supabase/supabase/migrations/0001_benchmark.sql", "utf8");
  assert.match(sql, /create extension if not exists pg_trgm/);
  assert.match(sql, /title extensions\.gin_trgm_ops/);
  assert.match(sql, /to_jsonb\(new\)/);
  assert.match(sql, /create trigger activities_immutable/);
  for (const fn of ["enforce_immutable_keys", "enforce_membership_role", "touch_updated_at", "log_workflow_activity"]) {
    assert.match(sql, new RegExp(`revoke all on function private\\.${fn}\\(\\) from public`));
  }
});

test("migration enables RLS everywhere and enforces same-tenant relationships", () => {
  const sql = readFileSync("backends/supabase/supabase/migrations/0001_benchmark.sql", "utf8");
  for (const table of ["profiles", "organizations", "memberships", "projects", "tasks", "comments", "activities"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  for (const relationship of [
    "foreign key (project_id, organization_id) references public.projects(id, organization_id)",
    "foreign key (organization_id, creator_id) references public.memberships(organization_id, user_id)",
    "foreign key (organization_id, assignee_id) references public.memberships(organization_id, user_id)",
    "foreign key (task_id, project_id, organization_id) references public.tasks(id, project_id, organization_id)",
    "foreign key (organization_id, author_id) references public.memberships(organization_id, user_id)",
    "foreign key (organization_id, actor_id) references public.memberships(organization_id, user_id)",
  ]) assert.ok(sql.includes(relationship), relationship);
  assert.match(sql, /memberships_manager_update[\s\S]*private\.is_manager/);
  assert.match(sql, /profiles_self_update[\s\S]*private\.current_profile_id/);
});

test("seed mapping carries explicit tenant keys into child records", () => {
  const task = seedRecord("task", { id: "tsks00000000000", projectId: "prjs00000000000", creatorId: "usrs00000000000", assigneeId: null, title: "T", description: "D", status: "todo", priority: "low", dueDate: null, createdAt: "x", updatedAt: "x" } as any, "small");
  assert.equal(task.organization_id, "orgs00000000000");
  assert.equal(task.project_id, "prjs00000000000");
});
