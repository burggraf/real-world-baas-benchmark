import type { Backend, AppSession } from "./backend.js";
import type { Comment, Credentials, Id, Membership, Page, Task, TaskDetail, User } from "./domain.js";
import type { CorrectnessFinding, FindingClassification } from "./result.js";

export interface CorrectnessFixture {
  owner: Credentials;
  admin: Credentials;
  member: Credentials;
  outsider: Credentials;
  organizationId: Id;
  projectId: Id;
  taskId?: Id;
  ownerMembershipId: Id;
  memberMembershipId: Id;
  memberUserId?: Id;
  adminMembershipId: Id;
}

export interface CorrectnessResult {
  findings: CorrectnessFinding[];
  aborted: boolean;
  abortReason?: string;
}

export class BenchmarkOperationError extends Error {
  readonly classification: FindingClassification;
  readonly code?: string;
  readonly status?: number;

  constructor(classification: FindingClassification, detail: { code?: string; status?: number } = {}) {
    super(detail.code || classification);
    this.name = "BenchmarkOperationError";
    this.classification = classification;
    this.code = detail.code;
    this.status = detail.status;
  }
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}

function isClosable(value: unknown): value is { close: () => Promise<void> } {
  return isRecord(value) && typeof value.close === "function";
}

function errorField(error: unknown, field: "code" | "status"): string | undefined {
  if (!isRecord(error)) return undefined;
  const value = error[field];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function safeStatus(error: unknown): string | undefined {
  const status = errorField(error, "status");
  return status && /^\d{3}$/.test(status) ? status : undefined;
}

export function classifyOperationError(error: unknown): FindingClassification {
  if (error instanceof BenchmarkOperationError) return error.classification;
  if (errorField(error, "status") === "401") return "authentication";
  if (errorField(error, "status") === "403" || errorField(error, "status") === "404") return "authorization";
  if (errorField(error, "status") === "408" || errorField(error, "code") === "timeout") return "timeout";
  return "transport/sdk";
}

export async function expectRejected<T>(fn: () => Promise<T>, expectedClassification: FindingClassification): Promise<void> {
  try {
    const result = await fn();
    if (isClosable(result)) await result.close();
    throw new BenchmarkOperationError("invalid_response", { code: "unexpected_success" });
  } catch (error) {
    if (classifyOperationError(error) !== expectedClassification) throw error;
  }
}

async function expectListDenied<T>(fn: () => Promise<Page<T>>): Promise<void> {
  try {
    const page = await fn();
    assertPage<T>(page, () => undefined);
    if (page.items.length !== 0) invalid("unexpected_visible_records");
  } catch (error) {
    if (classifyOperationError(error) !== "authorization") throw error;
  }
}

const invalid = (code: string): never => {
  throw new BenchmarkOperationError("invalid_response", { code });
};

const requiredString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const taskStatuses = new Set(["todo", "in_progress", "done", "cancelled"]);
const taskPriorities = new Set(["low", "medium", "high", "urgent"]);
const membershipRoles = new Set(["owner", "admin", "member"]);

function assertUser(user: unknown): asserts user is User {
  if (!isRecord(user) || !requiredString(user.id) || !requiredString(user.email) || !requiredString(user.displayName) ||
      !requiredString(user.createdAt) || !requiredString(user.updatedAt)) invalid("profile_fields");
}

function assertTask(task: unknown, expected?: { id?: Id; projectId?: Id; creatorId?: Id; createdAt?: string }): asserts task is Task {
  if (!isRecord(task) || !requiredString(task.id) || !requiredString(task.projectId) || !requiredString(task.creatorId) ||
      !requiredString(task.title) || !requiredString(task.description) || typeof task.status !== "string" || !taskStatuses.has(task.status) ||
      typeof task.priority !== "string" || !taskPriorities.has(task.priority) || (task.assigneeId !== null && !requiredString(task.assigneeId)) ||
      (task.dueDate !== null && !requiredString(task.dueDate)) || !requiredString(task.createdAt) || !requiredString(task.updatedAt) ||
      (expected?.id !== undefined && task.id !== expected.id) || (expected?.projectId !== undefined && task.projectId !== expected.projectId) ||
      (expected?.creatorId !== undefined && task.creatorId !== expected.creatorId) ||
      (expected?.createdAt !== undefined && task.createdAt !== expected.createdAt)) invalid("task_fields");
}

function assertComment(comment: unknown, expected?: { id?: Id; taskId?: Id; authorId?: Id; body?: string; createdAt?: string }): asserts comment is Comment {
  if (!isRecord(comment) || !requiredString(comment.id) || !requiredString(comment.taskId) || !requiredString(comment.authorId) ||
      !requiredString(comment.body) || !requiredString(comment.createdAt) || !requiredString(comment.updatedAt) ||
      (expected?.id !== undefined && comment.id !== expected.id) || (expected?.taskId !== undefined && comment.taskId !== expected.taskId) ||
      (expected?.authorId !== undefined && comment.authorId !== expected.authorId) || (expected?.body !== undefined && comment.body !== expected.body) ||
      (expected?.createdAt !== undefined && comment.createdAt !== expected.createdAt)) invalid("comment_fields");
}

function sameComment(left: Comment, right: Comment): boolean {
  return left.id === right.id && left.taskId === right.taskId && left.authorId === right.authorId &&
    left.body === right.body && left.createdAt === right.createdAt && left.updatedAt === right.updatedAt;
}

function assertMembership(membership: unknown, expected: { id?: Id; organizationId?: Id; userId?: Id; role?: Membership["role"] } = {}): asserts membership is Membership {
  if (!isRecord(membership) || !requiredString(membership.id) || !requiredString(membership.organizationId) || !requiredString(membership.userId) ||
      typeof membership.role !== "string" || !membershipRoles.has(membership.role) || !requiredString(membership.createdAt) ||
      (expected.id !== undefined && membership.id !== expected.id) || (expected.organizationId !== undefined && membership.organizationId !== expected.organizationId) ||
      (expected.userId !== undefined && membership.userId !== expected.userId) || (expected.role !== undefined && membership.role !== expected.role)) invalid("membership_fields");
}

function integerValue(value: unknown, code: string): number {
  return typeof value === "number" && Number.isInteger(value) ? value : invalid(code);
}

function arrayValue(value: unknown, code: string): unknown[] {
  return Array.isArray(value) ? value : invalid(code);
}

function assertPage<T>(page: unknown, validateItem: (item: unknown) => void): asserts page is Page<T> {
  const record = isRecord(page) ? page : invalid("page_fields");
  const items = arrayValue(record.items, "page_fields");
  const pageNumber = integerValue(record.page, "page_fields");
  const pageSize = integerValue(record.pageSize, "page_fields");
  const total = integerValue(record.total, "page_fields");
  if (pageNumber < 0 || pageSize <= 0 || total < 0 || typeof record.hasNext !== "boolean" || items.length > pageSize || items.length > total ||
      record.hasNext !== (pageNumber + 1) * pageSize < total) invalid("page_fields");
  for (const item of items) validateItem(item);
}

function itemId(item: unknown): Id {
  return isRecord(item) && requiredString(item.id) ? item.id : invalid("page_item_id");
}

const maxCorrectnessPages = 100;

async function collectPages<T>(fetchPage: (page: number, pageSize: number) => Promise<Page<T>>, pageSize: number, validateItem: (item: unknown) => void): Promise<T[]> {
  const collected: T[] = [];
  const seen = new Set<Id>();
  let total: number | undefined;
  for (let pageNumber = 0; pageNumber < maxCorrectnessPages; pageNumber++) {
    const page = await fetchPage(pageNumber, pageSize);
    assertPage<T>(page, validateItem);
    if (total === undefined) total = page.total;
    if (page.total !== total || page.page !== pageNumber || page.pageSize !== pageSize) invalid("page_sequence");
    for (const item of page.items) {
      const id = itemId(item);
      if (seen.has(id)) invalid("page_duplicates");
      seen.add(id);
      collected.push(item);
    }
    if (!page.hasNext) {
      if (collected.length !== page.total) invalid("page_total");
      return collected;
    }
  }
  return invalid("page_limit");
}

async function collectStablePages<T>(fetchPage: (page: number, pageSize: number) => Promise<Page<T>>, pageSize: number, validateItem: (item: unknown) => void): Promise<T[]> {
  const first = await collectPages(fetchPage, pageSize, validateItem);
  const repeat = await collectPages(fetchPage, pageSize, validateItem);
  if (first.length !== repeat.length || first.some((item, index) => itemId(item) !== itemId(repeat[index]))) invalid("page_order");
  return first;
}

function assertTaskDetail(detail: unknown, taskId: Id, projectId: Id): asserts detail is TaskDetail {
  const record = isRecord(detail) ? detail : invalid("task_detail_fields");
  const task = isRecord(record.task) ? record.task : invalid("task_detail_fields");
  const creator = isRecord(record.creator) ? record.creator : invalid("task_detail_fields");
  const comments = isRecord(record.comments) ? record.comments : invalid("task_detail_fields");
  assertTask(task, { id: taskId, projectId });
  assertUser(creator);
  if (creator.id !== task.creatorId) invalid("task_creator");
  if (task.assigneeId === null) {
    if (record.assignee !== null) invalid("task_assignee");
  } else {
    assertUser(record.assignee);
    if (record.assignee.id !== task.assigneeId) invalid("task_assignee");
  }
  assertPage<Comment>(comments, (comment) => assertComment(comment, { taskId }));
}

function requireSession(session: AppSession | undefined, name: string): AppSession {
  return session || invalid(`${name}_session`);
}

async function closeSession(session: AppSession | undefined): Promise<boolean> {
  if (!session) return true;
  try {
    await session.close();
    return true;
  } catch {
    return false;
  }
}

export async function runCorrectness(backend: Backend, fixture: CorrectnessFixture): Promise<CorrectnessResult> {
  const findings: CorrectnessFinding[] = [];
  let aborted = false;
  let abortReason: string | undefined;
  let owner: AppSession | undefined;
  let admin: AppSession | undefined;
  let member: AppSession | undefined;
  let outsider: AppSession | undefined;
  let invalidLogin: AppSession | undefined;
  let setupTaskId: Id | undefined;
  let setupCommentId: Id | undefined;
  let setupCommentTaskId: Id | undefined;

  const add = async (name: string, work: () => Promise<void>): Promise<void> => {
    if (aborted) return;
    try {
      await work();
      findings.push({ name, passed: true, classification: "application", message: "passed" });
    } catch (error) {
      const classification = classifyOperationError(error);
      findings.push({
        name,
        passed: false,
        classification,
        message: "check failed",
        evidence: safeStatus(error) ? `status:${safeStatus(error)}` : undefined,
      });
      if (classification === "backend_health") {
        aborted = true;
        abortReason = "backend health lost";
      }
    }
  };

  try {
    await add("valid-sign-in", async () => {
      const session = await backend.createSession(fixture.owner);
      owner = session;
      const profile = await session.getProfile();
      assertUser(profile);
    });
    await add("invalid-sign-in", async () => {
      try {
        invalidLogin = await backend.createSession({ email: fixture.owner.email, password: "invalid" });
        throw new BenchmarkOperationError("invalid_response", { code: "accepted_invalid_password" });
      } catch (error) {
        if (classifyOperationError(error) !== "authentication") throw error;
      } finally {
        if (await closeSession(invalidLogin)) invalidLogin = undefined;
      }
    });
    if (aborted) return { findings, aborted, abortReason };

    await add("profile-read-update", async () => {
      const session = requireSession(owner, "owner");
      const profile = await session.getProfile();
      assertUser(profile);
      const updated = await session.updateProfile({ displayName: "Owner checked" });
      assertUser(updated);
      if (updated.id !== profile.id || updated.displayName !== "Owner checked") invalid("profile_update");
    });

    await add("task-crud-pagination", async () => {
      const session = requireSession(owner, "owner");
      const created = await session.createTask({
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        title: "check",
        description: "check",
        priority: "low",
      });
      const profile = await session.getProfile();
      assertUser(profile);
      assertTask(created, { id: created.id, projectId: fixture.projectId, creatorId: profile.id });
      setupTaskId = created.id;

      const taskId = fixture.taskId || "task-1";
      const seededDetail = await session.getTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId, comments: { page: 0, pageSize: 10 } });
      assertTaskDetail(seededDetail, taskId, fixture.projectId);
      const createdDetail = await session.getTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId: created.id, comments: { page: 0, pageSize: 10 } });
      assertTaskDetail(createdDetail, created.id, fixture.projectId);

      const updated = await session.updateTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId: created.id, title: "updated" });
      assertTask(updated, { id: created.id, projectId: created.projectId, creatorId: created.creatorId, createdAt: created.createdAt });
      if (updated.title !== "updated") invalid("update_return");

      const fetchTasks = (page: number, pageSize: number) => session.listTasks({ organizationId: fixture.organizationId, projectId: fixture.projectId, page, pageSize });
      const allTasks = await collectStablePages(fetchTasks, 1, (task) => assertTask(task, { projectId: fixture.projectId }));
      const first = await fetchTasks(0, 1);
      const second = await fetchTasks(1, 1);
      const combined = await fetchTasks(0, 2);
      assertPage<Task>(first, (task) => assertTask(task, { projectId: fixture.projectId }));
      assertPage<Task>(second, (task) => assertTask(task, { projectId: fixture.projectId }));
      assertPage<Task>(combined, (task) => assertTask(task, { projectId: fixture.projectId }));
      const splitIds = [...first.items, ...second.items].map((task) => task.id);
      const combinedIds = combined.items.map((task) => task.id);
      if (splitIds.length !== combinedIds.length || splitIds.some((id, index) => id !== combinedIds[index]) ||
          allTasks.slice(0, combined.items.length).some((task, index) => task.id !== combinedIds[index])) invalid("pagination_order");

      const done = await session.listTasks({ organizationId: fixture.organizationId, projectId: fixture.projectId, status: "done", page: 0, pageSize: 10 });
      assertPage<Task>(done, (task) => assertTask(task, { projectId: fixture.projectId }));
      if (done.items.some((task) => task.status !== "done")) invalid("pagination_status_filter");
      const unassigned = await session.listTasks({ organizationId: fixture.organizationId, projectId: fixture.projectId, assigneeId: null, page: 0, pageSize: 10 });
      assertPage<Task>(unassigned, (task) => assertTask(task, { projectId: fixture.projectId }));
      if (unassigned.items.some((task) => task.assigneeId !== null)) invalid("pagination_assignee_filter");
      if (seededDetail.task.assigneeId !== null) {
        const assigned = await session.listTasks({ organizationId: fixture.organizationId, projectId: fixture.projectId, assigneeId: seededDetail.task.assigneeId, page: 0, pageSize: 10 });
        assertPage<Task>(assigned, (task) => assertTask(task, { projectId: fixture.projectId }));
        if (assigned.items.some((task) => task.assigneeId !== seededDetail.task.assigneeId)) invalid("pagination_assignee_filter");
      }
    });

    await add("comments-crud-pagination", async () => {
      const session = requireSession(owner, "owner");
      const taskId = fixture.taskId || "task-1";
      const profile = await session.getProfile();
      assertUser(profile);
      const fetchComments = async (page: number, pageSize: number): Promise<Page<Comment>> => {
        const detail = await session.getTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId, comments: { page, pageSize } });
        assertTaskDetail(detail, taskId, fixture.projectId);
        return detail.comments;
      };
      const baselineComments = (await collectStablePages(fetchComments, 1, (comment) => assertComment(comment, { taskId })))
        .map((comment) => ({ ...comment }));
      const createdComments: Comment[] = [];
      for (const body of ["check-0", "check-1", "check-2"]) {
        const created = await session.addComment({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId, body });
        assertComment(created, { taskId, authorId: profile.id, body });
        createdComments.push(created);
      }
      const middle = createdComments[1] || invalid("comment_fields");
      const updated = await session.updateComment({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId, commentId: middle.id, body: "updated" });
      assertComment(updated, { id: middle.id, taskId, authorId: middle.authorId, body: "updated", createdAt: middle.createdAt });
      setupCommentId = updated.id;
      setupCommentTaskId = taskId;
      const allComments = await collectStablePages(fetchComments, 1, (comment) => assertComment(comment, { taskId }));
      if (allComments.length < baselineComments.length + createdComments.length ||
          baselineComments.some((comment) => {
            const returned = allComments.find((item) => item.id === comment.id);
            return !returned || !sameComment(returned, comment);
          })) invalid("comment_order");
      for (const [index, created] of createdComments.entries()) {
        const returned = allComments.find((comment) => comment.id === created.id);
        if (!returned || returned.taskId !== taskId || returned.authorId !== profile.id ||
            returned.body !== (index === 1 ? "updated" : `check-${index}`)) invalid("comment_semantics");
      }
    });

    await add("member-tenant-access", async () => {
      const session = await backend.createSession(fixture.member);
      member = session;
      const profile = await session.getProfile();
      assertUser(profile);
      const tasks = await session.listTasks({ organizationId: fixture.organizationId, projectId: fixture.projectId, page: 0, pageSize: 10 });
      assertPage<Task>(tasks, (task) => assertTask(task, { projectId: fixture.projectId }));
    });
    await add("outsider-read-isolated", async () => {
      const session = await backend.createSession(fixture.outsider);
      outsider = session;
      await expectListDenied(() => session.listTasks({ organizationId: fixture.organizationId, projectId: fixture.projectId, page: 0, pageSize: 10 }));
    });
    await add("outsider-comment-read-isolated", async () => {
      const session = requireSession(outsider, "outsider");
      await expectRejected(() => session.getTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId: fixture.taskId || "task-1", comments: { page: 0, pageSize: 10 } }), "authorization");
    });
    await add("outsider-write-isolated", async () => {
      const session = requireSession(outsider, "outsider");
      await expectRejected(() => session.createTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, title: "x", description: "x", priority: "low" }), "authorization");
      const taskId = setupTaskId;
      if (taskId) {
        await expectRejected(() => session.updateTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId, title: "outsider update" }), "authorization");
      }
    });
    await add("outsider-comment-write-isolated", async () => {
      const session = requireSession(outsider, "outsider");
      await expectRejected(() => session.addComment({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId: fixture.taskId || "task-1", body: "x" }), "authorization");
      const commentId = setupCommentId;
      const commentTaskId = setupCommentTaskId;
      if (commentId && commentTaskId) {
        await expectRejected(() => session.updateComment({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId: commentTaskId, commentId, body: "outsider update" }), "authorization");
      }
    });
    await add("member-role-denied", async () => {
      const session = requireSession(member, "member");
      await expectRejected(() => session.updateMembershipRole({ organizationId: fixture.organizationId, membershipId: fixture.memberMembershipId, role: "admin" }), "authorization");
    });
    await add("owner-role-restore", async () => {
      const session = requireSession(owner, "owner");
      const before = await session.updateMembershipRole({ organizationId: fixture.organizationId, membershipId: fixture.memberMembershipId, role: "admin" });
      assertMembership(before, { id: fixture.memberMembershipId, organizationId: fixture.organizationId, userId: fixture.memberUserId || before.userId, role: "admin" });
      const restored = await session.updateMembershipRole({ organizationId: fixture.organizationId, membershipId: fixture.memberMembershipId, role: "member" });
      assertMembership(restored, { id: before.id, organizationId: before.organizationId, userId: fixture.memberUserId || before.userId, role: "member" });
    });
    await add("admin-role-restore", async () => {
      const session = await backend.createSession(fixture.admin);
      admin = session;
      const profile = await session.getProfile();
      assertUser(profile);
      const ownerSession = requireSession(owner, "owner");
      const ownerProfile = await ownerSession.getProfile();
      assertUser(ownerProfile);
      if (profile.id === ownerProfile.id) invalid("admin_identity");
      const before = await session.updateMembershipRole({ organizationId: fixture.organizationId, membershipId: fixture.memberMembershipId, role: "admin" });
      assertMembership(before, { id: fixture.memberMembershipId, organizationId: fixture.organizationId, userId: fixture.memberUserId || before.userId, role: "admin" });
      const restored = await session.updateMembershipRole({ organizationId: fixture.organizationId, membershipId: fixture.memberMembershipId, role: "member" });
      assertMembership(restored, { id: before.id, organizationId: fixture.organizationId, userId: fixture.memberUserId || before.userId, role: "member" });
    });
    await add("refresh-signout", async () => {
      const session = requireSession(owner, "owner");
      await session.refreshSession();
      await session.signOut();
      await expectRejected(() => session.getProfile(), "authentication");
    });
    await add("required-data", async () => {
      if (!fixture.organizationId || !fixture.projectId || !fixture.memberMembershipId || !fixture.adminMembershipId ||
          fixture.adminMembershipId === fixture.ownerMembershipId || fixture.adminMembershipId === fixture.memberMembershipId) invalid("fixture_ids");
    });
  } catch (error) {
    aborted = true;
    abortReason = "correctness run aborted";
  } finally {
    await Promise.all([owner, admin, member, outsider, invalidLogin].map(closeSession));
  }

  return { findings, aborted, abortReason };
}
