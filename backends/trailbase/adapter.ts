import type { Backend, AppSession, BackendInfo } from "../../src/backend.js";
import { BenchmarkOperationError } from "../../src/correctness.js";
import type { Credentials, DatasetProfile } from "../../src/domain.js";
import { trailBaseProcess, resolveTrailBaseOptions, TRAILBASE_VERSION } from "./process.js";

/** TrailBase uses SQLite integer record keys; the public boundary remains the canonical text id. */
export function mapTrailBaseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BenchmarkOperationError("invalid_response", { code: "record_shape" });
  return value as Record<string, unknown>;
}

const unsupported = async (): Promise<never> => { throw new BenchmarkOperationError("unsupported", { code: "trailbase_record_api" }); };
function session(): AppSession {
  return { dashboard: unsupported, listTasks: unsupported, getTask: unsupported, createTask: unsupported, updateTask: unsupported,
    addComment: unsupported, updateComment: unsupported, updateMembershipRole: unsupported, searchTasks: unsupported,
    getProfile: unsupported, updateProfile: unsupported, refreshSession: async () => {}, signOut: async () => {}, close: async () => {} };
}

export const backend: Backend = {
  name: "trailbase",
  doctor: async (): Promise<BackendInfo> => {
    const options = resolveTrailBaseOptions();
    return { name: "trailbase", version: TRAILBASE_VERSION, endpoint: options.endpoint,
      deviations: ["Record API integer primary keys are mapped to portable text ids at the boundary."] };
  },
  start: async () => trailBaseProcess.start(),
  reset: async () => trailBaseProcess.reset(),
  stop: async () => trailBaseProcess.stop(),
  seed: async (_profile: DatasetProfile, _seed: number) => unsupported(),
  createSession: async (_credentials: Credentials) => session(),
};
