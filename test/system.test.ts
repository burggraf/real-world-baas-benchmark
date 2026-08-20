import test from "node:test";
import assert from "node:assert/strict";
import { parseByteUnit, parseDockerStats, parsePs, parseSysctl, parseCpuInfo, parseMemInfo, evaluateRunnerOverload, sampleResources, collectResources } from "../src/system.js";

test("system parsers reject malformed values and parse units", () => {
  assert.equal(parseByteUnit("1.5 GiB"), 1610612736);
  assert.equal(parseByteUnit("2 MB"), 2000000);
  assert.equal(parseByteUnit("nope"), null);
  assert.deepEqual(parseSysctl("hw.cpufrequency: 2400000000\nhw.logicalcpu: 8\nhw.memsize: 17179869184"), { model: null, logicalCores: 8, memoryBytes: 17179869184 });
  assert.deepEqual(parsePs("123 4.5 10m\n bad x -1\n"), [{ pid: 123, cpuPercent: 4.5, rssBytes: 10485760 }]);
  assert.deepEqual(parseDockerStats('{"ID":"abc123","CPUPerc":"2.5%","MemUsage":"1.5GiB / 4GiB","BlockIO":"2MB / 3.5 MiB"}'), [{containerId:"abc123", cpuPercent:2.5, memoryBytes:1610612736, blockReadBytes:2000000, blockWriteBytes:3670016}]);
  assert.deepEqual(parseCpuInfo("processor: 0\nmodel name: CPU\nprocessor: 1"), {model:"CPU", logicalCores:2});
  assert.equal(parseMemInfo("MemTotal:       16384 kB"), 16777216);
});

test("resource sampling scopes owned PIDs and cleans up without waiting", async () => {
  const calls: string[][] = []; let disabled = 0;
  const eventLoop = { percentile: () => 5_000_000, max: 8_000_000, reset() {}, disable() { disabled++; } };
  const commandRunner = async (command:string, args:string[]) => { calls.push([command, ...args]); return {stdout:"10 1.5 20\n11 2.5 30\n", stderr:"secret-never-used"}; };
  const one = await sampleResources({backend:{name:"pocketbase",version:"1",endpoint:"",processIds:[11]},runnerPid:10,commandRunner,eventLoop,nowNs:()=>7});
  assert.deepEqual(calls[0], ["ps","-o","pid=,pcpu=,rss=","-p","10,11"]);
  assert.equal(one.backend.totalCpuPercent, 2.5); assert.equal(one.eventLoop.p99Ms, 5); assert.equal(one.eventLoop.maxMs, 8);
  const result = await collectResources({backend:{name:"pocketbase",version:"1",endpoint:"",processIds:[11]},runnerPid:10,commandRunner,eventLoop,maxSamples:2,sleep:async()=>{},nowNs:()=>7});
  assert.equal(result.samples.length, 2); assert.equal(disabled, 1);
});

test("Supabase sampling discovers then scopes exact container IDs", async () => {
  const calls:string[][]=[]; const runner=async(command:string,args:string[]) => { calls.push([command,...args]); if(command === "docker" && args[0] === "ps") return {stdout:"deadbeef\n",stderr:""}; if(command === "docker") return {stdout:'{"ID":"deadbeef","CPUPerc":"1%","MemUsage":"1 MiB / 2 MiB","BlockIO":"3 KB / 4 KB"}',stderr:""}; return {stdout:"20 1 10",stderr:""}; };
  const sample=await sampleResources({backend:{name:"supabase",version:"1",endpoint:"",processIds:[999],supabaseProjectId:"project"},runnerPid:20,commandRunner:runner,eventLoop:{percentile:()=>1e6,max:1e6,reset(){},disable(){}}, nowNs:()=>1});
  assert.equal(sample.containers?.[0]?.containerId,"deadbeef"); assert.deepEqual(calls[2], ["docker","stats","--no-stream","--format","{{json .}}","deadbeef"]);
});

test("abort before sampling is clean", async () => { const controller=new AbortController(); controller.abort(); let called=false; const result=await collectResources({backend:{name:"pocketbase",version:"1",endpoint:""},signal:controller.signal,commandRunner:async()=>{called=true;return {stdout:"",stderr:""}}}); assert.equal(called,false); assert.deepEqual(result.validityReasons,["aborted before sampling"]); });

test("runner overload requires consecutive samples", () => {
  const base = (cpu:number,p99:number) => ({timestampNs:1, runner:{cpuPercent:cpu,rssBytes:1}, eventLoop:{p99Ms:p99,maxMs:p99}, backend:{}} as any);
  assert.equal(evaluateRunnerOverload([base(99,1),base(1,1)],{cpuPercent:90}), null);
  assert.ok(evaluateRunnerOverload([base(99,1),base(99,1),base(99,1)],{cpuPercent:90}));
});
