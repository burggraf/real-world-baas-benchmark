type SettledValues<T extends readonly unknown[]> = { -readonly [P in keyof T]: Awaited<T[P]> };

export async function allSettledValues<T extends readonly unknown[]>(values: T): Promise<SettledValues<T>> {
  const settled = await Promise.allSettled(values);
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
  return settled.map(result => (result as PromiseFulfilledResult<unknown>).value) as SettledValues<T>;
}
