import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildTrailBaseArgs, resolveTrailBaseOptions, assertResetDataDirectorySafe, LOCAL_SETUP_PASSWORD, LOCAL_BENCHMARK_PASSWORD } from "../backends/trailbase/process.js";
import { mapTrailBaseTask, trailBaseTaskFilters, normalizeTrailBaseError } from "../backends/trailbase/adapter.js";

test("TrailBase options are local, absolute, and use data-dir argv", () => {
  const o=resolveTrailBaseOptions({TRAILBASE_BIN:".tools/trail",TRAILBASE_URL:"http://127.0.0.1:8191",TRAILBASE_DATA_DIR:".data/tb"},"/tmp/repo");
  assert.equal(o.binary,"/tmp/repo/.tools/trail"); assert.equal(o.dataDir,"/tmp/repo/.data/tb");
  assert.deepEqual(buildTrailBaseArgs(o,["run","--address",o.listen]),["--depot","/tmp/repo/.data/tb","run","--address","127.0.0.1:8191"]);
  assert.throws(()=>resolveTrailBaseOptions({TRAILBASE_URL:"https://evil.test"},"/tmp/repo"),/local HTTP/);
  assert.throws(()=>resolveTrailBaseOptions({TRAILBASE_URL:"http://127.0.0.1:8191/x"},"/tmp/repo"),/path/);
});
test("TrailBase reset safety and setup credentials",()=>{assert.notEqual(LOCAL_SETUP_PASSWORD,LOCAL_BENCHMARK_PASSWORD); assert.throws(()=>assertResetDataDirectorySafe("/tmp/repo","/tmp",false),/ancestor/); assert.throws(()=>assertResetDataDirectorySafe("/tmp/repo","/tmp/repo/.data/tb",false),/ownership/);});
test("TrailBase mapping validates enums and preserves nulls",()=>{const t=mapTrailBaseTask({publicId:"tsk00000000001",projectId:"prj00000000001",creatorId:"usr00000000001",assigneeId:null,title:"x",description:"",status:"todo",priority:"low",dueDate:null,createdAt:"2026",updatedAt:"2026"}); assert.equal(t.assigneeId,null); assert.equal(t.dueDate,null); assert.throws(()=>mapTrailBaseTask({...t,publicId:"tsk00000000001",status:"bad"}),/record_enum/);});
test("TrailBase filters bind tenant context and search as SDK filters",()=>{const f=trailBaseTaskFilters({organizationId:"org",projectId:"prj",page:0,pageSize:10,query:"x"}); assert.deepEqual(f.slice(0,2),[{column:"organizationId",op:"equal",value:"org"},{column:"projectId",op:"equal",value:"prj"}]); assert.match(JSON.stringify(f),/x/);});
test("TrailBase error normalization does not leak response text",()=>{const e=normalizeTrailBaseError({status:403,message:"secret"}); assert.equal(e.classification,"authorization"); assert.equal(e.message.includes("secret"),false);});
test("TrailBase schema and config cover every tenant table",async()=>{const sql=await readFile(resolve("backends/trailbase/migrations/U1787223330__canonical.sql"),"utf8"); for(const table of ["users","profiles","organizations","memberships","projects","tasks","comments","activities"]) assert.match(sql,new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`)); assert.match(sql,/tenant_frozen/); const config=await readFile(resolve("backends/trailbase/config.textproto"),"utf8"); for(const api of ["profiles","organizations","memberships","projects","tasks","comments","activities"]) assert.match(config,new RegExp(`name: \\\"${api}\\\"`));});
