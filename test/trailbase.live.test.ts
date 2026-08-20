import test from "node:test";
import assert from "node:assert/strict";
import { backend, seedTrailBaseCorrectnessFixture } from "../backends/trailbase/adapter.js";
import { runCorrectness, BenchmarkOperationError } from "../src/correctness.js";
const live=process.env.BENCH_LIVE==="1";
const denied=(e:unknown)=>e instanceof BenchmarkOperationError&&e.classification==="authorization";
test("TrailBase live correctness",{skip:live?false:"set BENCH_LIVE=1 to run"},async()=>{let started=false;try{await backend.reset();started=true;const f=await seedTrailBaseCorrectnessFixture();const r=await runCorrectness(backend,f);assert.equal(r.aborted,false,r.abortReason);assert.deepEqual(r.findings.filter(x=>!x.passed),[]);const a=await backend.createSession(f.admin);try{await assert.rejects(a.updateMembershipRole({organizationId:f.organizationId,membershipId:f.foreignMembershipId,role:"admin"}),denied);}finally{await a.close();}}finally{await backend.stop();if(started){assert.deepEqual((await backend.doctor()).processIds,[]);await assert.rejects(fetch(`${process.env.TRAILBASE_URL||"http://127.0.0.1:8090"}/api/auth/v1/login`));}}});
