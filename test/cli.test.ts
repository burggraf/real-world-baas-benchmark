import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseArgs } from "../src/cli.js";

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
