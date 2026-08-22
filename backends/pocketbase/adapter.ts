import { randomBytes } from "node:crypto";
import PocketBase, { BaseAuthStore, ClientResponseError, type RecordModel } from "pocketbase";
import type { Backend, AppSession, BackendInfo, SessionRequestOptions } from "../../src/backend.js";
import { createSessionRequestController, type SessionRequestController } from "../../src/session-request.js";
import { allSettledValues } from "../../src/settle.js";

import type {
  Activity,
  AddCommentInput,
  Comment,
  CreateTaskInput,
  Credentials,
  Dashboard,
  DashboardInput,
  DatasetProfile,
  GetTaskInput,
  ListTasksInput,
  Membership,
  Organization,
  Page,
  Project,
  Role,
  SearchTasksInput,
  Task,
  TaskDetail,
  TaskPriority,
  TaskStatus,
  UpdateCommentInput,
  UpdateMembershipRoleInput,
  UpdateProfileInput,
  UpdateTaskInput,
  User,
} from "../../src/domain.js";
import { BenchmarkOperationError, type CorrectnessFixture } from "../../src/correctness.js";
import { datasetProfiles, entityId, seedDataset, buildSeedVirtualUserSpecs, profileExpectedCounts, type EntityName, type ProfileName, type SeedRecord } from "../../src/seed.js";
import {
  LOCAL_BENCHMARK_PASSWORD,
  LOCAL_SETUP_EMAIL,
  LOCAL_SETUP_PASSWORD,
  pocketBaseProcess,
} from "./process.js";

type PocketRecord = Record<string, unknown>;
type PocketPage<T> = { page: number; perPage: number; totalItems: number; totalPages: number; items: T[] };
const BATCH_SIZE = 50;
const TASK_FIELDS = "id,project,creator,assignee,title,description,status,priority,dueDate,created,updated";
const COMMENT_FIELDS = "id,task,author,body,created,updated";
const MEMBER_FIELDS = "id,organization,user,role,created";
const PROJECT_FIELDS = "id,organization,name,status,created,updated";
const ACTIVITY_FIELDS = "id,organization,project,actor,action,subjectType,subjectId,created";
const USER_FIELDS = "id,email,displayName,created,updated";
const FIXTURE_IDS = {
  owner: "fxown0000000001",
  admin: "fxadm0000000001",
  member: "fxmem0000000001",
  outsider: "fxout0000000001",
  organization: "fxorg0000000001",
  ownerMembership: "fxmow0000000001",
  adminMembership: "fxmad0000000001",
  memberMembership: "fxmme0000000001",
  project: "fxprj0000000001",
  task: "fxtsk0000000001",
  secondOrganization: "fxorg0000000002",
  secondAdminMembership: "fxmad0000000002",
  outsiderMembership: "fxmou0000000002",
} as const;

export interface PocketBaseCorrectnessFixture extends CorrectnessFixture {
  foreignMembershipId: string;
  outsiderUserId: string;
}

function record(value: unknown): PocketRecord {
  if (typeof value !== "object" || value === null) throw new BenchmarkOperationError("invalid_response", { code: "record_shape" });
  return value as PocketRecord;
}

function stringField(value: PocketRecord, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || !result) throw new BenchmarkOperationError("invalid_response", { code: "record_field" });
  return result;
}

function optionalString(value: PocketRecord, field: string): string | null {
  const result = value[field];
  if (result === "" || result === null || result === undefined) return null;
  if (typeof result !== "string") throw new BenchmarkOperationError("invalid_response", { code: "record_field" });
  return result;
}

function enumField<T extends string>(value: PocketRecord, field: string, allowed: readonly T[]): T {
  const result = stringField(value, field);
  if (!allowed.includes(result as T)) throw new BenchmarkOperationError("invalid_response", { code: "record_enum" });
  return result as T;
}

export function mapPocketBaseUser(value: unknown): User {
  const source = record(value);
  return {
    id: stringField(source, "id"),
    email: stringField(source, "email"),
    displayName: stringField(source, "displayName"),
    createdAt: stringField(source, "created"),
    updatedAt: stringField(source, "updated"),
  };
}

function mapPocketBaseOrganization(value: unknown): Organization {
  const source = record(value);
  return {
    id: stringField(source, "id"),
    name: stringField(source, "name"),
    ownerId: stringField(source, "owner"),
    createdAt: stringField(source, "created"),
  };
}

function mapPocketBaseProject(value: unknown): Project {
  const source = record(value);
  return {
    id: stringField(source, "id"),
    organizationId: stringField(source, "organization"),
    name: stringField(source, "name"),
    status: stringField(source, "status"),
    createdAt: stringField(source, "created"),
    updatedAt: stringField(source, "updated"),
  };
}

export function mapPocketBaseTask(value: unknown): Task {
  const source = record(value);
  return {
    id: stringField(source, "id"),
    projectId: stringField(source, "project"),
    creatorId: stringField(source, "creator"),
    assigneeId: optionalString(source, "assignee"),
    title: stringField(source, "title"),
    description: stringField(source, "description"),
    status: enumField<TaskStatus>(source, "status", ["todo", "in_progress", "done", "cancelled"]),
    priority: enumField<TaskPriority>(source, "priority", ["low", "medium", "high", "urgent"]),
    dueDate: optionalString(source, "dueDate"),
    createdAt: stringField(source, "created"),
    updatedAt: stringField(source, "updated"),
  };
}

function mapPocketBaseComment(value: unknown): Comment {
  const source = record(value);
  return {
    id: stringField(source, "id"),
    taskId: stringField(source, "task"),
    authorId: stringField(source, "author"),
    body: stringField(source, "body"),
    createdAt: stringField(source, "created"),
    updatedAt: stringField(source, "updated"),
  };
}

function mapPocketBaseActivity(value: unknown): Activity {
  const source = record(value);
  return {
    id: stringField(source, "id"),
    organizationId: stringField(source, "organization"),
    projectId: optionalString(source, "project"),
    actorId: stringField(source, "actor"),
    action: stringField(source, "action"),
    subjectType: stringField(source, "subjectType"),
    subjectId: stringField(source, "subjectId"),
    createdAt: stringField(source, "created"),
  };
}

function mapPocketBaseMembership(value: unknown): Membership {
  const source = record(value);
  return {
    id: stringField(source, "id"),
    organizationId: stringField(source, "organization"),
    userId: stringField(source, "user"),
    role: enumField<Role>(source, "role", ["owner", "admin", "member"]),
    createdAt: stringField(source, "created"),
  };
}

export function mapPocketBasePage<T, U>(result: PocketPage<T>, mapper: (item: T) => U): Page<U> {
  if (!result || !Number.isInteger(result.page) || result.page < 1 || !Number.isInteger(result.perPage) || result.perPage < 1 ||
      !Number.isInteger(result.totalItems) || result.totalItems < 0 || !Number.isInteger(result.totalPages) || result.totalPages < 0 ||
      result.totalPages !== (result.totalItems === 0 ? 0 : Math.ceil(result.totalItems / result.perPage)) || !Array.isArray(result.items) || result.items.length > result.perPage) {
    throw new BenchmarkOperationError("invalid_response", { code: "page_shape" });
  }
  return {
    items: result.items.map(mapper),
    page: result.page - 1,
    pageSize: result.perPage,
    total: result.totalItems,
    hasNext: result.page < result.totalPages,
  };
}

export function normalizePocketBaseError(error: unknown): BenchmarkOperationError {
  if (error instanceof BenchmarkOperationError) return error;
  if (error instanceof ClientResponseError) {
    const status = error.status || undefined;
    if (error.isAbort) return new BenchmarkOperationError("timeout", { code: "request_aborted", status });
    if (status === 401) return new BenchmarkOperationError("authentication", { code: "invalid_session", status });
    if (status === 403) return new BenchmarkOperationError("authorization", { code: "forbidden", status });
    if (status === 404) return new BenchmarkOperationError("authorization", { code: "not_found_or_denied", status });
    if (status === 408) return new BenchmarkOperationError("timeout", { code: "request_timeout", status });
    if (status !== undefined && status >= 500) return new BenchmarkOperationError("backend_health", { code: "server_error", status });
    if (status !== undefined) return new BenchmarkOperationError("application", { code: "request_rejected", status });
    return new BenchmarkOperationError("transport/sdk", { code: "connection_failed" });
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new BenchmarkOperationError("timeout", { code: "request_timeout" });
  }
  return new BenchmarkOperationError("transport/sdk", { code: "sdk_error" });
}

async function sdk<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw normalizePocketBaseError(error);
  }
}

type TaskFilterInput = Pick<ListTasksInput, "organizationId" | "projectId"> & {
  status?: TaskStatus;
  assigneeId?: string | null;
  query?: string;
};

export function taskListFilter(pb: PocketBase, input: TaskFilterInput): string {
  const clauses = [pb.filter("organization = {:organization} && project = {:project}", {
    organization: input.organizationId,
    project: input.projectId,
  })];
  if (input.status !== undefined) clauses.push(pb.filter("status = {:status}", { status: input.status }));
  if (input.assigneeId !== undefined) clauses.push(pb.filter("assignee = {:assignee}", { assignee: input.assigneeId || "" }));
  if (input.query) clauses.push(pb.filter("(title ~ {:query} || description ~ {:query})", { query: input.query }));
  return clauses.join(" && ");
}

const newRecordId = (): string => randomBytes(8).toString("hex").slice(0, 15);

export async function fetchPocketBaseTaskDetail(pb: PocketBase, input: GetTaskInput): Promise<TaskDetail> {
  const [taskRecord, comments] = await allSettledValues([
    sdk(() => pb.collection("tasks").getOne(input.taskId, { fields: TASK_FIELDS })),
    sdk(() => pb.collection("comments").getList(input.comments.page + 1, input.comments.pageSize, {
      filter: pb.filter("task = {:task} && organization = {:organization} && project = {:project}", {
        task: input.taskId,
        organization: input.organizationId,
        project: input.projectId,
      }),
      sort: "created,id",
      fields: COMMENT_FIELDS,
    })),
  ]);
  const source = record(taskRecord);
  const assigneeId = optionalString(source, "assignee");
  const [creator, assignee] = await allSettledValues([
    sdk(() => pb.collection("users").getOne(stringField(source, "creator"), { fields: USER_FIELDS })),
    assigneeId ? sdk(() => pb.collection("users").getOne(assigneeId, { fields: USER_FIELDS })) : Promise.resolve(null),
  ]);
  return {
    task: mapPocketBaseTask(source),
    creator: mapPocketBaseUser(creator),
    assignee: assignee ? mapPocketBaseUser(assignee) : null,
    comments: mapPocketBasePage(comments, mapPocketBaseComment),
  };
}

class PocketBaseSession implements AppSession {
  private closed = false;

  constructor(private readonly pb: PocketBase, private readonly request: SessionRequestController) {}

  private authRecord(): RecordModel {
    if (this.closed || !this.pb.authStore.isValid || !this.pb.authStore.record) {
      throw new BenchmarkOperationError("authentication", { code: "signed_out" });
    }
    return this.pb.authStore.record;
  }

  private async requireMembership(organizationId: string): Promise<void> {
    const user = this.authRecord();
    const result = await sdk(() => this.pb.collection("memberships").getList(1, 1, {
      filter: this.pb.filter("organization = {:organization} && user = {:user}", { organization: organizationId, user: user.id }),
      fields: "id",
      skipTotal: true,
    }));
    if (result.items.length !== 1) throw new BenchmarkOperationError("authorization", { code: "tenant_denied" });
  }

  private async requireMembershipTarget(organizationId: string, membershipId: string): Promise<void> {
    await this.requireMembership(organizationId);
    const result = await sdk(() => this.pb.collection("memberships").getList(1, 1, {
      filter: this.pb.filter("id = {:membership} && organization = {:organization}", {
        membership: membershipId,
        organization: organizationId,
      }),
      fields: "id",
      skipTotal: true,
    }));
    if (result.items.length !== 1) throw new BenchmarkOperationError("authorization", { code: "membership_tenant_denied" });
  }

  private async requireAssignee(organizationId: string, assigneeId: string | null | undefined): Promise<void> {
    if (!assigneeId) return;
    const result = await sdk(() => this.pb.collection("memberships").getList(1, 1, {
      filter: this.pb.filter("organization = {:organization} && user = {:user}", {
        organization: organizationId,
        user: assigneeId,
      }),
      fields: "id",
      skipTotal: true,
    }));
    if (result.items.length !== 1) throw new BenchmarkOperationError("authorization", { code: "assignee_tenant_denied" });
  }

  private async requireProject(organizationId: string, projectId: string): Promise<void> {
    await this.requireMembership(organizationId);
    const result = await sdk(() => this.pb.collection("projects").getList(1, 1, {
      filter: this.pb.filter("id = {:project} && organization = {:organization}", { project: projectId, organization: organizationId }),
      fields: "id",
      skipTotal: true,
    }));
    if (result.items.length !== 1) throw new BenchmarkOperationError("authorization", { code: "project_denied" });
  }

  private async listProjects(organizationId: string): Promise<Project[]> {
    const options = {
      filter: this.pb.filter("organization = {:organization}", { organization: organizationId }),
      sort: "created,id",
      fields: PROJECT_FIELDS,
    };
    const first = await sdk(() => this.pb.collection("projects").getList(1, 100, options));
    const projects = mapPocketBasePage(first, mapPocketBaseProject).items;
    for (let page = 2; page <= first.totalPages; page++) {
      const next = await sdk(() => this.pb.collection("projects").getList(page, 100, options));
      projects.push(...mapPocketBasePage(next, mapPocketBaseProject).items);
    }
    return projects;
  }

  private async requireTask(organizationId: string, projectId: string, taskId: string): Promise<void> {
    await this.requireProject(organizationId, projectId);
    const result = await sdk(() => this.pb.collection("tasks").getList(1, 1, {
      filter: this.pb.filter("id = {:task} && organization = {:organization} && project = {:project}", {
        task: taskId,
        organization: organizationId,
        project: projectId,
      }),
      fields: "id",
      skipTotal: true,
    }));
    if (result.items.length !== 1) throw new BenchmarkOperationError("authorization", { code: "task_denied" });
  }

  async dashboard(input: DashboardInput): Promise<Dashboard> {
    await this.requireProject(input.organizationId, input.projectId);
    const activity = input.activityPage || { page: 0, pageSize: 10 };
    const [organization, projects, recentActivity] = await allSettledValues([
      sdk(() => this.pb.collection("organizations").getOne(input.organizationId, { fields: "id,name,owner,created" })),
      this.listProjects(input.organizationId),
      sdk(() => this.pb.collection("activities").getList(activity.page + 1, activity.pageSize, {
        filter: this.pb.filter("organization = {:organization}", { organization: input.organizationId }),
        sort: "-created,-id",
        fields: ACTIVITY_FIELDS,
      })),
    ]);
    return {
      organization: mapPocketBaseOrganization(organization),
      projects,
      recentActivity: recentActivity.items.map(mapPocketBaseActivity),
    };
  }

  async listTasks(input: ListTasksInput): Promise<Page<Task>> {
    this.authRecord();
    const result = await sdk(() => this.pb.collection("tasks").getList(input.page + 1, input.pageSize, {
      filter: taskListFilter(this.pb, input),
      sort: "created,id",
      fields: TASK_FIELDS,
    }));
    return mapPocketBasePage(result, mapPocketBaseTask);
  }

  async getTask(input: GetTaskInput): Promise<TaskDetail> {
    await this.requireTask(input.organizationId, input.projectId, input.taskId);
    return fetchPocketBaseTaskDetail(this.pb, input);
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    await this.requireProject(input.organizationId, input.projectId);
    await this.requireAssignee(input.organizationId, input.assigneeId);
    const user = this.authRecord();
    const id = newRecordId();
    const batch = this.pb.createBatch();
    batch.collection("tasks").create({
      id,
      organization: input.organizationId,
      project: input.projectId,
      creator: user.id,
      assignee: input.assigneeId || "",
      title: input.title,
      description: input.description,
      status: "todo",
      priority: input.priority,
      dueDate: input.dueDate || "",
    });
    batch.collection("activities").create({
      id: newRecordId(),
      organization: input.organizationId,
      project: input.projectId,
      actor: user.id,
      action: "created",
      subjectType: "task",
      subjectId: id,
    });
    const results = await sdk(() => batch.send());
    return mapPocketBaseTask(batchRecord(results, 0));
  }

  async updateTask(input: UpdateTaskInput): Promise<Task> {
    await this.requireTask(input.organizationId, input.projectId, input.taskId);
    await this.requireAssignee(input.organizationId, input.assigneeId);
    const user = this.authRecord();
    const updates: PocketRecord = {};
    for (const field of ["status", "priority", "title", "description"] as const) {
      if (input[field] !== undefined) updates[field] = input[field];
    }
    if (input.assigneeId !== undefined) updates.assignee = input.assigneeId || "";
    if (input.dueDate !== undefined) updates.dueDate = input.dueDate || "";
    const batch = this.pb.createBatch();
    batch.collection("tasks").update(input.taskId, updates);
    batch.collection("activities").create({
      id: newRecordId(),
      organization: input.organizationId,
      project: input.projectId,
      actor: user.id,
      action: "updated",
      subjectType: "task",
      subjectId: input.taskId,
    });
    const results = await sdk(() => batch.send());
    return mapPocketBaseTask(batchRecord(results, 0));
  }

  async addComment(input: AddCommentInput): Promise<Comment> {
    await this.requireTask(input.organizationId, input.projectId, input.taskId);
    const user = this.authRecord();
    const id = newRecordId();
    const batch = this.pb.createBatch();
    batch.collection("comments").create({
      id,
      organization: input.organizationId,
      project: input.projectId,
      task: input.taskId,
      author: user.id,
      body: input.body,
    });
    batch.collection("activities").create({
      id: newRecordId(),
      organization: input.organizationId,
      project: input.projectId,
      actor: user.id,
      action: "commented",
      subjectType: "task",
      subjectId: input.taskId,
    });
    const results = await sdk(() => batch.send());
    return mapPocketBaseComment(batchRecord(results, 0));
  }

  async updateComment(input: UpdateCommentInput): Promise<Comment> {
    await this.requireTask(input.organizationId, input.projectId, input.taskId);
    const visible = await sdk(() => this.pb.collection("comments").getList(1, 1, {
      filter: this.pb.filter("id = {:comment} && task = {:task} && organization = {:organization} && project = {:project}", {
        comment: input.commentId,
        task: input.taskId,
        organization: input.organizationId,
        project: input.projectId,
      }),
      fields: "id",
      skipTotal: true,
    }));
    if (visible.items.length !== 1) throw new BenchmarkOperationError("authorization", { code: "comment_denied" });
    const user = this.authRecord();
    const batch = this.pb.createBatch();
    batch.collection("comments").update(input.commentId, { body: input.body });
    batch.collection("activities").create({
      id: newRecordId(),
      organization: input.organizationId,
      project: input.projectId,
      actor: user.id,
      action: "comment_updated",
      subjectType: "task",
      subjectId: input.taskId,
    });
    const results = await sdk(() => batch.send());
    return mapPocketBaseComment(batchRecord(results, 0));
  }

  async updateMembershipRole(input: UpdateMembershipRoleInput): Promise<Membership> {
    await this.requireMembershipTarget(input.organizationId, input.membershipId);
    const updated = await sdk(() => this.pb.collection("memberships").update(input.membershipId, { role: input.role }, { fields: MEMBER_FIELDS }));
    return mapPocketBaseMembership(updated);
  }

  async searchTasks(input: SearchTasksInput): Promise<Page<Task>> {
    this.authRecord();
    const result = await sdk(() => this.pb.collection("tasks").getList(input.page + 1, input.pageSize, {
      filter: taskListFilter(this.pb, input),
      sort: "created,id",
      fields: TASK_FIELDS,
    }));
    return mapPocketBasePage(result, mapPocketBaseTask);
  }

  async getProfile(): Promise<User> {
    return mapPocketBaseUser(this.authRecord());
  }

  async updateProfile(input: UpdateProfileInput): Promise<User> {
    const user = this.authRecord();
    const updated = await sdk(() => this.pb.collection("users").update(user.id, { displayName: input.displayName }));
    return mapPocketBaseUser(updated);
  }

  async refreshSession(): Promise<void> {
    this.authRecord();
    await sdk(() => this.pb.collection("users").authRefresh());
  }

  async signOut(): Promise<void> {
    this.pb.authStore.clear();
  }

  cancelPending(): void {
    this.request.cancelPending();
    this.pb.cancelAllRequests();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pb.authStore.clear();
  }
}

export function batchRecord(results: Array<{ status: number; body: unknown }>, index: number): unknown {
  const result = results[index];
  if (!result || result.status < 200 || result.status >= 300) {
    throw normalizePocketBaseError(new ClientResponseError({ status: result?.status || 0, response: {} }));
  }
  return result.body;
}

async function setupClient(): Promise<PocketBase> {
  const pb = new PocketBase(pocketBaseProcess.options.endpoint, new BaseAuthStore());
  await sdk(() => pb.collection("_superusers").authWithPassword(LOCAL_SETUP_EMAIL, LOCAL_SETUP_PASSWORD));
  return pb;
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

function seedBody(entity: EntityName, item: SeedRecord, profile: ProfileName): PocketRecord {
  const counts = datasetProfiles[profile];
  switch (entity) {
    case "user": {
      const value = item as User;
      return { id: value.id, email: value.email, emailVisibility: true, verified: true, displayName: value.displayName, password: LOCAL_BENCHMARK_PASSWORD, passwordConfirm: LOCAL_BENCHMARK_PASSWORD };
    }
    case "organization": {
      const value = item as Organization;
      return { id: value.id, name: value.name, owner: value.ownerId };
    }
    case "membership": {
      const value = item as Membership;
      return { id: value.id, organization: value.organizationId, user: value.userId, role: value.role };
    }
    case "project": {
      const value = item as Project;
      return { id: value.id, organization: value.organizationId, name: value.name, status: value.status };
    }
    case "task": {
      const value = item as Task;
      const projectOrdinal = ordinalFromId(value.projectId);
      return {
        id: value.id,
        organization: entityId("organization", profile, projectOrdinal % counts.organizations),
        project: value.projectId,
        creator: value.creatorId,
        assignee: value.assigneeId || "",
        title: value.title,
        description: value.description,
        status: value.status,
        priority: value.priority,
        dueDate: value.dueDate || "",
      };
    }
    case "comment": {
      const value = item as Comment;
      const taskOrdinal = ordinalFromId(value.taskId);
      const projectOrdinal = taskOrdinal % counts.projects;
      return {
        id: value.id,
        organization: entityId("organization", profile, projectOrdinal % counts.organizations),
        project: entityId("project", profile, projectOrdinal),
        task: value.taskId,
        author: value.authorId,
        body: value.body,
      };
    }
    case "activity": {
      const value = item as Activity;
      return { id: value.id, organization: value.organizationId, project: value.projectId || "", actor: value.actorId, action: value.action, subjectType: value.subjectType, subjectId: value.subjectId };
    }
  }
}

const collectionFor: Record<EntityName, string> = {
  organization: "organizations",
  user: "users",
  membership: "memberships",
  project: "projects",
  task: "tasks",
  comment: "comments",
  activity: "activities",
};

async function upsertRecords(pb: PocketBase, collection: string, records: readonly PocketRecord[]): Promise<void> {
  for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
    const entries = records.slice(offset, offset + BATCH_SIZE);
    const batch = pb.createBatch();
    for (const item of entries) batch.collection(collection).upsert(item);
    const results = await sdk(() => batch.send());
    if (results.length !== entries.length) throw new BenchmarkOperationError("invalid_response", { code: "batch_count" });
    for (let index = 0; index < results.length; index++) batchRecord(results, index);
  }
}

async function seed(profile: DatasetProfile, seedValue: number): Promise<void> {
  const name = profileName(profile);
  const pb = await setupClient();
  try {
    for await (const batchData of seedDataset(name, seedValue, BATCH_SIZE)) {
      await upsertRecords(pb, collectionFor[batchData.entity], batchData.records.map((item) => seedBody(batchData.entity, item, name)));
    }
    for (const [collection, count] of Object.entries(profileExpectedCounts(name))) {
      const result = await sdk(() => pb.collection(collection).getList(1, 1, { fields: "id" }));
      if (result.totalItems !== count) throw new BenchmarkOperationError("invalid_response", { code: "seed_count_mismatch" });
    }
  } finally {
    pb.authStore.clear();
    pb.cancelAllRequests();
  }
}

export async function seedPocketBaseCorrectnessFixture(): Promise<PocketBaseCorrectnessFixture> {
  for (const id of Object.values(FIXTURE_IDS)) {
    if (!/^[a-z0-9]{15}$/.test(id)) throw new Error("Invalid PocketBase fixture ID");
  }
  const pb = await setupClient();
  const credentials = (name: "owner" | "admin" | "member" | "outsider"): Credentials => ({
    email: `${name}@pocketbase.bench.test`,
    password: LOCAL_BENCHMARK_PASSWORD,
  });
  try {
    await upsertRecords(pb, "users", (["owner", "admin", "member", "outsider"] as const).map((name) => ({
      id: FIXTURE_IDS[name],
      email: credentials(name).email,
      emailVisibility: true,
      verified: true,
      displayName: name,
      password: LOCAL_BENCHMARK_PASSWORD,
      passwordConfirm: LOCAL_BENCHMARK_PASSWORD,
    })));
    await upsertRecords(pb, "organizations", [
      { id: FIXTURE_IDS.organization, name: "PocketBase correctness", owner: FIXTURE_IDS.owner },
      { id: FIXTURE_IDS.secondOrganization, name: "PocketBase foreign tenant", owner: FIXTURE_IDS.admin },
    ]);
    await upsertRecords(pb, "memberships", [
      { id: FIXTURE_IDS.ownerMembership, organization: FIXTURE_IDS.organization, user: FIXTURE_IDS.owner, role: "owner" },
      { id: FIXTURE_IDS.adminMembership, organization: FIXTURE_IDS.organization, user: FIXTURE_IDS.admin, role: "admin" },
      { id: FIXTURE_IDS.memberMembership, organization: FIXTURE_IDS.organization, user: FIXTURE_IDS.member, role: "member" },
      { id: FIXTURE_IDS.secondAdminMembership, organization: FIXTURE_IDS.secondOrganization, user: FIXTURE_IDS.admin, role: "owner" },
      { id: FIXTURE_IDS.outsiderMembership, organization: FIXTURE_IDS.secondOrganization, user: FIXTURE_IDS.outsider, role: "member" },
    ]);
    await upsertRecords(pb, "projects", [{ id: FIXTURE_IDS.project, organization: FIXTURE_IDS.organization, name: "Correctness project", status: "active" }]);
    await upsertRecords(pb, "tasks", [{
      id: FIXTURE_IDS.task,
      organization: FIXTURE_IDS.organization,
      project: FIXTURE_IDS.project,
      creator: FIXTURE_IDS.owner,
      assignee: FIXTURE_IDS.member,
      title: "Seed task",
      description: "Correctness seed",
      status: "todo",
      priority: "medium",
      dueDate: "",
    }]);
    return {
      owner: credentials("owner"),
      admin: credentials("admin"),
      member: credentials("member"),
      outsider: credentials("outsider"),
      organizationId: FIXTURE_IDS.organization,
      projectId: FIXTURE_IDS.project,
      taskId: FIXTURE_IDS.task,
      ownerMembershipId: FIXTURE_IDS.ownerMembership,
      adminMembershipId: FIXTURE_IDS.adminMembership,
      memberMembershipId: FIXTURE_IDS.memberMembership,
      memberUserId: FIXTURE_IDS.member,
      foreignMembershipId: FIXTURE_IDS.outsiderMembership,
      outsiderUserId: FIXTURE_IDS.outsider,
    };
  } finally {
    pb.authStore.clear();
    pb.cancelAllRequests();
  }
}

export function createPocketBaseMeasuredClient(endpoint: string, options: SessionRequestOptions = {}): { client: PocketBase; request: SessionRequestController } {
  const request = createSessionRequestController(options);
  const client = new PocketBase(endpoint, new BaseAuthStore());
  client.beforeSend = (url, sendOptions) => ({ url, options: { ...sendOptions, signal: request.signal(sendOptions.signal) } });
  return { client, request };
}

async function createSession(credentials: Credentials, options: SessionRequestOptions = {}): Promise<AppSession> {
  const { client: pb, request } = createPocketBaseMeasuredClient(pocketBaseProcess.options.endpoint, options);
  try {
    await pb.collection("users").authWithPassword(credentials.email, credentials.password);
  } catch (error) {
    if (error instanceof ClientResponseError && error.status === 400) {
      throw new BenchmarkOperationError("authentication", { code: "invalid_credentials", status: 400 });
    }
    throw normalizePocketBaseError(error);
  }
  request.detachParent();
  return new PocketBaseSession(pb, request);
}

export const backend: Backend = {
  name: "pocketbase",
  doctor: async (): Promise<BackendInfo> => pocketBaseProcess.doctor(),
  start: async () => pocketBaseProcess.start(),
  reset: async () => pocketBaseProcess.reset(),
  seed,
  seedCorrectnessFixture: seedPocketBaseCorrectnessFixture,
  buildVirtualUserSpecs: (profile, count, seedValue) => buildSeedVirtualUserSpecs(profile, count, seedValue, (_id, canonical) => canonical, LOCAL_BENCHMARK_PASSWORD),
  createSession,
  stop: async () => pocketBaseProcess.stop(),
};
