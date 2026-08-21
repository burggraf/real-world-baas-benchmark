import { BenchmarkOperationError } from "./correctness.js";
import type { FindingClassification } from "./result.js";

export interface SafeErrorDetails {
  name: string;
  message: string;
  code?: string;
  classification?: FindingClassification;
  status?: number;
}

const classifications = new Set<FindingClassification>(["authentication", "authorization", "timeout", "transport/sdk", "invalid_response", "application", "backend_health"]);
const safeCode = /^[A-Za-z0-9_-]{1,40}$/;
const sessionStateCodes = new Set(["signed_out", "invalid_session", "session_missing"]);

export function safeErrorDetails(error: unknown): SafeErrorDetails {
  const rawMessage = error instanceof Error ? error.message : error === null ? "null" : typeof error === "object" ? "object" : String(error);
  const details: SafeErrorDetails = {
    name: (error instanceof Error ? error.name : typeof error).slice(0, 100),
    message: rawMessage.slice(0, 500),
  };
  if (!(error instanceof BenchmarkOperationError)) return details;
  if (classifications.has(error.classification)) details.classification = error.classification;
  if (error.code && safeCode.test(error.code)) details.code = error.code;
  const status = error.status;
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) details.status = status;
  return details;
}

export function isScoredMeasuredError(error: unknown): boolean {
  return error instanceof BenchmarkOperationError && error.classification !== "invalid_response";
}

export function isSessionLossError(error: unknown, workflow?: string): boolean {
  return workflow === "signOutIn" || (error instanceof BenchmarkOperationError && (error.status === 401 || (error.code !== undefined && sessionStateCodes.has(error.code))));
}

export function isIntegrityError(error: unknown): boolean {
  return !isScoredMeasuredError(error);
}
