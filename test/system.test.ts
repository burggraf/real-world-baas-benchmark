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
  assert.deepEqual(parseDockerStats('{"ID":"abcdef123456","CPUPerc":"2.5%","MemUsage":"1.5GiB / 4GiB","BlockIO":"2MB / 3.5 MiB"}'), [{containerId:"abcdef123456", cpuPercent:2.5, memoryBytes:1610612736, blockReadBytes:2000000, blockWriteBytes:3670016}]);
  assert.deepEqual(parseCpuInfo("processor\t: 0\n model name\t: CPU \nprocessor\t: 1"), {model:"CPU", logicalCores:2});
  assert.equal(parseMemInfo("  MemTotal\t:       16384 kB"), 16777216);
  assert.deepEqual(parseSysctl("  hw.logicalcpu : 8 \n hw.memsize\t: 1024 "), {model:null,logicalCores:8,memoryBytes:1024});
  assert.equal(parseDockerStats('{"ID":"abcdef123456","CPUPerc":"250%","MemUsage":"1 B / 2 B","BlockIO":"1 B / 2 B"}')[0]?.cpuPercent, 250);
});

test("resource sampling scopes owned PIDs and cleans up without waiting", async () => {
  const calls: string[][] = []; let disabled = 0;
  const eventLoop = { percentile: () => 5_000_000, max: 8_000_000, reset() {}, disable() { disabled++; } };
  const commandRunner = async (command:string, args:string[]) => { calls.push([command, ...args]); return {stdout:"10 1.5 20 node\n11 2.5 30 pocketbase\n", stderr:"secret-never-used"}; };
  const one = await sampleResources({backend:{name:"pocketbase",version:"1",endpoint:"",processIds:[11],processExecutable:"/tools/pocketbase"},runnerPid:10,commandRunner,eventLoop,nowNs:()=>7_000_000});
  assert.deepEqual(calls[0], ["ps","-o","pid=,pcpu=,rss=,comm=","-p","10,11"]);
  assert.equal(one.backend.totalCpuPercent, 2.5); assert.equal(one.eventLoop.p99Ms, 5); assert.equal(one.eventLoop.maxMs, 8);
  const result = await collectResources({backend:{name:"pocketbase",version:"1",endpoint:"",processIds:[11],processExecutable:"pocketbase"},runnerPid:10,commandRunner,eventLoop,maxSamples:2,sleep:async()=>{},nowNs:()=>7_000_000});
  assert.equal(result.samples.length, 2); assert.equal(disabled, 1);
});

test("Supabase sampling discovers then scopes exact container IDs", async () => {
  const calls:string[][]=[]; const runner=async(command:string,args:string[]) => { calls.push([command,...args]); if(command === "docker" && args[0] === "ps") return {stdout:"deadbeef123456\n",stderr:""}; if(command === "docker") return {stdout:'{"ID":"deadbeef123456","CPUPerc":"1%","MemUsage":"1 MiB / 2 MiB","BlockIO":"3 KB / 4 KB"}',stderr:""}; return {stdout:"20 1 10",stderr:""}; };
  const sample=await sampleResources({backend:{name:"supabase",version:"1",endpoint:"",processIds:[999],supabaseProjectId:"project"},runnerPid:20,commandRunner:runner,eventLoop:{percentile:()=>1e6,max:1e6,reset(){},disable(){}}, nowNs:()=>1_000_000});
  assert.equal(sample.containers?.[0]?.containerId,"deadbeef123456"); assert.deepEqual(calls[2], ["docker","stats","--no-stream","--format","{{json .}}","deadbeef123456"]);
});

test("registered executable identity is exact for backend PIDs", async () => {
  const eventLoop={percentile:()=>1e6,max:1e6,reset(){},disable(){}}; const run=async()=>({stdout:"10 1 1 node\n11 2 2 trail",stderr:""});
  const accepted=await sampleResources({backend:{name:"trailbase",version:"1",endpoint:"",processIds:[11],processExecutable:"/tools/trail"},runnerPid:10,commandRunner:run,eventLoop,nowNs:()=>1e6}); assert.equal(accepted.backend.totalCpuPercent,2);
  for(const executable of ["trailbase-other",undefined]) { const rejected=await sampleResources({backend:{name:"trailbase",version:"1",endpoint:"",processIds:[11],processExecutable:executable},runnerPid:10,commandRunner:run,eventLoop,nowNs:()=>1e6}); assert.equal(rejected.backend.totalCpuPercent,null); assert.match(rejected.backend.reason!,/unavailable/); }
  const same=await sampleResources({backend:{name:"trailbase",version:"1",endpoint:"",processIds:[10],processExecutable:"trail"},runnerPid:10,commandRunner:run,eventLoop,nowNs:()=>1e6}); assert.equal(same.backend.totalCpuPercent,null);
});

test("owned event-loop monitors warm once and clean up", async () => {
  let warmed=0,resets=0,disabled=0,max=0; const factory=()=>({percentile:()=>max,max:()=>max,reset(){resets++;},disable(){disabled++;}});
  const sample=await sampleResources({backend:{name:"pocketbase",version:"1",endpoint:""},runnerPid:10,commandRunner:async()=>({stdout:"10 1 1 node",stderr:""}),monitorFactory:factory,warmupSleep:async()=>{warmed++;max=4e6;},nowNs:()=>1e6}); assert.equal(sample.eventLoop.maxMs,4); assert.equal(warmed,1); assert.equal(resets,1); assert.equal(disabled,1);
  await assert.rejects(()=>sampleResources({backend:{name:"pocketbase",version:"1",endpoint:""},runnerPid:10,commandRunner:async()=>({stdout:"10 1 1 node",stderr:""}),monitorFactory:factory,warmupSleep:async()=>{},nowNs:()=>NaN})); assert.equal(disabled,2);
});

test("aggregate overflow is null with explicit evidence", async () => {
  const eventLoop={percentile:()=>1e6,max:1e6,reset(){},disable(){}}; const proc=await sampleResources({backend:{name:"pocketbase",version:"1",endpoint:"",processIds:[11,12],processExecutable:"pocketbase"},runnerPid:10,commandRunner:async()=>({stdout:"10 1 1 node\n11 1 5000000000000 pocketbase\n12 1 5000000000000 pocketbase",stderr:""}),eventLoop,nowNs:()=>1e6}); assert.equal(proc.backend.totalRssBytes,null); assert.match(proc.backend.reason!,/overflow/);
  const ids=["aaaaaaaaaaaa","bbbbbbbbbbbb"]; const docker=async(command:string,args:string[])=>command==="ps"?{stdout:"10 1 1 node",stderr:""}:args[0]==="ps"?{stdout:ids.join("\n"),stderr:""}:{stdout:ids.map(id=>JSON.stringify({ID:id,CPUPerc:"1%",MemUsage:"5000000000000000 B / 1 B",BlockIO:"1 B / 1 B"})).join("\n"),stderr:""}; const containers=await sampleResources({backend:{name:"supabase",version:"1",endpoint:"",supabaseProjectId:"p"},runnerPid:10,commandRunner:docker,eventLoop,nowNs:()=>1e6}); assert.equal(containers.containerTotals,null); assert.match(containers.containerReason!,/overflow/);
});

test("abort before sampling is clean", async () => { const controller=new AbortController(); controller.abort(); let called=false; let monitors=0; const result=await collectResources({backend:{name:"pocketbase",version:"1",endpoint:""},signal:controller.signal,monitorFactory:()=>{monitors++;throw new Error("must not create");},commandRunner:async()=>{called=true;return {stdout:"",stderr:""}}}); assert.equal(called,false); assert.equal(monitors,0); assert.deepEqual(result.validityReasons,["aborted before sampling"]); });

test("environment probes are bounded, shell-free, and preserve unavailable reasons", async () => {
  const calls:string[][]=[]; const runner=async(command:string,args:string[]) => { calls.push([command,...args]); if(command === "git" && args[0] === "rev-parse") return {stdout:"a".repeat(40),stderr:"secret"}; if(command === "git") return {stdout:" M src/file.ts",stderr:"secret"}; if(command === "npm") return {stdout:"bad version",stderr:"secret"}; return {stdout:"",stderr:"secret"}; };
  const env=await captureEnvironment({name:"pocketbase",version:"1",endpoint:""},"1.2.3",runner,async path => path.endsWith("cpuinfo") ? "model name: Test CPU\nprocessor: 0\nprocessor: 1" : "MemTotal: 1024 kB");
  assert.equal(env.gitDirty,true); assert.equal(env.npmVersion,null); assert.equal(env.sdkVersion,"1.2.3"); assert.match(env.unavailable.npmVersion!,/malformed/); assert.ok(calls.every(([command]) => command !== "cat")); assert.ok(!JSON.stringify(env).includes("secret"));
  const owned=[12_345]; const deviations=["safe"]; const source={name:"pocketbase" as const,version:"1",endpoint:"",processIds:owned,deviations}; const copied=await captureEnvironment(source,"1.2.3",runner,async path => path.endsWith("cpuinfo") ? "processor: 0" : "MemTotal: 1 kB"); owned.push(99); deviations.push("changed"); assert.deepEqual(copied.backend.processIds,[12_345]); assert.deepEqual(copied.backend.deviations,["safe"]);
});

test("captured environment and resource snapshots serialize as BenchmarkResult", async () => {
  const environment=await captureEnvironment({name:"pocketbase",version:"1",endpoint:""},"1.2.3",async (command,args) => ({stdout: command === "git" && args[0] === "rev-parse" ? "b".repeat(40) : "",stderr:""}),async path => path.endsWith("cpuinfo") ? "model name: CPU\nprocessor: 0" : "MemTotal: 1024 kB");
  const snapshot={timestampMs:1,runner:{pid:1,cpuPercent:1,rssBytes:1024},backend:{totalCpuPercent:null,totalRssBytes:null,processes:[],reason:"no registered backend PIDs"},containers:null,containerTotals:null,eventLoop:{p99Ms:null,maxMs:null,reason:"not enough event-loop observations"}};
  const result:BenchmarkResult={schemaVersion:1,runId:"r",startedAt:"2026-01-01T00:00:00Z",publishable:false,backend:environment.backend,dataset:"small",seed:1,environment,versions:{},config:{} as BenchmarkResult["config"],correctness:{findings:[]},stages:[],resources:[{name:"system",unit:"snapshot",samples:[],snapshots:[snapshot]}],capacity:{users:0,saturation:false,reasons:[]},failures:[],valid:true,validityReasons:[]};
  const parsed=JSON.parse(JSON.stringify(result)) as BenchmarkResult; assert.equal(parsed.environment.sdkVersion,"1.2.3"); assert.equal(parsed.resources[0]!.snapshots?.[0]!.backend.reason,"no registered backend PIDs");
});

test("collector samples immediately, serializes commands, enforces ceilings, aborts cleanly, and cleans monitors", async () => {
  const backend={name:"pocketbase" as const,version:"1",endpoint:"",processIds:[11],processExecutable:"/tools/pocketbase"}; let calls=0; let active=0; let maxActive=0; let now=0; let resets=0; let disabled=0;
  const eventLoop={percentile:()=>1e6,max:1e6,reset(){resets++;},disable(){disabled++;}}; const runner=async()=>{active++; maxActive=Math.max(maxActive,active); await Promise.resolve(); active--; calls++; return {stdout:"10 1 20 node\n11 2.5 30 pocketbase",stderr:""};};
  const bounded=await collectResources({backend,runnerPid:10,commandRunner:runner,eventLoop,maxSamples:2,sleep:async()=>{},nowNs:()=>++now}); assert.equal(calls,2); assert.equal(bounded.samples.length,2); assert.equal(bounded.valid,false); assert.deepEqual(bounded.validityReasons,["maxSamples ceiling exceeded"]); assert.equal(maxActive,1); assert.equal(resets,2); assert.equal(disabled,1);
  calls=0; now=0; const stopped=await collectResources({backend,runnerPid:10,commandRunner:runner,eventLoop:{...eventLoop,disable(){}},maxSamples:2,sleep:async()=>{},shouldStop:()=>calls===2,nowNs:()=>++now}); assert.equal(stopped.valid,true); assert.equal(stopped.samples.length,2);
  const controller=new AbortController(); const aborted=await collectResources({backend,runnerPid:10,commandRunner:runner,eventLoop:{...eventLoop,disable(){}},maxSamples:3,sleep:async()=>{controller.abort();throw new Error("aborted");},signal:controller.signal,nowNs:()=>++now}); assert.equal(aborted.valid,true); assert.equal(aborted.samples.length,1);
  await assert.rejects(() => collectResources({backend,intervalMs:0,eventLoop:{...eventLoop,disable(){throw new Error("must not monitor");}}}),/intervalMs/);
  let ownedWarmups=0,ownedDisables=0,ownedCalls=0; const owned=await collectResources({backend,runnerPid:10,commandRunner:async()=>{ownedCalls++;return {stdout:"10 1 20 node\n11 2 30 pocketbase",stderr:""};},monitorFactory:()=>({percentile:()=>1e6,max:1e6,reset(){},disable(){ownedDisables++;}}),warmupSleep:async()=>{ownedWarmups++;},sleep:async()=>{},shouldStop:()=>ownedCalls===2,nowNs:()=>++now}); assert.equal(owned.valid,true); assert.equal(ownedWarmups,1); assert.equal(ownedDisables,1);
});

test("runner overload requires consecutive samples", () => {
  const base = (timestampMs:number,cpu:number,p99:number) => ({timestampMs, runner:{pid:1,cpuPercent:cpu,rssBytes:1}, eventLoop:{p99Ms:p99,maxMs:p99}, backend:{totalCpuPercent:null,totalRssBytes:null,processes:[]}, containers:null, containerTotals:null});
  assert.equal(evaluateRunnerOverload([base(1,99,1),base(2,1,1)],{cpuPercent:90}), null);
  assert.ok(evaluateRunnerOverload([base(1,99,1),base(2,99,1),base(3,99,1)],{cpuPercent:90}));
  assert.match(evaluateRunnerOverload([],{cpuPercent:90})!,/unavailable/);
  assert.equal(evaluateRunnerOverload([base(1,90,1),base(2,90,1),base(3,90,1)],{cpuPercent:90}),null);
  assert.match(evaluateRunnerOverload([base(1,99,1),base(1,99,1)],{cpuPercent:90})!,/timestamp/);
  assert.match(evaluateRunnerOverload([base(1,null as unknown as number,1),base(2,null as unknown as number,1),base(3,null as unknown as number,1)],{cpuPercent:90})!,/unavailable/);
});
