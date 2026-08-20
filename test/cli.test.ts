import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import test from "node:test";
import { holdBackendUntilSignal, parseArgs, resolveResultPath } from "../src/cli.js";
import { safeErrorMessage } from "../src/run.js";

test("parses a command and options", () => {
  assert.deepEqual(parseArgs(["doctor", "--backend", "pocketbase"]), {
    command: "doctor",
    backend: "pocketbase",
  });
});

test("rejects an option without a value", () => {
  assert.throws(() => parseArgs(["run", "--config"]), /missing value.*--config/i);
});

test("rejects duplicate options", () => {
  assert.throws(
    () => parseArgs(["reset", "--seed", "1", "--seed", "2"]),
    /duplicate option.*--seed/i,
  );
});

test("reserves the command name", () => {
  assert.throws(
    () => parseArgs(["run", "--command", "changed"]),
    /duplicate option.*--command/i,
  );
});

test("rejects duplicate __proto__ options", () => {
  assert.throws(
    () => parseArgs(["reset", "--__proto__", "1", "--__proto__", "2"]),
    /duplicate option.*--__proto__/i,
  );
});

test("help lists every command and exits successfully", () => {
  const result = spawnSync(process.execPath, ["dist/src/cli.js", "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  for (const command of [
    "doctor",
    "up",
    "reset",
    "correctness",
    "run",
    "compare",
    "down",
    "report",
  ]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
});

test("a missing command prints help and exits nonzero", () => {
  const result = spawnSync(process.execPath, ["dist/src/cli.js"], {
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage:/i);
});

test("rejects options not allowed by the selected command", () => {
  assert.throws(() => parseArgs(["doctor", "--config", "configs/quick.json"]), /unknown option.*--config/i);
  assert.throws(() => parseArgs(["run", "--dataset", "small"]), /unknown option.*--dataset/i);
  assert.throws(() => parseArgs(["compare", "--result", "results/x.json"]), /unknown option.*--result/i);
});

test("compare backend lists reject empty and duplicate names", () => {
  assert.throws(() => parseArgs(["compare", "--backends", "pocketbase,,supabase"]), /invalid backend list/i);
  assert.throws(() => parseArgs(["compare", "--backends", "pocketbase,pocketbase"]), /duplicate backend/i);
  assert.throws(() => parseArgs(["compare", "--backend", "pocketbase", "--backends", "supabase"]), /cannot combine/i);
});

test("result paths stay below results and name a JSON file", () => {
  assert.equal(resolveResultPath("results/nested/run.json"), resolve("results/nested/run.json"));
  for (const path of ["results", "results/run.txt", "../run.json", "/tmp/run.json", "result.json", "results/../run.json"]) {
    assert.throws(() => resolveResultPath(path), /result path/i);
  }
});

test("foreground lifecycle stops once and removes signal listeners", async () => {
  const signals = new EventEmitter(); let stops = 0;
  const pending = holdBackendUntilSignal({ stop: async () => { stops++; } }, signals);
  signals.emit("SIGINT"); signals.emit("SIGTERM");
  assert.equal(await pending, 0); assert.equal(stops, 1);
  assert.equal(signals.listenerCount("SIGINT"), 0); assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("foreground lifecycle returns nonzero when stop fails", async () => {
  const signals = new EventEmitter();
  const pending = holdBackendUntilSignal({ stop: async () => { throw new Error("stop failed"); } }, signals);
  signals.emit("SIGTERM");
  assert.equal(await pending, 1);
  assert.equal(signals.listenerCount("SIGINT"), 0); assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("CLI error redaction is bounded and covers credential forms", () => {
  const raw = "Authorization='Basic abc' password=hunter2 token=abc.def.ghi https://x.test/?api_key=sekret&ok=1 Bearer xyz";
  const safe = safeErrorMessage(new Error(raw));
  assert.ok(safe.length <= 300); assert.doesNotMatch(safe, /abc|hunter2|sekret|xyz/); assert.match(safe, /REDACTED/);
  const quoted = safeErrorMessage(new Error('{"authorization":"Bearer quoted-auth","password":"quoted-pass","access_key":"quoted-key"}'));
  assert.doesNotMatch(quoted, /quoted-auth|quoted-pass|quoted-key/);
  assert.equal(safeErrorMessage({ password: "object-secret" }), "command failed");
});
