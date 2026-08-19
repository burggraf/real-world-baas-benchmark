import type { Backend, AppSession, BackendInfo } from "../../src/backend.js";
import { notImplemented } from "../../src/backend.js";
import type { Credentials, DatasetProfile } from "../../src/domain.js";

const session: AppSession = { dashboard: notImplemented, listTasks: notImplemented, getTask: notImplemented, createTask: notImplemented, updateTask: notImplemented, addComment: notImplemented, searchTasks: notImplemented, updateProfile: notImplemented, refreshSession: notImplemented, signOut: notImplemented, close: notImplemented };
export const backend: Backend = {
  name: "pocketbase", doctor: async (): Promise<BackendInfo> => notImplemented(), start: async () => notImplemented(), reset: async () => notImplemented(),
  seed: async (_profile: DatasetProfile, _seed: number) => notImplemented(), createSession: async (_credentials: Credentials) => { notImplemented(); return session; }, stop: async () => notImplemented(),
};
