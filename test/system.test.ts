import test from "node:test";
import assert from "node:assert/strict";
import { parseByteUnit, parseDockerStats, parsePs, parseSysctl, parseCpuInfo, parseMemInfo, evaluateRunnerOverload, sampleResources, collectResources, captureEnvironment } from "../src/system.js";
import type { BenchmarkResult } from "../src/result.js";

test("system parsers reject malformed values and parse units", () => {
  assert.equal(parseByteUnit("1.5 GiB"), 1610612736);
  assert.equal(parseByteUnit("2 MB"), 2000000);
  assert.equal(parseByteUnit("nope"), null);
  assert.deepEqual(parseSysctl("hw.cpufrequency: 2400000000\nhw.logicalcpu: 8\nhw.memsize: 17179869184"), { model: null, logicalCores: 8, memoryBytes: 17179869184 });
  assert.deepEqual(parsePs("123 4.5 10m\n bad x -1\n"), [{ pid: 123, cpuPercent: 4.5, rssBytes: 10485760 }]);
  assert.deepEqual(parseDockerStats('{"ID":"abc123","CPUPerc":"2.5%","MemUsage":"1.5GiB / 4GiB","BlockIO":"2MB / 3.5 MiB"}'), [{containerId:"abc123", cpuPercent:2.5, memoryBytes:1610612736, blockReadBytes:2000000, blockWriteBytes:3670016}]);
  assert.deepEqual(parseCpuInfo("processor: 0\nmodel name: CPU\nprocessor: 1"), {model:"CPU", logicalCores:2});
  assert.equal(parseMemInfo("MemTotal:       16384 kB"), 16777216);
  assert.equal(parseDockerStats('{"ID":"abc","CPUPerc":"250%","MemUsage":"1 B / 2 B","BlockIO":"1 B / 2 B"}')[0]?.cpuPercent, 250);
});

test("resource sampling scopes owned PIDs and cleans up without waiting", async () => {
  const calls: string[][] = []; let disabled = 0;
  const eventLoop = { percentile: () => 5_000_000, max: 8_000_000, reset() {}, disable() { disabled++; } };
  const commandRunner = async (command:string, args:string[]) => { calls.push([command, ...args]); return {stdout:"10 1.5 20\n11 2.5 30\n", stderr:"secret-never-used"}; };
  const one = await sampleResources({backend:{name:"pocketbase",version:"1",endpoint:"",processIds:[11]},runnerPid:10,commandRunner,eventLoop,nowNs:()=>7_000_000});
  assert.deepEqual(calls[0], ["ps","-o","pid=,pcpu=,rss=","-p","10,11"]);
  assert.equal(one.backend.totalCpuPercent, 2.5); assert.equal(one.eventLoop.p99Ms, 5); assert.equal(one.eventLoop.maxMs, 8);
  const result = await collectResources({backend:{name:"pocketbase",version:"1",endpoint:"",processIds:[11]},runnerPid:10,commandRunner,eventLoop,maxSamples:2,sleep:async()=>{},nowNs:()=>7_000_000});
  assert.equal(result.samples.length, 2); assert.equal(disabled, 1);
});

test("Supabase sampling discovers then scopes exact container IDs", async () => {
  const calls:string[][]=[]; const runner=async(command:string,args:string[]) => { calls.push([command,...args]); if(command === "docker" && args[0] === "ps") return {stdout:"deadbeef\n",stderr:""}; if(command === "docker") return {stdout:'{"ID":"deadbeef","CPUPerc":"1%","MemUsage":"1 MiB / 2 MiB","BlockIO":"3 KB / 4 KB"}',stderr:""}; return {stdout:"20 1 10",stderr:""}; };
  const sample=await sampleResources({backend:{name:"supabase",version:"1",endpoint:"",processIds:[999],supabaseProjectId:"project"},runnerPid:20,commandRunner:runner,eventLoop:{percentile:()=>1e6,max:1e6,reset(){},disable(){}}, nowNs:()=>1_000_000});
  assert.equal(sample.containers?.[0]?.containerId,"deadbeef"); assert.deepEqual(calls[2], ["docker","stats","--no-stream","--format","{{json .}}","deadbeef"]);
});

test("abort before sampling is clean", async () => { const controller=new AbortController(); controller.abort(); let called=false; const result=await collectResources({backend:{name:"pocketbase",version:"1",endpoint:""},signal:controller.signal,commandRunner:async()=>{called=true;return {stdout:"",stderr:""}}}); assert.equal(called,false); assert.deepEqual(result.validityReasons,["aborted before sampling"]); });

test("environment probes are bounded, shell-free, and preserve unavailable reasons", async () => {
  const calls:string[][]=[]; const runner=async(command:string,args:string[]) => { calls.push([command,...args]); if(command === "git" && args[0] === "rev-parse") return {stdout:"a".repeat(40),stderr:"secret"}; if(command === "git") return {stdout:" M src/file.ts",stderr:"secret"}; if(command === "npm") return {stdout:"bad version",stderr:"secret"}; return {stdout:"",stderr:"secret"}; };
  const env=await captureEnvironment({name:"pocketbase",version:"1",endpoint:""},"1.2.3",runner,async path => path.endsWith("cpuinfo") ? "model name: Test CPU\nprocessor: 0\nprocessor: 1" : "MemTotal: 1024 kB");
  assert.equal(env.gitDirty,true); assert.equal(env.npmVersion,null); assert.equal(env.sdkVersion,"1.2.3"); assert.match(env.unavailable.npmVersion!,/malformed/); assert.ok(calls.every(([command]) => command !== "cat")); assert.ok(!JSON.stringify(env).includes("secret"));
});

test("captured environment and resource snapshots serialize as BenchmarkResult", async () => {
  const environment=await captureEnvironment({name:"pocketbase",version:"1",endpoint:""},"1.2.3",async (command,args) => ({stdout: command === "git" && args[0] === "rev-parse" ? "b".repeat(40) : "",stderr:""}),async path => path.endsWith("cpuinfo") ? "model name: CPU\nprocessor: 0" : "MemTotal: 1024 kB");
  const snapshot={timestampMs:1,runner:{pid:1,cpuPercent:1,rssBytes:1024},backend:{totalCpuPercent:null,totalRssBytes:null,processes:[],reason:"no registered backend PIDs"},containers:null,containerTotals:null,eventLoop:{p99Ms:null,maxMs:null,reason:"not enough event-loop observations"}};
  const result:BenchmarkResult={schemaVersion:1,runId:"r",startedAt:"2026-01-01T00:00:00Z",publishable:false,backend:environment.backend,dataset:"small",seed:1,environment,versions:{},config:{} as BenchmarkResult["config"],correctness:{findings:[]},stages:[],resources:[{name:"system",unit:"snapshot",samples:[],snapshots:[snapshot]}],capacity:{users:0,saturation:false,reasons:[]},failures:[],valid:true,validityReasons:[]};
  const parsed=JSON.parse(JSON.stringify(result)) as BenchmarkResult; assert.equal(parsed.environment.sdkVersion,"1.2.3"); assert.equal(parsed.resources[0]!.snapshots?.[0]!.backend.reason,"no registered backend PIDs");
});

test("runner overload requires consecutive samples", () => {
  const base = (timestampMs:number,cpu:number,p99:number) => ({timestampMs, runner:{pid:1,cpuPercent:cpu,rssBytes:1}, eventLoop:{p99Ms:p99,maxMs:p99}, backend:{totalCpuPercent:null,totalRssBytes:null,processes:[]}, containers:null, containerTotals:null});
  assert.equal(evaluateRunnerOverload([base(1,99,1),base(2,1,1)],{cpuPercent:90}), null);
  assert.ok(evaluateRunnerOverload([base(1,99,1),base(2,99,1),base(3,99,1)],{cpuPercent:90}));
});
