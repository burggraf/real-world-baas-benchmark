import type { AppSession } from "./backend.js";
import type { BenchmarkConfig, OperationClass, WorkflowName } from "./config.js";
import type { Comment, Dashboard, Page, Task, TaskDetail, User } from "./domain.js";

export type JourneyName = Exclude<WorkflowName, "signIn"> | "signOutIn";
export type SampleKind = "read" | "write";
export interface WorkloadSample {
  type: "workflow" | "sdk";
  name: string;
  workflow: JourneyName;
  kind: SampleKind;
  operationClass: OperationClass;
  elapsedMs: number;
  success: boolean;
  error?: { name: string; message: string; code?: string; classification?: string };
}
export interface WorkflowContext {
  session: AppSession;
  workflow: JourneyName;
  replaceSession: () => Promise<void>;
  organizationId: string;
  projectId: string;
  taskId: string;
  commentId?: string;
  random: () => number;
  pageSize: () => number;
  now: () => number;
  invoke<T>(operation: string, operationClass: OperationClass, kind: SampleKind, action: () => Promise<T>): Promise<T>;
  sample(sample: WorkloadSample): void;
}

export const MAX_PAGE_SIZE = 100;
export const configuredWorkflowNames = ["dashboard", "taskList", "taskDetail", "createTask", "updateTask", "addComment", "search", "profileUpdate", "signIn"] as const;
export const workflowOperationClass: Readonly<Record<WorkflowName | "signOutIn", OperationClass>> = {
  dashboard: "read", taskList: "read", taskDetail: "read", createTask: "write", updateTask: "write",
  addComment: "write", search: "authSearch", profileUpdate: "write", signIn: "authSearch", signOutIn: "authSearch",
};
export const operationClassForWorkflow = (workflow: WorkflowName | "signOutIn"): OperationClass => workflowOperationClass[workflow];
export const workflowKindForWorkflow = (workflow: WorkflowName | "signOutIn"): SampleKind => workflow === "profileUpdate" || workflow === "createTask" || workflow === "updateTask" || workflow === "addComment" ? "write" : "read";

/** Cumulative selection uses configured percentage weights, with 1.0 included in the final bucket. */
export function selectWorkflow(weights: BenchmarkConfig["weights"], random: () => number): WorkflowName {
  const names = configuredWorkflowNames;
  let total = 0;
  for (const name of names) {
    const weight = weights[name];
    if (!Number.isFinite(weight) || weight < 0) throw new Error(`Invalid workflow weight: ${name}`);
    total += weight;
  }
  if (total !== 100) throw new Error("Workflow weights must total 100");
  const value = Math.min(0.9999999999999999, Math.max(0, random())) * total;
  let cumulative = 0;
  for (const name of names) {
    cumulative += weights[name];
    if (value < cumulative) return name;
  }
  return names[names.length - 1]!;
}

const errorData = (error: unknown): { name: string; message: string } => ({
  name: error instanceof Error ? error.name : typeof error,
  message: error instanceof Error ? error.message : String(error),
});
const nonempty = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${label}`);
  return value;
};
const id = (value: unknown, label: string): string => nonempty(value, label);
const page = <T extends object>(value: Page<T>, label: string): Page<T> => {
  if (!value || !Number.isSafeInteger(value.page) || value.page < 0 || !Number.isSafeInteger(value.pageSize) || value.pageSize < 1 || value.pageSize > MAX_PAGE_SIZE || !Array.isArray(value.items) || value.items.length > value.pageSize || !Number.isSafeInteger(value.total) || value.total < 0 || typeof value.hasNext !== "boolean") throw new Error(`Invalid ${label} page`);
  if (value.items.some(item => !item || typeof item !== "object")) throw new Error(`Invalid ${label} items`);
  const expectedHasNext = value.total > 0 && value.page < Math.floor((value.total - 1) / value.pageSize);
  if (value.items.length > value.total || value.hasNext !== expectedHasNext) throw new Error(`Inconsistent ${label} page metadata`);
  return value;
};
const requiredUser = (value: User | null | undefined, label: string): User => {
  if (value === null || value === undefined) throw new Error(`Invalid ${label}`);
  id(value.id, `${label} id`);
  nonempty(value.email, `${label} email`);
  nonempty(value.displayName, `${label} display name`);
  nonempty(value.createdAt, `${label} createdAt`);
  nonempty(value.updatedAt, `${label} updatedAt`);
  return value;
};
const nullableUser = (value: User | null | undefined, label: string): User | null => value === null ? null : requiredUser(value, label);
const task = (value: Task, context: WorkflowContext): Task => {
  id(value?.id, "task id");
  if (value.projectId !== context.projectId) throw new Error("Task crossed project boundary");
  id(value.creatorId, "task creator id");
  if (value.assigneeId !== null) id(value.assigneeId, "task assignee id");
  nonempty(value.title, "task title");
  nonempty(value.description, "task description");
  if (!["todo", "in_progress", "done", "cancelled"].includes(value.status)) throw new Error("Invalid task status");
  if (!["low", "medium", "high", "urgent"].includes(value.priority)) throw new Error("Invalid task priority");
  if (value.dueDate !== null) nonempty(value.dueDate, "task dueDate");
  nonempty(value.createdAt, "task createdAt");
  nonempty(value.updatedAt, "task updatedAt");
  return value;
};
const comment = (value: Comment, context: WorkflowContext): Comment => {
  id(value?.id, "comment id");
  if (value.taskId !== context.taskId) throw new Error("Comment crossed task boundary");
  id(value.authorId, "comment author id");
  nonempty(value.body, "comment body");
  nonempty(value.createdAt, "comment createdAt");
  nonempty(value.updatedAt, "comment updatedAt");
  return value;
};
const detail = (value: TaskDetail, context: WorkflowContext): TaskDetail => {
  task(value.task, context);
  requiredUser(value.creator, "creator");
  nullableUser(value.assignee, "assignee");
  page(value.comments, "comments");
  for (const item of value.comments.items) {
    comment(item as Comment, context);
  }
  return value;
};
const randomPage = (context: WorkflowContext): { page: number; pageSize: number } => ({ page: 0, pageSize: context.pageSize() });

async function dashboard(context: WorkflowContext): Promise<void> {
  await context.invoke<Dashboard>("dashboard", "read", "read", async () => {
    const value = await context.session.dashboard({ organizationId: context.organizationId, projectId: context.projectId, activityPage: randomPage(context) });
    id(value.organization?.id, "organization id");
    if (value.organization.id !== context.organizationId || !Array.isArray(value.projects)) throw new Error("Invalid dashboard tenant context");
    for (const project of value.projects) {
      id(project.id, "dashboard project id");
      if (project.organizationId !== context.organizationId) throw new Error("Dashboard project crossed tenant boundary");
    }
    return value;
  });
}
async function taskList(context: WorkflowContext): Promise<void> {
  const result = await context.invoke("listTasks", "read", "read", async () => {
    const value = await context.session.listTasks({ ...randomPage(context), organizationId: context.organizationId, projectId: context.projectId });
    const result = page(value, "task");
    for (const item of result.items) task(item, context);
    return result;
  });
  if (result.items[0]) context.taskId = result.items[0].id;
}
async function taskDetail(context: WorkflowContext): Promise<void> {
  const value = await context.invoke("getTask", "read", "read", async () => {
    const value = await context.session.getTask({ organizationId: context.organizationId, projectId: context.projectId, taskId: context.taskId, comments: randomPage(context) });
    detail(value, context);
    return value;
  });
  if (value.comments.items[0]) context.commentId = value.comments.items[0]!.id;
}
async function createTask(context: WorkflowContext): Promise<void> {
  const value = await context.invoke("createTask", "write", "write", async () => {
    const value = await context.session.createTask({ organizationId: context.organizationId, projectId: context.projectId, title: `workload task ${Math.floor(context.random() * 1_000_000)}`, description: "deterministic workload task", priority: "medium" });
    task(value, context);
    return value;
  });
  context.taskId = value.id;
}
async function updateTask(context: WorkflowContext): Promise<void> {
  const value = await context.invoke("updateTask", "write", "write", async () => {
    const value = await context.session.updateTask({ organizationId: context.organizationId, projectId: context.projectId, taskId: context.taskId, title: `updated workload task ${Math.floor(context.random() * 1_000_000)}` });
    task(value, context);
    return value;
  });
  context.taskId = value.id;
}
async function addComment(context: WorkflowContext): Promise<void> {
  const value = await context.invoke("addComment", "write", "write", async () => {
    const value = await context.session.addComment({ organizationId: context.organizationId, projectId: context.projectId, taskId: context.taskId, body: `deterministic workload comment ${Math.floor(context.random() * 1_000_000)}` });
    comment(value, context);
    return value;
  });
  context.commentId = value.id;
}
async function search(context: WorkflowContext): Promise<void> {
  await context.invoke("searchTasks", "authSearch", "read", async () => {
    const value = await context.session.searchTasks({ ...randomPage(context), organizationId: context.organizationId, projectId: context.projectId, query: "workload" });
    const result = page(value, "search");
    for (const item of result.items) task(item, context);
    return result;
  });
}
async function profileUpdate(context: WorkflowContext): Promise<void> {
  await context.invoke<User>("updateProfile", "write", "write", async () => {
    const value = await context.session.updateProfile({ displayName: `Workload user ${Math.floor(context.random() * 1_000_000)}` });
    return requiredUser(value, "profile");
  });
}

export async function runSignOutIn(context: WorkflowContext): Promise<void> {
  await context.invoke("signOut", "authSearch", "read", () => context.session.signOut());
  await context.replaceSession();
  await context.invoke<User>("getProfile", "authSearch", "read", async () => requiredUser(await context.session.getProfile(), "signed-in profile"));
}

const implementations: Record<Exclude<JourneyName, "signOutIn">, (context: WorkflowContext) => Promise<void>> = {
  dashboard, taskList, taskDetail, createTask, updateTask, addComment, search, profileUpdate,
};

export async function runWorkflow(name: WorkflowName | "signOutIn", context: WorkflowContext): Promise<void> {
  const workflow = name === "signIn" ? "signOutIn" : name;
  context.workflow = workflow;
  const started = context.now();
  try {
    await (workflow === "signOutIn" ? runSignOutIn(context) : implementations[workflow](context));
    context.sample({ type: "workflow", name: workflow, workflow, kind: workflowKindForWorkflow(workflow), operationClass: operationClassForWorkflow(name), elapsedMs: Math.max(0, context.now() - started), success: true });
  } catch (error) {
    context.sample({ type: "workflow", name: workflow, workflow, kind: workflowKindForWorkflow(workflow), operationClass: operationClassForWorkflow(name), elapsedMs: Math.max(0, context.now() - started), success: false, error: errorData(error) });
    throw error;
  }
}
