import { pathToFileURL } from "node:url";

export type ParsedArgs = {
  command: string;
  [option: string]: string;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...options] = argv;
  if (!command || command.startsWith("--")) {
    throw new Error("Missing command");
  }

  const parsed: ParsedArgs = { command };
  const optionNames = new Set<string>(["command"]);
  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    if (!option?.startsWith("--") || option.length === 2) {
      throw new Error(`Expected an option, received ${option ?? "nothing"}`);
    }
    const optionName = option.slice(2);
    if (optionNames.has(optionName)) {
      throw new Error(`Duplicate option: ${option}`);
    }

    const value = options[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${option}`);
    }
    optionNames.add(optionName);
    Object.defineProperty(parsed, optionName, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return parsed;
}

const help = `Usage: npm run bench -- <command> [options]

Commands:
  doctor
  up
  reset
  correctness
  run
  compare
  down
  report
`;

function main(argv: string[]): number {
  if (argv.includes("--help")) {
    console.log(help);
    return 0;
  }
  if (argv.length === 0) {
    console.error(help);
    return 1;
  }

  try {
    parseArgs(argv);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = main(process.argv.slice(2));
}
