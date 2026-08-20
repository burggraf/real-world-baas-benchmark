import { pathToFileURL } from "node:url";
import { basename, resolve } from "node:path";
import { loadBackend } from "./backend.js";
import { loadConfig } from "./config.js";
import { runCorrectness } from "./correctness.js";
import { runBenchmark } from "./run.js";

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
    const args = parseArgs(argv); if (args.command === "report") throw new Error("report is not supported until Task14");
    if (args.command === "down" || args.command === "up") throw new Error(`${args.command} requires an owned lifecycle handle; run reset/run instead`);
    if (args.command === "doctor") { const info = await (await loadBackend(required(args, "backend"))).doctor(); console.log(`${info.name} ${info.version}`); return 0; }
    const backendName = required(args, "backend");
    if (args.command === "reset" || args.command === "correctness") {
      const backend = await loadBackend(backendName); try { await backend.start(); await backend.reset(); await backend.seed(loadConfig(configPath(required(args, "config"))) as any, 0); if (args.command === "correctness") console.log("correctness setup complete"); else console.log("reset complete"); } finally { await backend.stop(); } return 0;
    }
    if (args.command === "run") { const config = loadConfig(configPath(required(args, "config"))); const path = args.result ?? `results/${basename(configPath(required(args, "config")), ".json")}-${backendName}.json`; const output = await runBenchmark({ backend: backendName, config, resultPath: path }); console.log(`${output.resultPath} ${output.result.valid ? "valid" : "invalid"}`); return 0; }
    if (args.command === "compare") { const config = loadConfig(configPath(required(args, "config"))); for (const backend of (args.backends ?? backendName).split(",")) await runBenchmark({ backend: backend.trim(), config, resultPath: `results/${config.name}-${backend.trim()}.json` }); return 0; }
    throw new Error("Unsupported command");
  } catch (error) { console.error(error instanceof Error ? error.message.replace(/\b(password|secret|token)\b[^\n]*/gi, "$1=[REDACTED]") : "command failed"); return 1; }
}
const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) void main(process.argv.slice(2)).then(code => { process.exitCode = code; });
