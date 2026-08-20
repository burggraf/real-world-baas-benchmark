import { randomBytes } from "node:crypto";
import { DeleteOperation, initClient, type Client, type FilterOrComposite, type ListOpts } from "trailbase";
import type { Backend, AppSession } from "../../src/backend.js";
import type {
  Activity, AddCommentInput, Comment, CreateTaskInput, Credentials, Dashboard, DashboardInput, DatasetProfile,
  GetTaskInput, ListTasksInput, Membership, Organization, Page, Project, Role, SearchTasksInput, Task, TaskDetail,
  TaskPriority, TaskStatus, UpdateCommentInput, UpdateMembershipRoleInput, UpdateProfileInput, UpdateTaskInput, User,
} from "../../src/domain.js";
import { BenchmarkOperationError, type CorrectnessFixture } from "../../src/correctness.js";
import { datasetProfiles, entityId, seedDataset, type EntityName, type ProfileName, type SeedRecord } from "../../src/seed.js";
import {
  LOCAL_BENCHMARK_PASSWORD, LOCAL_SETUP_EMAIL, LOCAL_SETUP_PASSWORD, resolveTrailBaseOptions,
  trailBaseProcess, TRAILBASE_VERSION,
} from "./process.js";

type Row = Record<string, unknown>;
const BATCH = 50;
const AUTH_CONCURRENCY = 8;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 1_000_000;
const BENCHMARK_EMAIL_SUFFIX = "@trailbase.bench.test";
const BENCHMARK_PROFILE_IDS = "^(usr[sml][0-9a-z]{11}|fx(own|adm|mem|out)0000000001)$";
const BENCHMARK_ORGANIZATION_IDS = "^(org[sml][0-9a-z]{11}|fxorg000000000[12])$";
const AUTH_ID = /^[A-Za-z0-9+/_-]{22}==$/;
const PUBLIC_ID = /^[a-z0-9]{15}$/;
const FIXTURE_IDS = {
  owner: "fxown0000000001",
  admin: "fxadm0000000001",
  member: "fxmem0000000001",
  outsider: "fxout0000000001",
  organization: "fxorg0000000001",
  secondOrganization: "fxorg0000000002",
  ownerMembership: "fxmow0000000001",
  adminMembership: "fxmad0000000001",
  memberMembership: "fxmme0000000001",
  outsiderMembership: "fxmou0000000002",
  project: "fxprj0000000001",
  secondProject: "fxprj0000000002",
  task: "fxtsk0000000001",
  foreignTask: "fxtsk0000000002",
} as const;

export interface TrailBaseCorrectnessFixture extends CorrectnessFixture {
  foreignMembershipId: string;
  outsiderUserId: string;
  secondOrganizationId: string;
  secondProjectId: string;
  foreignTaskId: string;
}

function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BenchmarkOperationError("invalid_response", { code: "record_shape" });
  return value as Row;
}
function stringField(source: Row, field: string): string {
  const value = source[field];
  if (typeof value !== "string" || !value) throw new BenchmarkOperationError("invalid_response", { code: "record_field" });
  return value;
}
function textField(source: Row, field: string): string {
  const value = source[field];
  if (typeof value !== "string") throw new BenchmarkOperationError("invalid_response", { code: "record_field" });
  return value;
}
function publicId(source: Row): string {
  const value = stringField(source, "publicId");
  if (!PUBLIC_ID.test(value)) throw new BenchmarkOperationError("invalid_response", { code: "public_id" });
  return value;
}
function nullableString(source: Row, field: string): string | null {
  const value = source[field];
  if (value === null) return null;
  if (typeof value !== "string") throw new BenchmarkOperationError("invalid_response", { code: "record_field" });
  return value;
}
function enumString<T extends string>(source: Row, field: string, allowed: readonly T[]): T {
  const value = stringField(source, field);
  if (!allowed.includes(value as T)) throw new BenchmarkOperationError("invalid_response", { code: "record_enum" });
  return value as T;
}

export function recordInternalId(value: unknown): number {
  const id = row(value).id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new BenchmarkOperationError("invalid_response", { code: "record_id" });
  return id;
}

export function mapTrailBaseUser(value: unknown): User {
  const source = row(value);
  return { id: publicId(source), email: stringField(source, "email"), displayName: stringField(source, "displayName"), createdAt: stringField(source, "createdAt"), updatedAt: stringField(source, "updatedAt") };
}
export function mapTrailBaseTask(value: unknown): Task {
  const source = row(value);
  return {
    id: publicId(source), projectId: stringField(source, "projectId"), creatorId: stringField(source, "creatorId"), assigneeId: nullableString(source, "assigneeId"),
    title: stringField(source, "title"), description: textField(source, "description"), status: enumString<TaskStatus>(source, "status", ["todo", "in_progress", "done", "cancelled"]),
    priority: enumString<TaskPriority>(source, "priority", ["low", "medium", "high", "urgent"]), dueDate: nullableString(source, "dueDate"),
    createdAt: stringField(source, "createdAt"), updatedAt: stringField(source, "updatedAt"),
  };
}
function mapOrganization(value: unknown): Organization {
  const source = row(value);
  return { id: publicId(source), name: stringField(source, "name"), ownerId: stringField(source, "ownerId"), createdAt: stringField(source, "createdAt") };
}
function mapProject(value: unknown): Project {
  const source = row(value);
  return { id: publicId(source), organizationId: stringField(source, "organizationId"), name: stringField(source, "name"), status: stringField(source, "status"), createdAt: stringField(source, "createdAt"), updatedAt: stringField(source, "updatedAt") };
}
function mapComment(value: unknown): Comment {
  const source = row(value);
  return { id: publicId(source), taskId: stringField(source, "taskId"), authorId: stringField(source, "authorId"), body: stringField(source, "body"), createdAt: stringField(source, "createdAt"), updatedAt: stringField(source, "updatedAt") };
}
function mapActivity(value: unknown): Activity {
  const source = row(value);
  return { id: publicId(source), organizationId: stringField(source, "organizationId"), projectId: nullableString(source, "projectId"), actorId: stringField(source, "actorId"), action: stringField(source, "action"), subjectType: stringField(source, "subjectType"), subjectId: stringField(source, "subjectId"), createdAt: stringField(source, "createdAt") };
}
function mapMembership(value: unknown): Membership {
  const source = row(value);
  return { id: publicId(source), organizationId: stringField(source, "organizationId"), userId: stringField(source, "userId"), role: enumString<Role>(source, "role", ["owner", "admin", "member"]), createdAt: stringField(source, "createdAt") };
}

export function normalizeTrailBaseError(error: unknown): BenchmarkOperationError {
  if (error instanceof BenchmarkOperationError) return error;
  const source = error && typeof error === "object" ? error as Row : {};
  const rawStatus = source.status;
  const status = typeof rawStatus === "number" ? rawStatus : typeof rawStatus === "string" && /^\d{3}$/.test(rawStatus) ? Number(rawStatus) : undefined;
  const classification = status === 401 ? "authentication" : status === 403 || status === 404 ? "authorization" : status === 408 ? "timeout" : "transport/sdk";
  return new BenchmarkOperationError(classification, { code: "trailbase_request", status });
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function trailBaseTaskFilters(input: ListTasksInput | SearchTasksInput): FilterOrComposite[] {
  const filters: FilterOrComposite[] = [
    { column: "organizationId", op: "equal", value: input.organizationId },
    { column: "projectId", op: "equal", value: input.projectId },
  ];
  if ("status" in input && input.status !== undefined) filters.push({ column: "status", op: "equal", value: input.status });
  if ("assigneeId" in input && input.assigneeId !== undefined) filters.push(input.assigneeId === null ? { column: "assigneeId", op: "isNull", value: "" } : { column: "assigneeId", op: "equal", value: input.assigneeId });
  if ("query" in input && input.query) filters.push({ column: "title", op: "regexp", value: escapeRegExp(input.query) });
  return filters;
}

async function sdk<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw normalizeTrailBaseError(error); }
}

function pageInput(page: number, pageSize: number): { offset: number; limit: number } {
  if (!Number.isSafeInteger(page) || page < 0 || page > MAX_PAGE || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new BenchmarkOperationError("invalid_response", { code: "pagination_input" });
  }
  const offset = page * pageSize;
  if (!Number.isSafeInteger(offset)) throw new BenchmarkOperationError("invalid_response", { code: "pagination_input" });
  return { offset, limit: pageSize };
}

async function listRows(client: Client, name: string, page: number, pageSize: number, options: Omit<ListOpts, "pagination"> = {}): Promise<Page<Row>> {
  const pagination = pageInput(page, pageSize);
  const response = await sdk(() => client.records<Row>(name).list({ ...options, pagination, count: true }));
  if (!response || !Array.isArray(response.records) || !Number.isSafeInteger(response.total_count) || Number(response.total_count) < 0) {
    throw new BenchmarkOperationError("invalid_response", { code: "record_list" });
  }
  const total = Number(response.total_count);
  return { items: response.records.map(row), page, pageSize, total, hasNext: pagination.offset + response.records.length < total };
}

async function oneRow(client: Client, name: string, filters: FilterOrComposite[], denialCode: string): Promise<Row> {
  const result = await listRows(client, name, 0, 1, { filters, order: ["publicId"] });
  if (result.items.length !== 1) throw new BenchmarkOperationError("authorization", { code: denialCode });
  return result.items[0]!;
}

async function allRows(client: Client, name: string, filters: FilterOrComposite[], order: string[]): Promise<Row[]> {
  const result: Row[] = [];
  for (let page = 0; page <= MAX_PAGE; page++) {
    const next = await listRows(client, name, page, MAX_PAGE_SIZE, { filters, order });
    result.push(...next.items);
    if (!next.hasNext) return result;
  }
  throw new BenchmarkOperationError("invalid_response", { code: "page_limit" });
}

const newId = (): string => randomBytes(8).toString("hex").slice(0, 15);
const now = (): string => new Date().toISOString();

class TrailBaseSession implements AppSession {
  private closed = false;
  constructor(private readonly client: Client, private profileRow: Row) {}

  private authUser(): void {
    if (this.closed || !this.client.user()) throw new BenchmarkOperationError("authentication", { code: "signed_out" });
  }
  private profileId(): string {
    this.authUser();
    return publicId(this.profileRow);
  }
  private async membership(organizationId: string): Promise<Row> {
    return oneRow(this.client, "memberships", [
      { column: "organizationId", op: "equal", value: organizationId },
      { column: "userId", op: "equal", value: this.profileId() },
    ], "tenant_denied");
  }
  private async project(organizationId: string, projectId: string): Promise<Row> {
    await this.membership(organizationId);
    return oneRow(this.client, "projects", [
      { column: "publicId", op: "equal", value: projectId },
      { column: "organizationId", op: "equal", value: organizationId },
    ], "project_denied");
  }
  private async task(input: { organizationId: string; projectId: string; taskId: string }): Promise<Row> {
    await this.project(input.organizationId, input.projectId);
    return oneRow(this.client, "tasks", [
      { column: "publicId", op: "equal", value: input.taskId },
      { column: "organizationId", op: "equal", value: input.organizationId },
      { column: "projectId", op: "equal", value: input.projectId },
    ], "task_denied");
  }
  private async profile(profileId: string): Promise<Row> {
    return oneRow(this.client, "profiles", [{ column: "publicId", op: "equal", value: profileId }], "profile_denied");
  }
  private async validateAssignee(organizationId: string, assigneeId: string | null | undefined): Promise<void> {
    if (!assigneeId) return;
    await oneRow(this.client, "memberships", [
      { column: "organizationId", op: "equal", value: organizationId },
      { column: "userId", op: "equal", value: assigneeId },
    ], "assignee_tenant_denied");
  }

  async dashboard(input: DashboardInput): Promise<Dashboard> {
    await this.project(input.organizationId, input.projectId);
    const activity = input.activityPage || { page: 0, pageSize: 10 };
    const [organization, projects, recent] = await Promise.all([
      oneRow(this.client, "organizations", [{ column: "publicId", op: "equal", value: input.organizationId }], "organization_denied"),
      allRows(this.client, "projects", [{ column: "organizationId", op: "equal", value: input.organizationId }], ["createdAt", "publicId"]),
      listRows(this.client, "activities", activity.page, activity.pageSize, { filters: [{ column: "organizationId", op: "equal", value: input.organizationId }], order: ["-createdAt", "-publicId"] }),
    ]);
    return { organization: mapOrganization(organization), projects: projects.map(mapProject), recentActivity: recent.items.map(mapActivity) };
  }

  async listTasks(input: ListTasksInput): Promise<Page<Task>> {
    await this.project(input.organizationId, input.projectId);
    const result = await listRows(this.client, "tasks", input.page, input.pageSize, { filters: trailBaseTaskFilters(input), order: ["createdAt", "publicId"] });
    return { ...result, items: result.items.map(mapTrailBaseTask) };
  }

  async getTask(input: GetTaskInput): Promise<TaskDetail> {
    const task = await this.task(input);
    const comments = await listRows(this.client, "comments", input.comments.page, input.comments.pageSize, {
      filters: [
        { column: "organizationId", op: "equal", value: input.organizationId },
        { column: "projectId", op: "equal", value: input.projectId },
        { column: "taskId", op: "equal", value: input.taskId },
      ],
      order: ["createdAt", "publicId"],
    });
    const assigneeId = nullableString(task, "assigneeId");
    const [creator, assignee] = await Promise.all([
      this.profile(stringField(task, "creatorId")),
      assigneeId ? this.profile(assigneeId) : Promise.resolve(null),
    ]);
    return { task: mapTrailBaseTask(task), creator: mapTrailBaseUser(creator), assignee: assignee ? mapTrailBaseUser(assignee) : null, comments: { ...comments, items: comments.items.map(mapComment) } };
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    await this.project(input.organizationId, input.projectId);
    await this.validateAssignee(input.organizationId, input.assigneeId);
    const id = await sdk(() => this.client.records<Row>("tasks").create({
      publicId: newId(), organizationId: input.organizationId, projectId: input.projectId, creatorId: this.profileId(), assigneeId: input.assigneeId ?? null,
      title: input.title, description: input.description, status: "todo", priority: input.priority, dueDate: input.dueDate ?? null,
    }));
    return mapTrailBaseTask(await sdk(() => this.client.records<Row>("tasks").read(id)));
  }

  async updateTask(input: UpdateTaskInput): Promise<Task> {
    const target = await this.task(input);
    if (input.assigneeId !== undefined) await this.validateAssignee(input.organizationId, input.assigneeId);
    const patch: Row = {};
    for (const field of ["status", "priority", "assigneeId", "dueDate", "title", "description"] as const) if (input[field] !== undefined) patch[field] = input[field];
    if (!Object.keys(patch).length) return mapTrailBaseTask(target);
    patch.updatedAt = now();
    patch._activityActorId = this.profileId();
    const internalId = recordInternalId(target);
    await sdk(() => this.client.records<Row>("tasks").update(internalId, patch));
    return mapTrailBaseTask(await sdk(() => this.client.records<Row>("tasks").read(internalId)));
  }

  async addComment(input: AddCommentInput): Promise<Comment> {
    await this.task(input);
    const id = await sdk(() => this.client.records<Row>("comments").create({
      publicId: newId(), organizationId: input.organizationId, projectId: input.projectId, taskId: input.taskId, authorId: this.profileId(), body: input.body,
    }));
    return mapComment(await sdk(() => this.client.records<Row>("comments").read(id)));
  }

  async updateComment(input: UpdateCommentInput): Promise<Comment> {
    await this.task(input);
    const target = await oneRow(this.client, "comments", [
      { column: "publicId", op: "equal", value: input.commentId },
      { column: "organizationId", op: "equal", value: input.organizationId },
      { column: "projectId", op: "equal", value: input.projectId },
      { column: "taskId", op: "equal", value: input.taskId },
    ], "comment_denied");
    const internalId = recordInternalId(target);
    await sdk(() => this.client.records<Row>("comments").update(internalId, { body: input.body, updatedAt: now(), _activityActorId: this.profileId() }));
    return mapComment(await sdk(() => this.client.records<Row>("comments").read(internalId)));
  }

  async updateMembershipRole(input: UpdateMembershipRoleInput): Promise<Membership> {
    const own = mapMembership(await this.membership(input.organizationId));
    if (own.role !== "owner" && own.role !== "admin") throw new BenchmarkOperationError("authorization", { code: "role_denied" });
    const target = await oneRow(this.client, "memberships", [
      { column: "publicId", op: "equal", value: input.membershipId },
      { column: "organizationId", op: "equal", value: input.organizationId },
    ], "membership_tenant_denied");
    const internalId = recordInternalId(target);
    await sdk(() => this.client.records<Row>("memberships").update(internalId, { role: input.role }));
    return mapMembership(await sdk(() => this.client.records<Row>("memberships").read(internalId)));
  }

  async searchTasks(input: SearchTasksInput): Promise<Page<Task>> {
    await this.project(input.organizationId, input.projectId);
    const result = await listRows(this.client, "tasks", input.page, input.pageSize, { filters: trailBaseTaskFilters(input), order: ["createdAt", "publicId"] });
    return { ...result, items: result.items.map(mapTrailBaseTask) };
  }

  async getProfile(): Promise<User> {
    this.authUser();
    this.profileRow = row(await sdk(() => this.client.records<Row>("profiles").read(recordInternalId(this.profileRow))));
    return mapTrailBaseUser(this.profileRow);
  }

  async updateProfile(input: UpdateProfileInput): Promise<User> {
    this.authUser();
    const internalId = recordInternalId(this.profileRow);
    await sdk(() => this.client.records<Row>("profiles").update(internalId, { displayName: input.displayName }));
    this.profileRow = row(await sdk(() => this.client.records<Row>("profiles").read(internalId)));
    return mapTrailBaseUser(this.profileRow);
  }

  async refreshSession(): Promise<void> {
    this.authUser();
    await sdk(() => this.client.refreshAuthToken({ force: true }));
    this.authUser();
  }

  async signOut(): Promise<void> {
    if (this.closed || !this.client.user()) return;
    await sdk(() => this.client.logout());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.client.user()) await sdk(() => this.client.logout());
  }
}

async function register(email: string, password: string): Promise<void> {
  const endpoint = resolveTrailBaseOptions().endpoint;
  let response: Response;
  try {
    response = await fetch(new URL("/api/auth/v1/register", endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, password_repeat: password }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new BenchmarkOperationError("transport/sdk", { code: "setup_registration" });
  }
  if (!response.ok) throw new BenchmarkOperationError("transport/sdk", { code: "setup_registration", status: response.status });
}

async function setupClient(): Promise<Client> {
  let client = initClient(resolveTrailBaseOptions().endpoint);
  try {
    await client.login(LOCAL_SETUP_EMAIL, LOCAL_SETUP_PASSWORD);
  } catch {
    await register(LOCAL_SETUP_EMAIL, LOCAL_SETUP_PASSWORD);
    await trailBaseProcess.verifyRegisteredUsers([LOCAL_SETUP_EMAIL]);
    await trailBaseProcess.promoteVerifiedUser(LOCAL_SETUP_EMAIL);
    client = initClient(resolveTrailBaseOptions().endpoint);
    await sdk(() => client.login(LOCAL_SETUP_EMAIL, LOCAL_SETUP_PASSWORD));
  }
  if (!client.user()?.admin) {
    await sdk(() => client.logout());
    await trailBaseProcess.promoteVerifiedUser(LOCAL_SETUP_EMAIL);
    client = initClient(resolveTrailBaseOptions().endpoint);
    await sdk(() => client.login(LOCAL_SETUP_EMAIL, LOCAL_SETUP_PASSWORD));
  }
  if (!client.user()?.admin) throw new BenchmarkOperationError("authorization", { code: "setup_admin" });
  await sdk(() => client.records<Row>("profiles").list({ pagination: { limit: 1, offset: 0 }, count: true }));
  return client;
}

async function forConcurrent<T>(values: readonly T[], work: (value: T) => Promise<void>): Promise<void> {
  for (let offset = 0; offset < values.length; offset += AUTH_CONCURRENCY) await Promise.all(values.slice(offset, offset + AUTH_CONCURRENCY).map(work));
}

async function registerAndCapture(users: readonly { publicId: string; email: string }[]): Promise<Map<string, string>> {
  await forConcurrent(users, user => register(user.email, LOCAL_BENCHMARK_PASSWORD));
  await trailBaseProcess.verifyRegisteredUsers(users.map(user => user.email));
  const authIds = new Map<string, string>();
  await forConcurrent(users, async user => {
    const client = initClient(resolveTrailBaseOptions().endpoint);
    await sdk(() => client.login(user.email, LOCAL_BENCHMARK_PASSWORD));
    const authId = client.user()?.id;
    if (!authId || !AUTH_ID.test(authId)) throw new BenchmarkOperationError("invalid_response", { code: "auth_id" });
    authIds.set(user.publicId, authId);
    await sdk(() => client.logout());
  });
  return authIds;
}

async function createBulk(client: Client, table: string, records: Row[]): Promise<void> {
  for (let offset = 0; offset < records.length; offset += BATCH) {
    const batch = records.slice(offset, offset + BATCH);
    const ids = await sdk(() => client.records<Row>(table).createBulk(batch));
    if (!Array.isArray(ids) || ids.length !== batch.length) throw new BenchmarkOperationError("invalid_response", { code: "seed_insert" });
  }
}

async function deleteMatching(client: Client, table: string, filters: FilterOrComposite[]): Promise<void> {
  for (let batchNumber = 0; batchNumber <= MAX_PAGE; batchNumber++) {
    const page = await listRows(client, table, 0, BATCH, { filters, order: ["publicId"] });
    if (!page.items.length) return;
    const results = await sdk(() => client.execute(page.items.map(item => new DeleteOperation(table, recordInternalId(item))), true));
    if (!Array.isArray(results) || results.length !== page.items.length || results.some(result => result.error)) throw new BenchmarkOperationError("transport/sdk", { code: "seed_delete" });
  }
  throw new BenchmarkOperationError("invalid_response", { code: "seed_delete_limit" });
}

async function clearBenchmarkRecords(client: Client): Promise<void> {
  for (const table of ["comments", "activities", "tasks", "projects"] as const) {
    await deleteMatching(client, table, [{ column: "organizationId", op: "regexp", value: BENCHMARK_ORGANIZATION_IDS }]);
  }
  await deleteMatching(client, "organizations", [{ column: "publicId", op: "regexp", value: BENCHMARK_ORGANIZATION_IDS }]);
  await deleteMatching(client, "memberships", [{ column: "publicId", op: "regexp", value: "^(mem[sml][0-9a-z]{11}|fxm(ow|ad|me|ou)000000000[12])$" }]);
  await deleteMatching(client, "profiles", [{ column: "publicId", op: "regexp", value: BENCHMARK_PROFILE_IDS }]);
}

async function cleanBenchmarkData(): Promise<Client> {
  let client = await setupClient();
  await clearBenchmarkRecords(client);
  await sdk(() => client.logout());
  const authUsers = await trailBaseProcess.authUsersWithSuffix(BENCHMARK_EMAIL_SUFFIX);
  const pending = authUsers.filter(user => !user.verified && user.email !== LOCAL_SETUP_EMAIL).map(user => user.email);
  if (pending.length) await trailBaseProcess.verifyRegisteredUsers(pending);
  const emails = authUsers.filter(user => user.email !== LOCAL_SETUP_EMAIL).map(user => user.email);
  if (emails.length) await trailBaseProcess.deleteVerifiedUsers(emails);
  client = await setupClient();
  return client;
}

async function put(client: Client, table: string, value: Row): Promise<void> {
  const id = await sdk(() => client.records<Row>(table).create(value));
  if (typeof id !== "number" && typeof id !== "string") throw new BenchmarkOperationError("invalid_response", { code: "seed_insert" });
}

export async function seedTrailBaseCorrectnessFixture(): Promise<TrailBaseCorrectnessFixture> {
  const client = await cleanBenchmarkData();
  const names = ["owner", "admin", "member", "outsider"] as const;
  const credentials = (name: typeof names[number]): Credentials => ({ email: `${name}${BENCHMARK_EMAIL_SUFFIX}`, password: LOCAL_BENCHMARK_PASSWORD });
  const authIds = await registerAndCapture(names.map(name => ({ publicId: FIXTURE_IDS[name], email: credentials(name).email })));
  const timestamp = now();
  try {
    await createBulk(client, "profiles", names.map(name => ({ publicId: FIXTURE_IDS[name], authId: authIds.get(FIXTURE_IDS[name]), email: credentials(name).email, displayName: name, createdAt: timestamp, updatedAt: timestamp })));
    await put(client, "organizations", { publicId: FIXTURE_IDS.organization, name: "Fixture organization", ownerId: FIXTURE_IDS.owner, _ownerMembershipId: FIXTURE_IDS.ownerMembership, createdAt: timestamp });
    await put(client, "organizations", { publicId: FIXTURE_IDS.secondOrganization, name: "Foreign organization", ownerId: FIXTURE_IDS.outsider, _ownerMembershipId: FIXTURE_IDS.outsiderMembership, createdAt: timestamp });
    await createBulk(client, "memberships", [
      { publicId: FIXTURE_IDS.adminMembership, organizationId: FIXTURE_IDS.organization, userId: FIXTURE_IDS.admin, role: "admin", createdAt: timestamp },
      { publicId: FIXTURE_IDS.memberMembership, organizationId: FIXTURE_IDS.organization, userId: FIXTURE_IDS.member, role: "member", createdAt: timestamp },
    ]);
    await createBulk(client, "projects", [
      { publicId: FIXTURE_IDS.project, organizationId: FIXTURE_IDS.organization, name: "Fixture project", status: "active", createdAt: timestamp, updatedAt: timestamp },
      { publicId: FIXTURE_IDS.secondProject, organizationId: FIXTURE_IDS.secondOrganization, name: "Foreign project", status: "active", createdAt: timestamp, updatedAt: timestamp },
    ]);
    await createBulk(client, "tasks", [
      { publicId: FIXTURE_IDS.task, organizationId: FIXTURE_IDS.organization, projectId: FIXTURE_IDS.project, creatorId: FIXTURE_IDS.owner, assigneeId: FIXTURE_IDS.member, title: "Fixture task", description: "Fixture", status: "todo", priority: "medium", dueDate: null, createdAt: timestamp, updatedAt: timestamp, _seeded: 1 },
      { publicId: FIXTURE_IDS.foreignTask, organizationId: FIXTURE_IDS.secondOrganization, projectId: FIXTURE_IDS.secondProject, creatorId: FIXTURE_IDS.outsider, assigneeId: null, title: "Foreign task", description: "Foreign", status: "todo", priority: "low", dueDate: null, createdAt: timestamp, updatedAt: timestamp, _seeded: 1 },
    ]);
  } finally {
    await sdk(() => client.logout());
  }
  return {
    owner: credentials("owner"), admin: credentials("admin"), member: credentials("member"), outsider: credentials("outsider"),
    organizationId: FIXTURE_IDS.organization, projectId: FIXTURE_IDS.project, taskId: FIXTURE_IDS.task,
    ownerMembershipId: FIXTURE_IDS.ownerMembership, adminMembershipId: FIXTURE_IDS.adminMembership, memberMembershipId: FIXTURE_IDS.memberMembership,
    memberUserId: FIXTURE_IDS.member, foreignMembershipId: FIXTURE_IDS.outsiderMembership, outsiderUserId: FIXTURE_IDS.outsider,
    secondOrganizationId: FIXTURE_IDS.secondOrganization, secondProjectId: FIXTURE_IDS.secondProject, foreignTaskId: FIXTURE_IDS.foreignTask,
  };
}

function profileName(profile: DatasetProfile): ProfileName {
  if (!Object.hasOwn(datasetProfiles, profile.name) || JSON.stringify(profile.definition) !== JSON.stringify(datasetProfiles[profile.name])) throw new RangeError("Invalid dataset profile");
  return profile.name;
}

function ordinalFromId(id: string): number {
  const ordinal = Number.parseInt(id.slice(4), 36);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new BenchmarkOperationError("invalid_response", { code: "seed_id" });
  return ordinal;
}

function benchmarkEmail(profile: ProfileName, id: string): string { return `${profile}-${id}${BENCHMARK_EMAIL_SUFFIX}`; }

function seedRow(record: SeedRecord, entity: EntityName, profile: ProfileName, authIds: Map<string, string>): Row {
  const source = { ...(record as unknown as Row) };
  const id = stringField(source, "id");
  delete source.id;
  source.publicId = id;
  if (entity === "user") {
    source.authId = authIds.get(id);
    source.email = benchmarkEmail(profile, id);
  } else if (entity === "organization") {
    source._ownerMembershipId = entityId("membership", profile, ordinalFromId(id));
  } else if (entity === "task") {
    const projectId = stringField(source, "projectId");
    const projectOrdinal = ordinalFromId(projectId);
    source.organizationId = entityId("organization", profile, projectOrdinal % datasetProfiles[profile].organizations);
    source._seeded = 1;
  } else if (entity === "comment") {
    const taskOrdinal = ordinalFromId(stringField(source, "taskId"));
    const projectOrdinal = taskOrdinal % datasetProfiles[profile].projects;
    source.projectId = entityId("project", profile, projectOrdinal);
    source.organizationId = entityId("organization", profile, projectOrdinal % datasetProfiles[profile].organizations);
    source._seeded = 1;
  }
  return source;
}

const tableFor: Record<EntityName, string> = { user: "profiles", organization: "organizations", membership: "memberships", project: "projects", task: "tasks", comment: "comments", activity: "activities" };

async function verifySeed(client: Client, profile: ProfileName, authEmails: string[]): Promise<void> {
  const expected: Record<string, number> = {
    profiles: datasetProfiles[profile].users,
    organizations: datasetProfiles[profile].organizations,
    memberships: datasetProfiles[profile].users,
    projects: datasetProfiles[profile].projects,
    tasks: datasetProfiles[profile].tasks,
    comments: datasetProfiles[profile].comments,
    activities: datasetProfiles[profile].activities,
  };
  for (const [table, count] of Object.entries(expected)) {
    const page = await listRows(client, table, 0, 1, { filters: [{ column: "publicId", op: "regexp", value: `^[a-z]{3}${profile[0]}[0-9a-z]{11}$` }] });
    if (page.total !== count) throw new BenchmarkOperationError("invalid_response", { code: "seed_count_mismatch" });
  }
  const expectedEmails = new Set([LOCAL_SETUP_EMAIL, ...authEmails]);
  const authUsers = await trailBaseProcess.authUsersWithSuffix(BENCHMARK_EMAIL_SUFFIX);
  if (authUsers.length !== expectedEmails.size || authUsers.some(user => !user.verified || !expectedEmails.has(user.email))) throw new BenchmarkOperationError("invalid_response", { code: "seed_auth_count_mismatch" });
}

export async function seedTrailBase(profile: DatasetProfile, seed: number): Promise<void> {
  const name = profileName(profile);
  let client = await cleanBenchmarkData();
  const users: { publicId: string; email: string; record: SeedRecord }[] = [];
  for await (const batch of seedDataset(name, seed, BATCH)) {
    if (batch.entity !== "user") break;
    for (const record of batch.records) {
      const id = stringField(record as unknown as Row, "id");
      users.push({ publicId: id, email: benchmarkEmail(name, id), record });
    }
  }
  const authIds = await registerAndCapture(users);
  try {
    await createBulk(client, "profiles", users.map(user => seedRow(user.record, "user", name, authIds)));
    for await (const batch of seedDataset(name, seed, BATCH)) {
      if (batch.entity === "user") continue;
      const records = batch.entity === "membership" ? batch.records.filter(record => (record as { role: string }).role !== "owner") : batch.records;
      await createBulk(client, tableFor[batch.entity], records.map(record => seedRow(record, batch.entity, name, authIds)));
    }
    await verifySeed(client, name, users.map(user => user.email));
  } finally {
    await sdk(() => client.logout());
  }
}

export const backend: Backend = {
  name: "trailbase",
  doctor: () => trailBaseProcess.doctor(),
  start: () => trailBaseProcess.start(),
  reset: () => trailBaseProcess.reset(),
  stop: () => trailBaseProcess.stop(),
  seed: seedTrailBase,
  createSession: async (credentials: Credentials): Promise<AppSession> => {
    const client = initClient(resolveTrailBaseOptions().endpoint);
    await sdk(() => client.login(credentials.email, credentials.password));
    const authId = client.user()?.id;
    if (!authId || !AUTH_ID.test(authId)) {
      await client.logout().catch(() => undefined);
      throw new BenchmarkOperationError("authentication", { code: "auth_user" });
    }
    let profile: Row;
    try { profile = await oneRow(client, "profiles", [{ column: "authId", op: "equal", value: authId }], "profile_missing"); }
    catch (error) { await client.logout().catch(() => undefined); throw error; }
    return new TrailBaseSession(client, profile);
  },
};

export { TRAILBASE_VERSION };
