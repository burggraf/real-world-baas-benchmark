import type { Credentials, DatasetProfile, Dashboard, DashboardInput, ListTasksInput, GetTaskInput, CreateTaskInput, UpdateTaskInput, AddCommentInput, UpdateCommentInput, UpdateMembershipRoleInput, SearchTasksInput, UpdateProfileInput, Page, Task, TaskDetail, Comment, User, Membership } from "./domain.js";

export type BackendName = "pocketbase" | "supabase" | "trailbase";
export interface BackendInfo { name: BackendName; version: string; endpoint: string; processIds?: number[]; processExecutable?: string; supabaseProjectId?: string; deviations?: string[]; }
export interface AppSession {
  dashboard(input: DashboardInput): Promise<Dashboard>; listTasks(input: ListTasksInput): Promise<Page<Task>>; getTask(input: GetTaskInput): Promise<TaskDetail>;
  createTask(input: CreateTaskInput): Promise<Task>; updateTask(input: UpdateTaskInput): Promise<Task>; addComment(input: AddCommentInput): Promise<Comment>; updateComment(input: UpdateCommentInput): Promise<Comment>; updateMembershipRole(input: UpdateMembershipRoleInput): Promise<Membership>;
  searchTasks(input: SearchTasksInput): Promise<Page<Task>>; getProfile(): Promise<User>; updateProfile(input: UpdateProfileInput): Promise<User>; refreshSession(): Promise<void>; signOut(): Promise<void>; close(): Promise<void>;
}
export interface Backend {
  readonly name: BackendName; doctor(): Promise<BackendInfo>; start(): Promise<void>; reset(): Promise<void>;
  seed(profile: DatasetProfile, seed: number): Promise<void>; createSession(credentials: Credentials): Promise<AppSession>; stop(): Promise<void>;
}
export const notImplemented = (): never => { throw new Error("NotImplemented: backend adapter is not implemented"); };

export async function loadBackend(name: BackendName | string): Promise<Backend> {
  switch (name) {
    case "pocketbase": return (await import("../backends/pocketbase/adapter.js")).backend;
    case "supabase": return (await import("../backends/supabase/adapter.js")).backend;
    case "trailbase": return (await import("../backends/trailbase/adapter.js")).backend;
    default: throw new Error(`Unknown backend: ${name}`);
  }
}
