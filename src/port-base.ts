export function parsePortBase(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("Port base must be an integer from 1024 through 65526");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65526) throw new Error("Port base must be an integer from 1024 through 65526");
  return port;
}
