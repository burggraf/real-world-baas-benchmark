import test from "node:test";
import assert from "node:assert/strict";
import { createSessionRequestController, validateSessionRequestTimeout } from "../src/session-request.js";
import { createPocketBaseMeasuredClient } from "../backends/pocketbase/adapter.js";
import { createSupabaseClient, createSupabaseSession } from "../backends/supabase/adapter.js";
import { createTrailBaseMeasuredClient, createTrailBaseSession } from "../backends/trailbase/adapter.js";

test("request controller aborts injected pending fetch and rotation permits cleanup", async () => {
  const controller = createSessionRequestController({ timeoutMs: 1000 });
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
  }) as typeof fetch;
  try {
    const pending = controller.fetch("https://bench.test/pending");
    controller.cancelPending();
    await assert.rejects(pending, { name: "AbortError" });
    controller.detachParent();
    const cleanup = controller.fetch("https://bench.test/cleanup");
    assert.equal(calls, 2);
    controller.cancelPending();
    await assert.rejects(cleanup, { name: "AbortError" });
  } finally { globalThis.fetch = original; }
});

test("request controller combines caller and parent signals without exposing abort reasons", async () => {
  const parent = new AbortController();
  const controller = createSessionRequestController({ signal: parent.signal, timeoutMs: 1000 });
  const caller = new AbortController();
  const signal = controller.signal(caller.signal);
  assert.equal(signal.aborted, false);
  caller.abort(new Error("credential=secret"));
  assert.equal(signal.aborted, true);
  controller.detachParent();
  parent.abort();
  assert.equal(controller.signal().aborted, false);
});

test("official adapter transports receive the rotatable bounded signal", async () => {
  const pocket = createPocketBaseMeasuredClient("http://127.0.0.1:8090", { timeoutMs: 1000 });
  const before = await pocket.client.beforeSend!("http://127.0.0.1:8090/api", {} as any);
  const beforeSignal = before.options?.signal;
  assert.ok(beforeSignal);
  pocket.request.cancelPending();
  assert.equal(beforeSignal.aborted, true);

  const trail = createTrailBaseMeasuredClient("http://127.0.0.1:4000", createSessionRequestController({ timeoutMs: 1000 }));
  assert.equal(typeof trail.fetch, "function");

  const original = globalThis.fetch;
  let supabaseSignal: AbortSignal | undefined;
  globalThis.fetch = (async (_input, init) => {
    supabaseSignal = init?.signal ?? undefined;
    return new Response(JSON.stringify({ error: null, data: { user: null, session: null } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try { await createSupabaseClient("http://127.0.0.1:54321", "public-key", "project", "test", createSessionRequestController({ timeoutMs: 1000 })).auth.signInWithPassword({ email: "user@example.test", password: "not-recorded" }); }
  finally { globalThis.fetch = original; }
  assert.ok(supabaseSignal);
});

test("each official measured adapter aborts a stalled request", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
    if (init?.signal?.aborted) reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    else init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  })) as typeof fetch;
  try {
    const pocket = createPocketBaseMeasuredClient("http://127.0.0.1:8090", { timeoutMs: 1000 });
    const pocketPending = pocket.client.health.check();
    pocket.request.cancelPending();
    await assert.rejects(pocketPending);

    const supabaseRequest = createSessionRequestController({ timeoutMs: 1000 });
    const supabasePending = createSupabaseClient("http://127.0.0.1:54321", "public-key", "project", "stalled", supabaseRequest).auth.signInWithPassword({ email: "user@example.test", password: "not-recorded" });
    supabaseRequest.cancelPending();
    await supabasePending;

    const trailRequest = createSessionRequestController({ timeoutMs: 1000 });
    const trailPending = createTrailBaseMeasuredClient("http://127.0.0.1:4000", trailRequest).fetch("/api/stalled");
    trailRequest.cancelPending();
    await assert.rejects(trailPending, { name: "AbortError" });
  } finally { globalThis.fetch = original; }
});

test("Supabase post-auth setup failure signs out the authenticated client", async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  let requestCount = 0;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    paths.push(new URL(url).pathname);
    requestCount++;
    if (requestCount === 1) return new Response(JSON.stringify({ access_token: "access", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "refresh", user: { id: "auth-user", aud: "authenticated", role: "authenticated", email: "user@example.test", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } }), { status: 200, headers: { "content-type": "application/json" } });
    if (requestCount === 2) return new Response(JSON.stringify({ message: "profile unavailable" }), { status: 500, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({}), { status: 204 });
  }) as typeof fetch;
  try {
    await assert.rejects(createSupabaseSession({ email: "user@example.test", password: "not-recorded" }, { timeoutMs: 1000 }, { url: "http://127.0.0.1:54321", publicKey: "public-key" }), /profile|supabase/i);
  } finally { globalThis.fetch = original; }
  assert.ok(paths.some(path => path.endsWith("/auth/v1/logout")), paths.join(","));
});

test("TrailBase post-auth setup failure logs out after parent cancellation", async () => {
  const original = globalThis.fetch;
  const parent = new AbortController();
  const subject = "A".repeat(22) + "==";
  const payload = Buffer.from(JSON.stringify({ sub: subject, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const authToken = `e30.${payload}.signature`;
  const paths: string[] = [];
  let logoutSignal: AbortSignal | undefined;
  let requestCount = 0;
  globalThis.fetch = (async (input, init) => {
    paths.push(new URL(String(input)).pathname);
    requestCount++;
    if (requestCount === 1) return new Response(JSON.stringify({ auth_token: authToken, refresh_token: "refresh", csrf_token: null }), { status: 200, headers: { "content-type": "application/json" } });
    if (requestCount === 2) {
      parent.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    logoutSignal = init?.signal ?? undefined;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    await assert.rejects(createTrailBaseSession({ email: "user@example.test", password: "not-recorded" }, { signal: parent.signal, timeoutMs: 1000 }));
  } finally { globalThis.fetch = original; }
  assert.ok(paths.some(path => path.endsWith("/api/auth/v1/logout")), paths.join(","));
  assert.equal(logoutSignal?.aborted, false);
});

test("request timeout validation rejects invalid values", () => {
  assert.equal(validateSessionRequestTimeout(10), 10);
  for (const value of [0, -1, 0.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => validateSessionRequestTimeout(value), /positive safe integer/);
});
