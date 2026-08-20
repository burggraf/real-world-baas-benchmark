import { pathToFileURL } from "node:url";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { loadBackend, type Backend } from "./backend.js";
import { loadConfig } from "./config.js";
import { runCorrectness } from "./correctness.js";
import { runBenchmark, safeErrorMessage } from "./run.js";
import { profileMetadata } from "./seed.js";

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

export function resolveResultPath(value: string): string {
  const root = resolve("results");
  if (!value || value.includes("\0") || value.split(/[\\/]/).includes("..") || isAbsolute(value) || extname(value).toLowerCase() !== ".json") throw new Error("Invalid result path");
  const candidate = resolve(value);
  const inside = relative(root, candidate);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("Invalid result path");
  return candidate;
}

export interface SignalSource { once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown; removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown; }
export async function holdBackendUntilSignal(backend: Pick<Backend, "stop">, signals: SignalSource = process): Promise<number> {
  let release!: () => void;
  const signaled = new Promise<void>(resolveSignal => { release = resolveSignal; });
  const onSignal = () => release();
  signals.once("SIGINT", onSignal);
  signals.once("SIGTERM", onSignal);
  try { await signaled; await backend.stop(); return 0; }
  catch { return 1; }
  finally { signals.removeListener("SIGINT", onSignal); signals.removeListener("SIGTERM", onSignal); }
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help")) { console.log(help); return 0; }
  try {
    if (argv.length === 0) { console.error(help); return 1; }
    const args = parseArgs(argv);
    if (args.command === "report") throw new Error("report is not supported until Task14");
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
      await backend.start();
      console.log(`${backendName} started`);
      const code = await holdBackendUntilSignal(backend);
      if (code) console.error("backend stop failed");
      return code;
    }
    if (args.command === "run") {
      const pathToConfig = configPath(required(args, "config"));
      const config = loadConfig(pathToConfig);
      const path = resolveResultPath(args.result ?? `results/${basename(pathToConfig, ".json")}-${backendName}.json`);
      const output = await runBenchmark({ backend: backendName, config, resultPath: path });
      console.log(`${output.resultPath} ${output.result.valid ? "valid" : "invalid"}`);
      return output.result.valid ? 0 : 1;
    }
    if (args.command === "compare") {
      const config = loadConfig(configPath(required(args, "config")));
      const names = (args.backends ?? args.backend ?? "pocketbase,supabase,trailbase").split(",").map(name => name.trim());
      for (const selected of names) {
        const output = await runBenchmark({ backend: selected, config, resultPath: resolveResultPath(`results/${config.name}-${selected}.json`) });
        if (!output.result.valid) return 1;
      }
      return 0;
    }
    throw new Error("Unsupported command");
  } catch (error) { console.error(safeErrorMessage(error)); return 1; }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) void main(process.argv.slice(2)).then(code => { process.exitCode = code; });
