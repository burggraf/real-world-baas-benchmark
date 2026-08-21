export interface SessionRequestController {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  signal(initSignal?: AbortSignal | null): AbortSignal;
  detachParent(): void;
  cancelPending(): void;
}

export interface SessionRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function validateSessionRequestTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? 30_000;
  if (!Number.isFinite(value) || value <= 0) throw new RangeError("timeoutMs must be a positive finite number");
  return value;
}

/** Native fetch cancellation shared by the three official SDK transports. */
export function createSessionRequestController(options: SessionRequestOptions = {}): SessionRequestController {
  const timeoutMs = validateSessionRequestTimeout(options.timeoutMs);
  let parent = options.signal;
  let current = new AbortController();

  const signal = (initSignal?: AbortSignal): AbortSignal => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signals = [current.signal, timeout];
    if (parent) signals.push(parent);
    if (initSignal) signals.push(initSignal);
    return AbortSignal.any(signals);
  };

  return {
    signal,
    async fetch(input, init = {}) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = AbortSignal.any([current.signal, timeout, ...(parent ? [parent] : []), ...(init.signal ? [init.signal] : [])]);
      try {
        return await globalThis.fetch(input, { ...init, signal: combined });
      } catch (error) {
        if (timeout.aborted) throw Object.assign(new Error("measured request timed out"), { name: "TimeoutError" });
        throw error;
      }
    },
    detachParent() { parent = undefined; },
    cancelPending() {
      current.abort();
      current = new AbortController();
    },
  };
}
