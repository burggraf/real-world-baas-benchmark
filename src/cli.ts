import { pathToFileURL } from "node:url";
import { lstat, readFile, realpath } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { loadBackend, type Backend } from "./backend.js";
import { loadConfig } from "./config.js";
import { runCorrectness } from "./correctness.js";
import { runBenchmark, safeErrorMessage } from "./run.js";
import { profileMetadata } from "./seed.js";
import { validateBenchmarkResult, writeBenchmarkReport } from "./report.js";

export type ParsedArgs = { command: string; [option: string]: string };
const allowedOptions = {
  doctor: ["backend"], up: ["backend"], down: ["backend"],
  reset: ["backend", "config", "dataset", "seed"], correctness: ["backend", "config", "dataset", "seed"],
  run: ["backend", "config", "result"], compare: ["backend", "backends", "config"], report: [],
} as const;
const commands = new Set(Object.keys(allowedOptions));
const backendNames = new Set(["pocketbase", "supabase", "trailbase"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...options] = argv;
  if (!command || command.startsWith("--") || !commands.has(command)) throw new Error("Unknown or missing command");
  const parsed: ParsedArgs = { command };
  if (command === "report") {
    if (options.length !== 1 || !options[0] || options[0].startsWith("--")) throw new Error("report requires exactly one positional JSON path");
    parsed.input = options[0];
    return parsed;
  }
  const names = new Set(["command"]);
  const allowed = new Set<string>(allowedOptions[command as keyof typeof allowedOptions]);
  let unknownOption: string | undefined;
  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    if (!option?.startsWith("--") || option.length === 2) throw new Error(`Expected an option, received ${option ?? "nothing"}`);
    const name = option.slice(2);
    if (names.has(name)) throw new Error(`Duplicate option: ${option}`);
    if (!allowed.has(name)) unknownOption ??= option;
    const value = options[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
    names.add(name);
    parsed[name] = value;
  }
  if (unknownOption) throw new Error(`Unknown option for ${command}: ${unknownOption}`);
  if (parsed.backend && !backendNames.has(parsed.backend)) throw new Error(`Unknown backend: ${parsed.backend}`);
  if (command === "compare") {
    if (parsed.backend && parsed.backends) throw new Error("Cannot combine --backend and --backends");
    if (parsed.backends) {
      const selected = parsed.backends.split(",").map(name => name.trim());
      if (selected.some(name => !backendNames.has(name))) throw new Error("Invalid backend list");
      if (new Set(selected).size !== selected.length) throw new Error("Duplicate backend in list");
    }
  }
  return parsed;
}

const help = `Usage: npm run bench -- <command> [options]\n\nCommands:\n  doctor\n  up\n  reset\n  correctness\n  run\n  compare\n  down\n  report\n`;
const required = (args: ParsedArgs, name: string): string => { const value = args[name]; if (!value) throw new Error(`Missing --${name}`); return value; };
const configPath = (value: string): string => { if (value.includes("\0") || value.includes("..")) throw new Error("Unsafe config path"); return resolve(value); };

export function resolveResultPath(value: string, repository = process.cwd()): string {
  const repo = resolve(repository); const root = resolve(repo, "results");
  if (!value || value.includes("\0") || value.split(/[\\/]/).includes("..") || isAbsolute(value) || extname(value).toLowerCase() !== ".json") throw new Error("Invalid result path");
  const candidate = resolve(repo, value); const inside = relative(root, candidate);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("Invalid result path");
  let current = repo;
  try {
    for (const part of relative(repo, dirname(candidate)).split(sep).filter(Boolean)) { current = resolve(current, part); const stat = lstatSync(current); if (stat.isSymbolicLink()) throw new Error("symlink"); }
    const realRepo = realpathSync(repo); const realParent = realpathSync(dirname(candidate)); const realInside = relative(realRepo, realParent); if (realInside === ".." || realInside.startsWith(`..${sep}`) || isAbsolute(realInside)) throw new Error("outside repository");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid result path: non-symlink repository path required"); }
  return candidate;
}

const pathIsInside = (root: string, candidate: string): boolean => { const inside = relative(root, candidate); return inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside); };
export async function resolveReportInputPath(value: string, root = process.cwd()): Promise<string> {
  const repository = resolve(root);
  if (!value || value.includes("\0") || value.split(/[\\/]/).includes("..") || isAbsolute(value) || extname(value).toLowerCase() !== ".json") throw new Error("Invalid report input path");
  const candidate = resolve(repository, value); if (!pathIsInside(repository, candidate)) throw new Error("Invalid report input path");
  let current = repository;
  try {
    for (const part of relative(repository, candidate).split(sep)) { current = resolve(current, part); if ((await lstat(current)).isSymbolicLink()) throw new Error("symlink"); }
    if (!(await lstat(candidate)).isFile()) throw new Error("not a file");
    const [realRepository, realCandidate] = await Promise.all([realpath(repository), realpath(candidate)]); if (!pathIsInside(realRepository, realCandidate)) throw new Error("outside repository");
  } catch { throw new Error("Invalid report input path: regular non-symlink file required"); }
  return candidate;
}

const safeSegment = (value: string): string => value.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
export function defaultResultPath(config: string, backend: string, date = new Date()): string {
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid result timestamp");
  const timestamp = date.toISOString().replace(/[:.]/g, "-");
  return `results/${timestamp}-${safeSegment(config)}-${safeSegment(backend)}.json`;
}

async function refuseExistingResult(path: string): Promise<void> {
  try { await lstat(path); throw new Error("Result path already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export interface CompareTarget { backend: string; resultPath: string }
export interface CompareOutcome extends CompareTarget { status: "valid" | "invalid" | "failed"; error?: string }
export async function executeCompareSequentially(targets: CompareTarget[], execute: (target: CompareTarget) => Promise<{ result: { valid: boolean }; resultPath: string }>): Promise<CompareOutcome[]> {
  const outcomes: CompareOutcome[] = [];
  for (const target of targets) {
    try { const output = await execute(target); outcomes.push({ ...target, resultPath: output.resultPath, status: output.result.valid ? "valid" : "invalid" }); }
    catch (error) { outcomes.push({ ...target, status: "failed", error: safeErrorMessage(error) }); }
  }
  return outcomes;
}

export interface SignalSource { once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown; removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown; }
export async function holdBackendUntilSignal(backend: Pick<Backend, "start" | "stop">, signals: SignalSource = process, onStarted?: () => void): Promise<number> {
  let release!: () => void;
  let signalReceived = false;
  let started = false;
  let stopError: unknown;
  let stopping: Promise<void> | undefined;
  const signaled = new Promise<void>(resolveSignal => { release = resolveSignal; });
  const stopOnce = (): Promise<void> => stopping ??= Promise.resolve().then(() => backend.stop()).catch(error => { stopError = error; });
  const onSignal = () => { signalReceived = true; if (started) release(); };
  signals.once("SIGINT", onSignal);
  signals.once("SIGTERM", onSignal);
  try {
    await backend.start();
    started = true;
    onStarted?.();
    if (signalReceived) release();
    await signaled;
    await stopOnce();
    return stopError === undefined ? 0 : 1;
  } finally {
    signals.removeListener("SIGINT", onSignal);
    signals.removeListener("SIGTERM", onSignal);
  }
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help")) { console.log(help); return 0; }
  try {
    if (argv.length === 0) { console.error(help); return 1; }
    const args = parseArgs(argv);
    if (args.command === "report") {
      const inputPath = await resolveReportInputPath(args.input!); let result: unknown;
      try { result = JSON.parse(await readFile(inputPath, "utf8")); } catch { throw new Error("Invalid result JSON"); }
      validateBenchmarkResult(result); const written = await writeBenchmarkReport(result, inputPath);
      console.log(`${safeErrorMessage(new Error(relative(process.cwd(), written.markdownPath)))} created`);
      console.log(`${safeErrorMessage(new Error(relative(process.cwd(), written.csvPath)))} created`);
      return 0;
    }
    if (args.command === "down") throw new Error("down requires an owned lifecycle handle; no unrelated process was stopped");
    if (args.command === "doctor") {
      const names = args.backend ? [args.backend] : [...backendNames];
      for (const name of names) { const info = await (await loadBackend(name)).doctor(); console.log(`${info.name} ${info.version}`); }
      return 0;
    }
    const backendName = args.backend ?? (args.command === "compare" ? "" : required(args, "backend"));
    if (args.command === "reset" || args.command === "correctness") {
      const config = args.config ? loadConfig(configPath(args.config)) : undefined;
      const dataset = (args.dataset ?? config?.dataset ?? "small") as keyof typeof profileMetadata;
      const seed = args.seed === undefined ? (config?.seed ?? 0) : Number(args.seed);
      if (!Object.hasOwn(profileMetadata, dataset) || !Number.isSafeInteger(seed) || seed < 0) throw new Error("invalid dataset or seed");
      const backend = await loadBackend(backendName);
      try {
        await backend.start();
        await backend.reset();
        await backend.seed({ name: dataset, definition: { ...profileMetadata[dataset] } }, seed);
        if (args.command === "correctness") {
          if (!backend.seedCorrectnessFixture) throw new Error("backend correctness fixture unavailable");
          const check = await runCorrectness(backend, await backend.seedCorrectnessFixture());
          if (check.aborted || check.findings.some(finding => !finding.passed)) throw new Error("correctness checks failed");
          console.log("correctness passed");
        } else console.log("reset complete");
      } finally { await backend.stop(); }
      return 0;
    }
    if (args.command === "up") {
      const backend = await loadBackend(backendName);
      const code = await holdBackendUntilSignal(backend, process, () => console.log(`${backendName} started`));
      if (code) console.error("backend stop failed");
      return code;
    }
    if (args.command === "run") {
      const pathToConfig = configPath(required(args, "config"));
      const config = loadConfig(pathToConfig);
      const path = resolveResultPath(args.result ?? defaultResultPath(config.name, backendName)); await refuseExistingResult(path);
      const output = await runBenchmark({ backend: backendName, config, resultPath: path });
      console.log(`${safeErrorMessage(new Error(relative(process.cwd(), output.resultPath)))} ${output.result.valid ? "valid" : "invalid"}`);
      return output.result.valid ? 0 : 1;
    }
    if (args.command === "compare") {
      const config = loadConfig(configPath(required(args, "config")));
      const names = (args.backends ?? args.backend ?? "pocketbase,supabase,trailbase").split(",").map(name => name.trim()); const timestamp = new Date();
      const targets = names.map(backend => ({ backend, resultPath: resolveResultPath(defaultResultPath(config.name, backend, timestamp)) }));
      for (const target of targets) await refuseExistingResult(target.resultPath);
      const outcomes = await executeCompareSequentially(targets, target => runBenchmark({ backend: target.backend, config, resultPath: target.resultPath }));
      for (const outcome of outcomes) {
        console.log(`${safeErrorMessage(new Error(relative(process.cwd(), outcome.resultPath)))} ${outcome.status}`);
        if (outcome.error) console.error(`${outcome.backend} failed: ${outcome.error}`);
      }
      return outcomes.every(outcome => outcome.status === "valid") ? 0 : 1;
    }
    throw new Error("Unsupported command");
  } catch (error) { console.error(safeErrorMessage(error)); return 1; }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) void main(process.argv.slice(2)).then(code => { process.exitCode = code; });
