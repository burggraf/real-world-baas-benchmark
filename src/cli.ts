import { pathToFileURL } from "node:url";
import { basename, resolve } from "node:path";
import { loadBackend } from "./backend.js";
import { loadConfig } from "./config.js";
import { runCorrectness } from "./correctness.js";
import { runBenchmark } from "./run.js";
import { profileMetadata } from "./seed.js";

export type ParsedArgs = { command: string; [option: string]: string };
const commands = new Set(["doctor", "up", "reset", "correctness", "run", "compare", "down", "report"]);
export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...options] = argv;
  if (!command || command.startsWith("--") || !commands.has(command)) throw new Error("Unknown or missing command");
  const parsed: ParsedArgs = { command }; const names = new Set(["command"]);
  for (let i = 0; i < options.length; i += 2) {
    const option = options[i]; if (!option?.startsWith("--") || option.length === 2) throw new Error(`Expected an option, received ${option ?? "nothing"}`);
    const name = option.slice(2); if (names.has(name)) throw new Error(`Duplicate option: ${option}`);
    const value = options[i + 1]; if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
    names.add(name); parsed[name] = value;
  }
  return parsed;
}
const help = `Usage: npm run bench -- <command> [options]\n\nCommands:\n  doctor\n  up\n  reset\n  correctness\n  run\n  compare\n  down\n  report\n`;
const required = (args: ParsedArgs, name: string): string => { const value = args[name]; if (!value) throw new Error(`Missing --${name}`); return value; };
const configPath = (value: string): string => { if (value.includes("\0") || value.includes("..")) throw new Error("Unsafe config path"); return resolve(value); };

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help")) { console.log(help); return 0; }
  try {
    if (argv.length === 0) { console.error(help); return 1; }
    const args = parseArgs(argv); if (args.command === "report") throw new Error("report is not supported until Task14");
    if (args.command === "down") throw new Error("down requires an owned lifecycle handle; no unrelated process was stopped");
    if (args.command === "doctor") {
      const names = args.backend ? [args.backend] : ["pocketbase", "supabase", "trailbase"];
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
        await backend.start(); await backend.reset(); await backend.seed({ name: dataset, definition: { ...profileMetadata[dataset] } }, seed);
        if (args.command === "correctness") {
          if (!backend.seedCorrectnessFixture) throw new Error("backend correctness fixture unavailable");
          const check = await runCorrectness(backend, await backend.seedCorrectnessFixture());
          if (check.aborted || check.findings.some(f => !f.passed)) throw new Error("correctness checks failed");
          console.log("correctness passed");
        } else console.log("reset complete");
      } finally { await backend.stop(); }
      return 0;
    }
    if (args.command === "up") {
      const backend = await loadBackend(backendName); await backend.start(); let stopping: Promise<void> | undefined;
      const stop = () => stopping ??= backend.stop().catch(error => { process.exitCode = 1; throw error; });
      const onSignal = () => { void stop().catch(() => undefined); };
      process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal); console.log(`${backendName} started`);
      try { await new Promise<void>(resolve => { const done = () => resolve(); stopping?.then(done, done); }); }
      finally { process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal); await stop().catch(() => undefined); }
      return process.exitCode === 1 ? 1 : 0;
    }
    if (args.command === "run") { const config = loadConfig(configPath(required(args, "config"))); const path = args.result ?? `results/${basename(configPath(required(args, "config")), ".json")}-${backendName}.json`; const output = await runBenchmark({ backend: backendName, config, resultPath: path }); console.log(`${output.resultPath} ${output.result.valid ? "valid" : "invalid"}`); return output.result.valid ? 0 : 1; }
    if (args.command === "compare") { const config = loadConfig(configPath(required(args, "config"))); const names = (args.backends ?? args.backend ?? "pocketbase,supabase,trailbase").split(","); for (const name of names) { const selected = name.trim(); if (!selected) throw new Error("invalid backend"); const output = await runBenchmark({ backend: selected, config, resultPath: `results/${config.name}-${selected}.json` }); if (!output.result.valid) return 1; } return 0; }
    throw new Error("Unsupported command");
  } catch (error) { console.error(error instanceof Error ? error.message.replace(/\b(password|secret|token)\b[^\n]*/gi, "$1=[REDACTED]") : "command failed"); return 1; }
}
const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) void main(process.argv.slice(2)).then(code => { process.exitCode = code; });
