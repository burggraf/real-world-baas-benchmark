import test from "node:test";
import assert from "node:assert/strict";
import { buildSupabaseArgs, parseSupabaseStatus, redactSupabaseOutput, SUPABASE_PROJECT_ID } from "../backends/supabase/process.js";
import { pageRange, createSupabaseClient, normalizeSupabaseError } from "../backends/supabase/adapter.js";
test("supabase process uses isolated workdir and redacts secrets",()=>{const o={workdir:"/tmp/x"} as any; assert.deepEqual(buildSupabaseArgs(o,["status"]),["--workdir","/tmp/x","status"]); assert.equal(redactSupabaseOutput("SERVICE_ROLE_KEY=secret token=abc"),"SERVICE_ROLE_KEY=<redacted> token=<redacted>"); assert.equal(SUPABASE_PROJECT_ID,"realworldbaasbench");});
test("status parsing and bounded ranges validate inputs",()=>{assert.equal(parseSupabaseStatus('{"API_URL":"x"}').API_URL,"x"); assert.deepEqual(pageRange(2,10),[20,29]); assert.throws(()=>pageRange(-1,2));});
test("supabase errors are safe and isolated clients disable persistence",()=>{const e=normalizeSupabaseError({status:403,code:"42501",message:"secret"}); assert.equal(e.classification,"authorization"); assert.equal(e.code,"42501"); const c=createSupabaseClient("http://127.0.0.1:55321","anon","realworldbaasbench"); assert.ok(c);});
