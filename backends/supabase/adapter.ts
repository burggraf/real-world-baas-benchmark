import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Backend, AppSession, BackendInfo, SessionRequestOptions } from "../../src/backend.js";
import { createSessionRequestController, type SessionRequestController } from "../../src/session-request.js";
import { allSettledValues } from "../../src/settle.js";

import type {
  Activity, AddCommentInput, Comment, CreateTaskInput, Credentials, Dashboard, DashboardInput, DatasetProfile,
  GetTaskInput, ListTasksInput, Membership, Organization, Page, Project, SearchTasksInput, Task, TaskDetail,
  UpdateCommentInput, UpdateMembershipRoleInput, UpdateProfileInput, UpdateTaskInput, User,
} from "../../src/domain.js";
import { BenchmarkOperationError, type CorrectnessFixture } from "../../src/correctness.js";
import { datasetProfiles, entityId, seedDataset, buildSeedVirtualUserSpecs, profileExpectedCounts, type EntityName, type ProfileName, type SeedRecord } from "../../src/seed.js";
import { LOCAL_BENCHMARK_PASSWORD, SUPABASE_PROJECT_ID, supabaseProcess, type SupabaseStatus } from "./process.js";

const SEED_BATCH_SIZE = 100;
const AUTH_CONCURRENCY = 8;
const PROJECT_PAGE_SIZE = 500;
const MAX_PROJECT_PAGES = 1_000;
const BENCHMARK_EMAIL_SUFFIX = "@supabase.bench.test";
const FIELDS = {
  profile: "id,auth_id,email,display_name,created_at,updated_at",
  organization: "id,name,owner_id,created_at",
  membership: "id,organization_id,user_id,role,created_at",
  project: "id,organization_id,name,status,created_at,updated_at",
  task: "id,project_id,creator_id,assignee_id,title,description,status,priority,due_date,created_at,updated_at",
  comment: "id,task_id,author_id,body,created_at,updated_at",
  activity: "id,organization_id,project_id,actor_id,action,subject_type,subject_id,created_at",
} as const;

type Row = Record<string, unknown>;
type ResponseLike<T = unknown> = { data?: T | null; error: unknown; status?: number; count?: number | null };

function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BenchmarkOperationError("invalid_response", { code: "record_shape" });
  return value as Row;
}
function requiredString(source: Row, field: string): string {
  const value = source[field];
  if (typeof value !== "string" || !value) throw new BenchmarkOperationError("invalid_response", { code: "record_field" });
  return value;
}
function nullableString(source: Row, field: string): string | null {
  const value = source[field];
  if (value === null) return null;
  if (typeof value !== "string") throw new BenchmarkOperationError("invalid_response", { code: "record_field" });
  return value;
}
function enumString<T extends string>(source: Row, field: string, allowed: readonly T[]): T {
  const value = requiredString(source, field);
  if (!allowed.includes(value as T)) throw new BenchmarkOperationError("invalid_response", { code: "record_enum" });
  return value as T;
}

export function mapSupabaseUser(value: unknown): User {
  const source = row(value);
  return { id: requiredString(source, "id"), email: requiredString(source, "email"), displayName: requiredString(source, "display_name"), createdAt: requiredString(source, "created_at"), updatedAt: requiredString(source, "updated_at") };
}
export function mapSupabaseOrganization(value: unknown): Organization {
  const source = row(value);
  return { id: requiredString(source, "id"), name: requiredString(source, "name"), ownerId: requiredString(source, "owner_id"), createdAt: requiredString(source, "created_at") };
}
export function mapSupabaseMembership(value: unknown): Membership {
  const source = row(value);
  return { id: requiredString(source, "id"), organizationId: requiredString(source, "organization_id"), userId: requiredString(source, "user_id"), role: enumString(source, "role", ["owner", "admin", "member"]), createdAt: requiredString(source, "created_at") };
}
export function mapSupabaseProject(value: unknown): Project {
  const source = row(value);
  return { id: requiredString(source, "id"), organizationId: requiredString(source, "organization_id"), name: requiredString(source, "name"), status: requiredString(source, "status"), createdAt: requiredString(source, "created_at"), updatedAt: requiredString(source, "updated_at") };
}
export function mapSupabaseTask(value: unknown): Task {
  const source = row(value);
  return {
    id: requiredString(source, "id"), projectId: requiredString(source, "project_id"), creatorId: requiredString(source, "creator_id"), assigneeId: nullableString(source, "assignee_id"),
    title: requiredString(source, "title"), description: typeof source.description === "string" ? source.description : requiredString(source, "description"),
    status: enumString(source, "status", ["todo", "in_progress", "done", "cancelled"]), priority: enumString(source, "priority", ["low", "medium", "high", "urgent"]),
    dueDate: nullableString(source, "due_date"), createdAt: requiredString(source, "created_at"), updatedAt: requiredString(source, "updated_at"),
  };
}
export function mapSupabaseComment(value: unknown): Comment {
  const source = row(value);
  return { id: requiredString(source, "id"), taskId: requiredString(source, "task_id"), authorId: requiredString(source, "author_id"), body: requiredString(source, "body"), createdAt: requiredString(source, "created_at"), updatedAt: requiredString(source, "updated_at") };
}
export function mapSupabaseActivity(value: unknown): Activity {
  const source = row(value);
  return { id: requiredString(source, "id"), organizationId: requiredString(source, "organization_id"), projectId: nullableString(source, "project_id"), actorId: requiredString(source, "actor_id"), action: requiredString(source, "action"), subjectType: requiredString(source, "subject_type"), subjectId: requiredString(source, "subject_id"), createdAt: requiredString(source, "created_at") };
}
export function mapSupabasePage<T>(items: T[], page: number, pageSize: number, total: number): Page<T> {
  if (!Array.isArray(items)) throw new BenchmarkOperationError("invalid_response", { code: "record_list" });
  if (!Number.isInteger(total) || total < 0) throw new BenchmarkOperationError("invalid_response", { code: "page_count" });
  return { items, page, pageSize, total, hasNext: (page + 1) * pageSize < total };
}

export function normalizeSupabaseError(error: unknown, responseStatus?: number): BenchmarkOperationError {
  if (error instanceof BenchmarkOperationError) return error;
  const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const rawStatus = responseStatus ?? source.status ?? source.statusCode;
  const status = typeof rawStatus === "number" ? rawStatus : typeof rawStatus === "string" && /^\d{3}$/.test(rawStatus) ? Number(rawStatus) : undefined;
  const code = typeof source.code === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(source.code) ? source.code : "supabase_error";
  const name = typeof source.name === "string" ? source.name : "";
  const classification =
    status !== undefined && status >= 500 ? "backend_health" :
    status === 401 || (status === 400 && /credential|auth/i.test(code)) || /^Auth.*Error$/.test(name) ? "authentication" :
    status === 403 || status === 404 || status === 406 || code === "42501" || code === "PGRST116" ? "authorization" :
    status === 408 || code === "timeout" || name === "AbortError" || name === "TimeoutError" ? "timeout":
    code.startsWith("23") ? "application" : "transport/sdk";
  return new BenchmarkOperationError(classification, { code, status });
}

async function sdk<T = unknown>(operation: () => PromiseLike<unknown>): Promise<ResponseLike<T>> {
  try { return await operation() as ResponseLike<T>; } catch (error) { throw normalizeSupabaseError(error); }
}
export function checkedSupabaseResponse<T>(response: ResponseLike<T> | null | undefined): T {
  if (!response || typeof response !== "object") throw new BenchmarkOperationError("invalid_response", { code: "response_shape" });
  if (response.error) throw normalizeSupabaseError(response.error, response.status);
  return response.data as T;
}
export function requiredSupabaseObject<T = Record<string, unknown>>(response: ResponseLike<unknown> | null | undefined, code: string): T {
  const data = checkedSupabaseResponse(response);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new BenchmarkOperationError("invalid_response", { code });
  if ("user" in data) {
    const user = (data as { user?: unknown }).user;
    if (user !== null && (!user || typeof user !== "object" || Array.isArray(user) || typeof (user as { id?: unknown }).id !== "string" || !(user as { id: string }).id)) throw new BenchmarkOperationError("invalid_response", { code });
  }
  return data as T;
}
function requiredAuthPayload(response: ResponseLike<unknown> | null | undefined, code: string): { user: { id: string } | null } {
  const payload = requiredSupabaseObject<{ user: unknown }>(response, code);
  if (payload.user !== null && (!payload.user || typeof payload.user !== "object" || Array.isArray(payload.user) || typeof (payload.user as { id?: unknown }).id !== "string" || !(payload.user as { id: string }).id)) throw new BenchmarkOperationError("invalid_response", { code });
  return payload as { user: { id: string } | null };
}
function requiredArray<T = unknown>(response: ResponseLike<unknown>, code: string): T[] {
  const data = checkedSupabaseResponse(response);
  if (!Array.isArray(data)) throw new BenchmarkOperationError("invalid_response", { code });
  return data as T[];
}
function required<T>(response: ResponseLike<T>, code: string): T {
  const data = checkedSupabaseResponse(response);
  if (data === null || data === undefined) throw new BenchmarkOperationError("authorization", { code, status: 404 });
  return data;
}

export const MAX_PAGE_OFFSET = 10_000_000;
export function pageRange(page: number, pageSize: number): [number, number] {
  if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > 1_000) throw new BenchmarkOperationError("application", { code: "pagination" });
  const start = page * pageSize, end = start + pageSize - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end > MAX_PAGE_OFFSET) throw new BenchmarkOperationError("application", { code: "pagination" });
  return [start, end];
}
export function escapeLikePattern(value: string): string { return value.replace(/[\\%_]/g, "\\$&"); }
export function createSupabaseClient(url: string, key: string, projectId = SUPABASE_PROJECT_ID, suffix = "user", request?: SessionRequestController): SupabaseClient {
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false, storageKey: `local-${projectId}-${suffix}-auth` }, ...(request ? { global: { fetch: request.fetch.bind(request) } } : {}) });
}
const newId = (): string => randomBytes(8).toString("hex").slice(0, 15);

class SupabaseSession implements AppSession {
  constructor(private readonly client: SupabaseClient, private profileRow: Row, private readonly request: SessionRequestController) {}

  private async requireProject(organizationId: string, projectId: string): Promise<void> {
    const response = await sdk(() => this.client.from("projects").select("id").eq("id", projectId).eq("organization_id", organizationId).maybeSingle());
    required(response, "project_denied");
  }
  private async requireTask(organizationId: string, projectId: string, taskId: string): Promise<void> {
    await this.requireProject(organizationId, projectId);
    const response = await sdk(() => this.client.from("tasks").select("id").eq("id", taskId).eq("organization_id", organizationId).eq("project_id", projectId).maybeSingle());
    required(response, "task_denied");
  }
  private async requireAssignee(organizationId: string, assigneeId: string | null | undefined): Promise<void> {
    if (!assigneeId) return;
    const response = await sdk(() => this.client.from("memberships").select("id").eq("organization_id", organizationId).eq("user_id", assigneeId).maybeSingle());
    required(response, "assignee_tenant_denied");
  }
  private async listProjects(organizationId: string): Promise<Project[]> {
    const projects: Project[] = [];
    for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
      const response = await sdk(() => this.client.from("projects").select(FIELDS.project).eq("organization_id", organizationId).order("created_at").order("id").range(...pageRange(page, PROJECT_PAGE_SIZE)));
      const rows = requiredArray(response, "project_list") as unknown[];
      projects.push(...rows.map(mapSupabaseProject));
      if (rows.length < PROJECT_PAGE_SIZE) return projects;
    }
    throw new BenchmarkOperationError("invalid_response", { code: "project_page_limit" });
  }
  private async taskPage(input: ListTasksInput | SearchTasksInput, query?: string): Promise<Page<Task>> {
    await this.requireProject(input.organizationId, input.projectId);
    let builder = this.client.from("tasks").select(FIELDS.task, { count: "exact" }).eq("organization_id", input.organizationId).eq("project_id", input.projectId);
    if ("status" in input && input.status) builder = builder.eq("status", input.status);
    if ("assigneeId" in input && input.assigneeId === null) builder = builder.is("assignee_id", null);
    else if ("assigneeId" in input && input.assigneeId) builder = builder.eq("assignee_id", input.assigneeId);
    if (query !== undefined) builder = builder.ilike("title", `%${escapeLikePattern(query)}%`);
    const response = await sdk(() => builder.order("created_at").order("id").range(...pageRange(input.page, input.pageSize)));
    const values = requiredArray(response, "task_list") as unknown[];
    return mapSupabasePage(values.map(mapSupabaseTask), input.page, input.pageSize, response.count as number);
  }

  async dashboard(input: DashboardInput): Promise<Dashboard> {
    await this.requireProject(input.organizationId, input.projectId);
    const activity = input.activityPage || { page: 0, pageSize: 10 };
    const [organization, projects, recent] = await allSettledValues([
      sdk(() => this.client.from("organizations").select(FIELDS.organization).eq("id", input.organizationId).maybeSingle()),
      this.listProjects(input.organizationId),
      sdk(() => this.client.from("activities").select(FIELDS.activity).eq("organization_id", input.organizationId).order("created_at", { ascending: false }).order("id", { ascending: false }).range(...pageRange(activity.page, activity.pageSize))),
    ]);
    return { organization: mapSupabaseOrganization(required(organization, "organization_denied")), projects, recentActivity: requiredArray(recent, "activity_list").map(mapSupabaseActivity) };
  }
  listTasks(input: ListTasksInput): Promise<Page<Task>> { return this.taskPage(input); }
  searchTasks(input: SearchTasksInput): Promise<Page<Task>> { return this.taskPage(input, input.query); }

  async getTask(input: GetTaskInput): Promise<TaskDetail> {
    await this.requireTask(input.organizationId, input.projectId, input.taskId);
    const [taskResponse, commentsResponse] = await allSettledValues([
      sdk(() => this.client.from("tasks").select(FIELDS.task).eq("id", input.taskId).eq("organization_id", input.organizationId).eq("project_id", input.projectId).maybeSingle()),
      sdk(() => this.client.from("comments").select(FIELDS.comment, { count: "exact" }).eq("organization_id", input.organizationId).eq("project_id", input.projectId).eq("task_id", input.taskId).order("created_at").order("id").range(...pageRange(input.comments.page, input.comments.pageSize))),
    ]);
    const task = mapSupabaseTask(required(taskResponse, "task_denied"));
    const [creator, assignee] = await allSettledValues([
      sdk(() => this.client.from("profiles").select(FIELDS.profile).eq("id", task.creatorId).maybeSingle()),
      task.assigneeId ? sdk(() => this.client.from("profiles").select(FIELDS.profile).eq("id", task.assigneeId!).maybeSingle()) : Promise.resolve(null),
    ]);
    const comments = requiredArray(commentsResponse, "comment_list") as unknown[];
    return {
      task,
      creator: mapSupabaseUser(required(creator, "creator_denied")),
      assignee: assignee ? mapSupabaseUser(required(assignee, "assignee_denied")) : null,
      comments: mapSupabasePage(comments.map(mapSupabaseComment), input.comments.page, input.comments.pageSize, commentsResponse.count as number),
    };
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    await this.requireProject(input.organizationId, input.projectId);
    await this.requireAssignee(input.organizationId, input.assigneeId);
    const response = await sdk(() => this.client.from("tasks").insert({
      id: newId(), organization_id: input.organizationId, project_id: input.projectId, creator_id: requiredString(this.profileRow, "id"), assignee_id: input.assigneeId ?? null,
      title: input.title, description: input.description, status: "todo", priority: input.priority, due_date: input.dueDate ?? null,
    }).select(FIELDS.task).maybeSingle());
    return mapSupabaseTask(required(response, "task_create_denied"));
  }

  async updateTask(input: UpdateTaskInput): Promise<Task> {
    await this.requireTask(input.organizationId, input.projectId, input.taskId);
    await this.requireAssignee(input.organizationId, input.assigneeId);
    const updates: Row = {};
    for (const field of ["status", "priority", "title", "description"] as const) if (input[field] !== undefined) updates[field] = input[field];
    if (input.assigneeId !== undefined) updates.assignee_id = input.assigneeId;
    if (input.dueDate !== undefined) updates.due_date = input.dueDate;
    const response = await sdk(() => this.client.from("tasks").update(updates).eq("id", input.taskId).eq("organization_id", input.organizationId).eq("project_id", input.projectId).select(FIELDS.task).maybeSingle());
    return mapSupabaseTask(required(response, "task_update_denied"));
  }

  async addComment(input: AddCommentInput): Promise<Comment> {
    await this.requireTask(input.organizationId, input.projectId, input.taskId);
    const response = await sdk(() => this.client.from("comments").insert({ id: newId(), organization_id: input.organizationId, project_id: input.projectId, task_id: input.taskId, author_id: requiredString(this.profileRow, "id"), body: input.body }).select(FIELDS.comment).maybeSingle());
    return mapSupabaseComment(required(response, "comment_create_denied"));
  }

  async updateComment(input: UpdateCommentInput): Promise<Comment> {
    await this.requireTask(input.organizationId, input.projectId, input.taskId);
    const response = await sdk(() => this.client.from("comments").update({ body: input.body }).eq("id", input.commentId).eq("organization_id", input.organizationId).eq("project_id", input.projectId).eq("task_id", input.taskId).select(FIELDS.comment).maybeSingle());
    return mapSupabaseComment(required(response, "comment_update_denied"));
  }

  async updateMembershipRole(input: UpdateMembershipRoleInput): Promise<Membership> {
    const response = await sdk(() => this.client.from("memberships").update({ role: input.role }).eq("id", input.membershipId).eq("organization_id", input.organizationId).select(FIELDS.membership).maybeSingle());
    return mapSupabaseMembership(required(response, "membership_update_denied"));
  }
  async getProfile(): Promise<User> {
    const auth = requiredAuthPayload(await sdk(() => this.client.auth.getUser()), "auth_user_response");
    if (!auth.user) throw new BenchmarkOperationError("authentication", { code: "session_missing" });
    const response = await sdk(() => this.client.from("profiles").select(FIELDS.profile).eq("auth_id", auth.user!.id).maybeSingle());
    this.profileRow = row(required(response, "profile_missing"));
    return mapSupabaseUser(this.profileRow);
  }
  async updateProfile(input: UpdateProfileInput): Promise<User> {
    const response = await sdk(() => this.client.from("profiles").update({ display_name: input.displayName }).eq("id", requiredString(this.profileRow, "id")).select(FIELDS.profile).maybeSingle());
    this.profileRow = row(required(response, "profile_update_denied"));
    return mapSupabaseUser(this.profileRow);
  }
  async refreshSession(): Promise<void> { checkedSupabaseResponse(await sdk(() => this.client.auth.refreshSession())); }
  async signOut(): Promise<void> { checkedSupabaseResponse(await sdk(() => this.client.auth.signOut())); }
  cancelPending(): void { this.request.cancelPending(); }
  async close(): Promise<void> { await this.signOut(); }
}

export function publicSupabaseConfiguration(status: SupabaseStatus): { url: string; publicKey: string } {
  const publicKey = status.PUBLISHABLE_KEY || status.ANON_KEY;
  if (typeof status.API_URL !== "string" || typeof publicKey !== "string") throw new BenchmarkOperationError("invalid_response", { code: "status_keys" });
  return { url: status.API_URL, publicKey };
}
async function adminClient(): Promise<SupabaseClient> {
  const status = await supabaseProcess.status();
  const serviceKey = status.SECRET_KEY || status.SERVICE_ROLE_KEY;
  if (typeof serviceKey !== "string") throw new BenchmarkOperationError("invalid_response", { code: "status_keys" });
  return createSupabaseClient(status.API_URL, serviceKey, SUPABASE_PROJECT_ID, "admin");
}
function profileName(profile: DatasetProfile): ProfileName {
  try { profileExpectedCounts(profile.name, profile.definition); }
  catch { throw new BenchmarkOperationError("application", { code: "invalid_profile" }); }
  return profile.name;
}
function ordinalFromId(id: string): number {
  const ordinal = Number.parseInt(id.slice(4), 36);
  if (!Number.isSafeInteger(ordinal)) throw new BenchmarkOperationError("application", { code: "invalid_seed_id" });
  return ordinal;
}
function benchmarkEmail(profile: ProfileName, id: string): string { return `${profile}-${id}${BENCHMARK_EMAIL_SUFFIX}`; }

export function seedRecord(entity: EntityName, item: SeedRecord, profile: ProfileName, authId?: string): Row {
  const counts = datasetProfiles[profile];
  switch (entity) {
    case "user": {
      const value = item as User;
      if (!authId) throw new BenchmarkOperationError("application", { code: "missing_auth_id" });
      return { id: value.id, auth_id: authId, email: benchmarkEmail(profile, value.id), display_name: value.displayName, created_at: value.createdAt, updated_at: value.updatedAt };
    }
    case "organization": { const value = item as Organization; return { id: value.id, name: value.name, owner_id: value.ownerId, created_at: value.createdAt }; }
    case "membership": { const value = item as Membership; return { id: value.id, organization_id: value.organizationId, user_id: value.userId, role: value.role, created_at: value.createdAt }; }
    case "project": { const value = item as Project; return { id: value.id, organization_id: value.organizationId, name: value.name, status: value.status, created_at: value.createdAt, updated_at: value.updatedAt }; }
    case "task": {
      const value = item as Task, projectOrdinal = ordinalFromId(value.projectId);
      return { id: value.id, organization_id: entityId("organization", profile, projectOrdinal % counts.organizations), project_id: value.projectId, creator_id: value.creatorId, assignee_id: value.assigneeId, title: value.title, description: value.description, status: value.status, priority: value.priority, due_date: value.dueDate, created_at: value.createdAt, updated_at: value.updatedAt };
    }
    case "comment": {
      const value = item as Comment, taskOrdinal = ordinalFromId(value.taskId), projectOrdinal = taskOrdinal % counts.projects;
      return { id: value.id, organization_id: entityId("organization", profile, projectOrdinal % counts.organizations), project_id: entityId("project", profile, projectOrdinal), task_id: value.taskId, author_id: value.authorId, body: value.body, created_at: value.createdAt, updated_at: value.updatedAt };
    }
    case "activity": { const value = item as Activity; return { id: value.id, organization_id: value.organizationId, project_id: value.projectId, actor_id: value.actorId, action: value.action, subject_type: value.subjectType, subject_id: value.subjectId, created_at: value.createdAt }; }
  }
}

const tableFor: Record<EntityName, string> = { user: "profiles", organization: "organizations", membership: "memberships", project: "projects", task: "tasks", comment: "comments", activity: "activities" };
async function insertRows(client: SupabaseClient, table: string, records: Row[]): Promise<void> {
  for (let offset = 0; offset < records.length; offset += SEED_BATCH_SIZE) checkedSupabaseResponse(await sdk(() => client.from(table).insert(records.slice(offset, offset + SEED_BATCH_SIZE))));
}
async function benchmarkAuthUserIds(client: SupabaseClient): Promise<string[]> {
  const result: string[] = [], perPage = 1_000;
  for (let page = 1; page <= MAX_PROJECT_PAGES; page++) {
    const response = await sdk(() => client.auth.admin.listUsers({ page, perPage }));
    const users = requiredSupabaseObject<{ users: unknown }>(response, "auth_list_response").users;
    if (!Array.isArray(users) || users.some(user => !user || typeof user !== "object" || typeof (user as { id?: unknown }).id !== "string")) throw new BenchmarkOperationError("invalid_response", { code: "auth_list_users" });
    result.push(...(users as Array<{ id: string; email?: string }>).filter(user => user.email?.endsWith(BENCHMARK_EMAIL_SUFFIX)).map(user => user.id));
    if (users.length < perPage) return result;
  }
  throw new BenchmarkOperationError("invalid_response", { code: "auth_page_limit" });
}
async function clearBenchmarkData(client: SupabaseClient): Promise<void> {
  for (const table of ["activities", "comments", "tasks", "projects", "memberships", "organizations", "profiles"]) checkedSupabaseResponse(await sdk(() => client.from(table).delete().not("id", "is", null)));
  for (const id of await benchmarkAuthUserIds(client)) checkedSupabaseResponse(await sdk(() => client.auth.admin.deleteUser(id)));
}
async function createAuthProfiles(client: SupabaseClient, records: User[], profile: ProfileName): Promise<void> {
  for (let offset = 0; offset < records.length; offset += AUTH_CONCURRENCY) {
    const entries = records.slice(offset, offset + AUTH_CONCURRENCY);
    const created = await Promise.all(entries.map(async value => {
      const response = await sdk(() => client.auth.admin.createUser({ email: benchmarkEmail(profile, value.id), password: LOCAL_BENCHMARK_PASSWORD, email_confirm: true, user_metadata: { profile_id: value.id } }));
      const authUser = requiredAuthPayload(response, "auth_create_response").user;
      if (!authUser) throw new BenchmarkOperationError("invalid_response", { code: "auth_user_missing" });
      return seedRecord("user", value, profile, authUser.id);
    }));
    await insertRows(client, "profiles", created);
  }
}
async function verifyCounts(client: SupabaseClient, expected: Record<string, number>): Promise<void> {
  for (const [table, count] of Object.entries(expected)) {
    const response = await sdk(() => client.from(table).select("id", { head: true, count: "exact" }));
    checkedSupabaseResponse(response);
    if (response.count !== count) throw new BenchmarkOperationError("invalid_response", { code: "seed_count_mismatch" });
  }
  if ((await benchmarkAuthUserIds(client)).length !== expected.profiles) throw new BenchmarkOperationError("invalid_response", { code: "auth_count_mismatch" });
}
async function seed(profile: DatasetProfile, seedValue: number): Promise<void> {
  const name = profileName(profile), client = await adminClient();
  await clearBenchmarkData(client);
  for await (const batch of seedDataset(name, seedValue, SEED_BATCH_SIZE)) {
    if (batch.entity === "user") await createAuthProfiles(client, batch.records as User[], name);
    else await insertRows(client, tableFor[batch.entity], batch.records.map(value => seedRecord(batch.entity, value, name)));
  }
  const { users, ...counts } = profileExpectedCounts(name);
  await verifyCounts(client, { profiles: users, ...counts });
  await client.auth.signOut().catch(() => undefined);
}

const FIXTURE_IDS = {
  owner: "sxown0000000001", admin: "sxadm0000000001", member: "sxmem0000000001", outsider: "sxout0000000001",
  organization: "sxorg0000000001", secondOrganization: "sxorg0000000002", project: "sxprj0000000001", task: "sxtsk0000000001",
  ownerMembership: "sxmow0000000001", adminMembership: "sxmad0000000001", memberMembership: "sxmme0000000001", secondAdminMembership: "sxmad0000000002", outsiderMembership: "sxmou0000000002",
} as const;
export interface SupabaseCorrectnessFixture extends CorrectnessFixture { foreignMembershipId: string; outsiderUserId: string; secondOrganizationId: string; }

export async function seedSupabaseCorrectnessFixture(): Promise<SupabaseCorrectnessFixture> {
  for (const id of Object.values(FIXTURE_IDS)) if (!/^[a-z0-9]{15}$/.test(id)) throw new Error("Invalid Supabase fixture ID");
  const client = await adminClient();
  // Fixture IDs/emails are disjoint from the seeded profile; never clear measured data here.
  const names = ["owner", "admin", "member", "outsider"] as const;
  const credentials = (name: typeof names[number]): Credentials => ({ email: `${name}${BENCHMARK_EMAIL_SUFFIX}`, password: LOCAL_BENCHMARK_PASSWORD });
  const profiles: Row[] = [];
  for (const name of names) {
    const response = await sdk(() => client.auth.admin.createUser({ email: credentials(name).email, password: LOCAL_BENCHMARK_PASSWORD, email_confirm: true, user_metadata: { profile_id: FIXTURE_IDS[name] } }));
    const authUser = requiredAuthPayload(response, "fixture_auth_response").user;
    if (!authUser) throw new BenchmarkOperationError("invalid_response", { code: "fixture_auth_missing" });
    profiles.push({ id: FIXTURE_IDS[name], auth_id: authUser.id, email: credentials(name).email, display_name: name });
  }
  await insertRows(client, "profiles", profiles);
  await insertRows(client, "organizations", [
    { id: FIXTURE_IDS.organization, name: "Supabase correctness", owner_id: FIXTURE_IDS.owner },
    { id: FIXTURE_IDS.secondOrganization, name: "Supabase foreign tenant", owner_id: FIXTURE_IDS.admin },
  ]);
  await insertRows(client, "memberships", [
    { id: FIXTURE_IDS.ownerMembership, organization_id: FIXTURE_IDS.organization, user_id: FIXTURE_IDS.owner, role: "owner" },
    { id: FIXTURE_IDS.adminMembership, organization_id: FIXTURE_IDS.organization, user_id: FIXTURE_IDS.admin, role: "admin" },
    { id: FIXTURE_IDS.memberMembership, organization_id: FIXTURE_IDS.organization, user_id: FIXTURE_IDS.member, role: "member" },
    { id: FIXTURE_IDS.secondAdminMembership, organization_id: FIXTURE_IDS.secondOrganization, user_id: FIXTURE_IDS.admin, role: "owner" },
    { id: FIXTURE_IDS.outsiderMembership, organization_id: FIXTURE_IDS.secondOrganization, user_id: FIXTURE_IDS.outsider, role: "member" },
  ]);
  await insertRows(client, "projects", [{ id: FIXTURE_IDS.project, organization_id: FIXTURE_IDS.organization, name: "Correctness project", status: "active" }]);
  await insertRows(client, "tasks", [{ id: FIXTURE_IDS.task, organization_id: FIXTURE_IDS.organization, project_id: FIXTURE_IDS.project, creator_id: FIXTURE_IDS.owner, assignee_id: FIXTURE_IDS.member, title: "Seed task", description: "Correctness seed", status: "todo", priority: "medium" }]);
  await client.auth.signOut().catch(() => undefined);
  return {
    owner: credentials("owner"), admin: credentials("admin"), member: credentials("member"), outsider: credentials("outsider"),
    organizationId: FIXTURE_IDS.organization, secondOrganizationId: FIXTURE_IDS.secondOrganization, projectId: FIXTURE_IDS.project, taskId: FIXTURE_IDS.task,
    ownerMembershipId: FIXTURE_IDS.ownerMembership, adminMembershipId: FIXTURE_IDS.adminMembership, memberMembershipId: FIXTURE_IDS.memberMembership,
    memberUserId: FIXTURE_IDS.member, foreignMembershipId: FIXTURE_IDS.outsiderMembership, outsiderUserId: FIXTURE_IDS.outsider,
  };
}

let measuredConfiguration: { url: string; publicKey: string } | undefined;
export async function createSupabaseSession(credentials: Credentials, options: SessionRequestOptions = {}, configuration = measuredConfiguration): Promise<AppSession> {
  if (!configuration) throw new BenchmarkOperationError("backend_health", { code: "supabase_not_started" });
  const request = createSessionRequestController(options);
  const client = createSupabaseClient(configuration.url, configuration.publicKey, SUPABASE_PROJECT_ID, newId(), request);
  let authenticated = false;
  try {
    const auth = await sdk(() => client.auth.signInWithPassword(credentials));
    authenticated = true;
    const user = requiredAuthPayload(auth, "auth_signin_response").user;
    if (!user) throw new BenchmarkOperationError("authentication", { code: "invalid_credentials" });
    const profile = await sdk(() => client.from("profiles").select(FIELDS.profile).eq("auth_id", user.id).maybeSingle());
    request.detachParent();
    return new SupabaseSession(client, row(required(profile, "profile_missing")), request);
  } catch (error) {
    request.detachParent();
    if (authenticated) await client.auth.signOut().catch(() => undefined);
    throw error;
  }
}

const createSession = (credentials: Credentials, options: SessionRequestOptions = {}): Promise<AppSession> => createSupabaseSession(credentials, options);

export const backend: Backend = {
  name: "supabase",
  doctor: async (): Promise<BackendInfo> => supabaseProcess.doctor(),
  start: async () => {
    measuredConfiguration = undefined;
    measuredConfiguration = publicSupabaseConfiguration(await supabaseProcess.start());
  },
  reset: async () => {
    measuredConfiguration = undefined;
    measuredConfiguration = publicSupabaseConfiguration(await supabaseProcess.reset());
  },
  seed,
  seedCorrectnessFixture: seedSupabaseCorrectnessFixture,
  buildVirtualUserSpecs: (profile, count, seedValue) => buildSeedVirtualUserSpecs(profile, count, seedValue, (id) => benchmarkEmail(profile, id), LOCAL_BENCHMARK_PASSWORD),
  createSession,
  stop: async () => {
    try { await supabaseProcess.stop(); }
    finally { measuredConfiguration = undefined; }
  },
};
