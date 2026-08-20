import test from "node:test";
import assert from "node:assert/strict";
import { parseByteUnit, parseDockerStats, parsePs, parseSysctl, evaluateRunnerOverload } from "../src/system.js";

test("system parsers reject malformed values and parse units", () => {
  assert.equal(parseByteUnit("1.5 GiB"), 1610612736);
  assert.equal(parseByteUnit("2 MB"), 2000000);
  assert.equal(parseByteUnit("nope"), null);
  assert.deepEqual(parseSysctl("hw.cpufrequency: 2400000000\nhw.logicalcpu: 8\nhw.memsize: 17179869184"), { model: null, logicalCores: 8, memoryBytes: 17179869184 });
  assert.deepEqual(parsePs("123 4.5 10m\n bad x -1\n"), [{ pid: 123, cpuPercent: 4.5, rssBytes: 10485760 }]);
  assert.deepEqual(parseDockerStats('{"ID":"abc123","CPUPerc":"2.5%","MemUsage":"1.5GiB / 4GiB","BlockIO":"2MB / 3.5 MiB"}'), [{containerId:"abc123", cpuPercent:2.5, memoryBytes:1610612736, blockReadBytes:2000000, blockWriteBytes:3670016}]);
});

test("runner overload requires consecutive samples", () => {
  const base = (cpu:number,p99:number) => ({timestampNs:1, runner:{cpuPercent:cpu,rssBytes:1}, eventLoop:{p99Ms:p99,maxMs:p99}, backend:{}} as any);
  assert.equal(evaluateRunnerOverload([base(99,1),base(1,1)],{cpuPercent:90}), null);
  assert.ok(evaluateRunnerOverload([base(99,1),base(99,1),base(99,1)],{cpuPercent:90}));
});
