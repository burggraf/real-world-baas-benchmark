import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { defaultResultPath, executeCompareSequentially, holdBackendUntilSignal, main, parseArgs, resolveReportInputPath, resolveResultPath } from "../src/cli.js";
import { safeErrorMessage } from "../src/run.js";

test("parses a command and options", () => {
  assert.deepEqual(parseArgs(["doctor", "--backend", "pocketbase"]), {
    command: "doctor",
    backend: "pocketbase",
  });
});

test("parses and bounds the shared backend port base", () => {
  for (const command of ["doctor", "up", "reset", "correctness", "run", "compare"]) {
    assert.equal(parseArgs([command, "--port-base", "18000"]).portBase, 18000);
  }
  for (const value of ["1023", "65527", "1.5", "nope"]) assert.throws(() => parseArgs(["doctor", "--port-base", value]), /port base/i);
  assert.throws(() => parseArgs(["doctor", "--port-base"]), /missing value/i);
  assert.throws(() => parseArgs(["doctor", "--port-base", "18000", "--port-base", "18001"]), /duplicate option/i);
  assert.throws(() => parseArgs(["report", "--port-base", "18000"]), /positional/i);
  assert.throws(() => parseArgs(["down", "--port-base", "18000"]), /unknown option/i);
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

test("parses confirm-large as a valueless flag only on destructive or benchmark commands", () => {
  for (const command of ["reset", "correctness", "run", "compare"]) {
    assert.equal(parseArgs([command, "--confirm-large"]).confirmLarge, true);
    assert.throws(() => parseArgs([command, "--confirm-large", "true"]), /expected an option/i);
    assert.throws(() => parseArgs([command, "--confirm-large", "--confirm-large"]), /duplicate option/i);
  }
  for (const command of ["doctor", "up", "down"]) assert.throws(() => parseArgs([command, "--confirm-large"]), /unknown option/i);
  assert.throws(() => parseArgs(["report", "--confirm-large"]), /positional/i);
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

test("result paths stay below non-symlink results and name a JSON file", async () => {
  assert.equal(resolveResultPath("results/nested/run.json"), resolve("results/nested/run.json"));
  for (const path of ["results", "results/run.txt", "../run.json", "/tmp/run.json", "result.json", "results/../run.json"]) {
    assert.throws(() => resolveResultPath(path), /result path/i);
  }
  const root = await mkdtemp(join(tmpdir(), "bench-cli-result-link-")); const outside = await mkdtemp(join(tmpdir(), "bench-cli-result-outside-")); await symlink(outside, join(root, "results"));
  assert.throws(() => resolveResultPath("results/run.json", root), /result path/i);
});

test("report accepts exactly one positional JSON path and no option syntax", () => {
  assert.deepEqual(parseArgs(["report", "results/run.json"]), { command: "report", input: "results/run.json" });
  for (const argv of [["report"], ["report", "a.json", "b.json"], ["report", "--input", "a.json"]]) assert.throws(() => parseArgs(argv), /exactly one positional/i);
});

test("report input resolution rejects absolute, traversal, NUL, non-JSON, outside, and symlink paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "bench-cli-report-"));
  await mkdir(join(root, "results")); await writeFile(join(root, "results", "run.json"), "{}\n");
  assert.equal(await resolveReportInputPath("results/run.json", root), join(root, "results", "run.json"));
  for (const path of [join(root, "results", "run.json"), "../run.json", "results/../run.json", "results/run.json\0tail", "results/run.txt"]) await assert.rejects(resolveReportInputPath(path, root), /report input path/i);
  await writeFile(join(root, "outside.json"), "{}\n"); await symlink(join(root, "outside.json"), join(root, "results", "link.json"));
  await assert.rejects(resolveReportInputPath("results/link.json", root), /symlink|report input path/i);
  await mkdir(join(root, "real")); await writeFile(join(root, "real", "nested.json"), "{}\n"); await symlink(join(root, "real"), join(root, "linked"));
  await assert.rejects(resolveReportInputPath("linked/nested.json", root), /symlink|report input path/i);
});

test("default result paths include UTC milliseconds and sanitized config/backend names", () => {
  assert.equal(defaultResultPath("full config", "pocket/base", new Date("2026-01-02T03:04:05.006Z")), "results/2026-01-02T03-04-05-006Z-full-config-pocket-base.json");
});

test("compare execution is strictly sequential, propagates large confirmation, and continues after invalid and thrown runs", async () => {
  const targets = ["pocketbase", "supabase", "trailbase"].map(backend => ({ backend, resultPath: `results/${backend}.json` }));
  let active = 0; let maxActive = 0; const started: string[] = []; const confirmations: boolean[] = [];
  const outcomes = await executeCompareSequentially(targets, async (target, confirmLarge) => {
    confirmations.push(confirmLarge); started.push(target.backend); active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 5)); active--;
    if (target.backend === "supabase") throw new Error("Authorization: Bearer compare.secret.token password=unsafe");
    return { result: { valid: target.backend !== "pocketbase" }, resultPath: target.resultPath };
  }, true);
  assert.deepEqual(started, ["pocketbase", "supabase", "trailbase"]); assert.equal(maxActive, 1);
  assert.deepEqual(confirmations, [true, true, true]);
  assert.deepEqual(outcomes.map(outcome => outcome.status), ["invalid", "failed", "valid"]);
  assert.deepEqual(outcomes.map(outcome => outcome.resultPath), targets.map(target => target.resultPath));
  assert.doesNotMatch(outcomes[1]!.error ?? "", /unsafe|compare\.secret\.token/);
});

test("report CLI creates reports, rejects overwrite, and prints only safe relative paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "bench-cli-main-report-")); const input = join(root, "result.json");
  await copyFile(new URL("../../test/fixtures/result-pass.json", import.meta.url), input);
  const cli = resolve("dist/src/cli.js"); const first = spawnSync(process.execPath, [cli, "report", "result.json"], { cwd: root, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, /result\.md created/); assert.match(first.stdout, /result-stages\.csv created/); assert.doesNotMatch(first.stdout + first.stderr, /password|token|Bearer|\.\.[/\\]/i);
  assert.match(await readFile(join(root, "result.md"), "utf8"), /# VALID benchmark result/);
  const second = spawnSync(process.execPath, [cli, "report", "result.json"], { cwd: root, encoding: "utf8" });
  assert.notEqual(second.status, 0); assert.match(second.stderr, /already exists/i);
});

test("every effective large CLI dataset refuses without confirmation before command side effects", async () => {
  const errors: string[] = []; const original = console.error;
  console.error = (...values: unknown[]) => { errors.push(values.join(" ")); };
  try {
    for (const argv of [
      ["reset", "--backend", "pocketbase", "--dataset", "large"],
      ["correctness", "--backend", "pocketbase", "--config", resolve("configs/large.json")],
      ["run", "--backend", "pocketbase", "--config", resolve("configs/large.json")],
      ["compare", "--backend", "pocketbase", "--config", resolve("configs/large.json")],
    ]) assert.equal(await main(argv), 1);
  } finally { console.error = original; }
  assert.equal(errors.length, 4);
  assert.equal(errors.every(message => /confirm-large/i.test(message)), true);
});

test("run refuses an existing explicit result before loading a backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "bench-cli-existing-")); await mkdir(join(root, "results")); await mkdir(join(root, "configs"));
  await copyFile(resolve("configs/quick.json"), join(root, "configs", "quick.json")); await writeFile(join(root, "results", "existing.json"), "keep\n");
  const run = spawnSync(process.execPath, [resolve("dist/src/cli.js"), "run", "--backend", "pocketbase", "--config", "configs/quick.json", "--result", "results/existing.json"], { cwd: root, encoding: "utf8" });
  assert.notEqual(run.status, 0); assert.match(run.stderr, /already exists/i); assert.equal(await readFile(join(root, "results", "existing.json"), "utf8"), "keep\n");
});

test("foreground lifecycle stops once and removes signal listeners", async () => {
  const signals = new EventEmitter(); let stops = 0;
  const pending = holdBackendUntilSignal({ start: async () => {}, stop: async () => { stops++; } }, signals);
  signals.emit("SIGINT"); signals.emit("SIGTERM");
  assert.equal(await pending, 0); assert.equal(stops, 1);
  assert.equal(signals.listenerCount("SIGINT"), 0); assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("foreground lifecycle returns nonzero when stop fails", async () => {
  const signals = new EventEmitter();
  const pending = holdBackendUntilSignal({ start: async () => {}, stop: async () => { throw new Error("stop failed"); } }, signals);
  signals.emit("SIGTERM");
  assert.equal(await pending, 1);
  assert.equal(signals.listenerCount("SIGINT"), 0); assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("foreground lifecycle installs handlers before startup and cleans up on startup signal", async () => {
  const signals = new EventEmitter(); let starts = 0; let stops = 0;
  const pending = holdBackendUntilSignal({ start: async () => { starts++; signals.emit("SIGINT"); }, stop: async () => { stops++; } }, signals);
  assert.equal(await pending, 0); assert.equal(starts, 1); assert.equal(stops, 1);
  assert.equal(signals.listenerCount("SIGINT"), 0); assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("startup failure removes handlers without stopping an unacquired backend", async () => {
  const signals = new EventEmitter(); let stops = 0;
  await assert.rejects(holdBackendUntilSignal({ start: async () => { signals.emit("SIGTERM"); throw new Error("start failed"); }, stop: async () => { stops++; } }, signals), /start failed/);
  assert.equal(stops, 0); assert.equal(signals.listenerCount("SIGINT"), 0); assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("CLI error redaction is bounded and covers credential forms", () => {
  const raw = "Authorization='Basic abc' password=hunter2 token=abc.def.ghi https://x.test/?api_key=sekret&ok=1 Bearer xyz";
  const safe = safeErrorMessage(new Error(raw));
  assert.ok(safe.length <= 300); assert.doesNotMatch(safe, /abc|hunter2|sekret|xyz/); assert.match(safe, /REDACTED/);
  const quoted = safeErrorMessage(new Error('{"authorization":"Bearer quoted-auth","password":"quoted-pass","access_key":"quoted-key"}'));
  assert.doesNotMatch(quoted, /quoted-auth|quoted-pass|quoted-key/);
  assert.equal(safeErrorMessage({ password: "object-secret" }), "command failed");
});
