import type { Backend, AppSession } from "./backend.js";
import type { Comment, Credentials, Id, Membership, Task, TaskDetail } from "./domain.js";
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
  adminMembershipId?: Id;
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

export function classifyOperationError(error: unknown): FindingClassification {
  if (error instanceof BenchmarkOperationError) return error.classification;
  if (errorField(error, "status") === "401") return "authentication";
  if (errorField(error, "status") === "403") return "authorization";
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

const invalid = (code: string): never => {
  throw new BenchmarkOperationError("invalid_response", { code });
};

const requiredString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function assertTask(task: Task, expected: { id: Id; projectId: Id; creatorId?: Id; createdAt?: string }): void {
  if (!isRecord(task) || !requiredString(task.id) || !requiredString(task.projectId) || !requiredString(task.creatorId) ||
      !requiredString(task.createdAt) || !requiredString(task.updatedAt) || !requiredString(task.title) ||
      (task.assigneeId !== null && !requiredString(task.assigneeId)) || task.id !== expected.id ||
      task.projectId !== expected.projectId || (expected.creatorId !== undefined && task.creatorId !== expected.creatorId) ||
      (expected.createdAt !== undefined && task.createdAt !== expected.createdAt)) {
    invalid("task_fields");
  }
}

function assertTaskDetail(detail: TaskDetail, taskId: Id, projectId: Id): void {
  if (!isRecord(detail) || !isRecord(detail.task) || !isRecord(detail.creator) || !isRecord(detail.comments)) invalid("task_detail_fields");
  assertTask(detail.task, { id: taskId, projectId: projectId });
  if (!requiredString(detail.creator.id) || detail.creator.id !== detail.task.creatorId) invalid("task_creator");
  if (detail.task.assigneeId === null) {
    if (detail.assignee !== null) invalid("task_assignee");
  } else if (detail.assignee?.id !== detail.task.assigneeId) {
    invalid("task_assignee");
  }
  if (detail.comments.page < 0 || detail.comments.pageSize <= 0 || detail.comments.total < 0) invalid("task_comments");
}

function assertComment(comment: Comment, expected: { id?: Id; taskId: Id; authorId?: Id; body?: string; createdAt?: string }): void {
  if (!isRecord(comment) || !requiredString(comment.id) || !requiredString(comment.taskId) || !requiredString(comment.authorId) ||
      !requiredString(comment.createdAt) || !requiredString(comment.updatedAt) || comment.taskId !== expected.taskId ||
      (expected.id !== undefined && comment.id !== expected.id) ||
      (expected.authorId !== undefined && comment.authorId !== expected.authorId) ||
      (expected.body !== undefined && comment.body !== expected.body) ||
      (expected.createdAt !== undefined && comment.createdAt !== expected.createdAt)) {
    invalid("comment_fields");
  }
}

function assertMembership(membership: Membership, expected: { id: Id; organizationId: Id; userId: Id; role: Membership["role"] }): void {
  if (!isRecord(membership) || !requiredString(membership.id) || !requiredString(membership.organizationId) ||
      !requiredString(membership.userId) || !requiredString(membership.createdAt) || membership.id !== expected.id || membership.organizationId !== expected.organizationId ||
      membership.userId !== expected.userId || membership.role !== expected.role) {
    invalid("membership_fields");
  }
}

function requireSession(session: AppSession | undefined, name: string): AppSession {
  return session || invalid(`${name}_session`);
}

export async function runCorrectness(backend: Backend, fixture: CorrectnessFixture): Promise<CorrectnessResult> {
  const findings: CorrectnessFinding[] = [];
  let aborted = false;
  let abortReason: string | undefined;
  let owner: AppSession | undefined;
  let admin: AppSession | undefined;
  let member: AppSession | undefined;
  let outsider: AppSession | undefined;

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
        evidence: errorField(error, "code") || errorField(error, "status"),
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
      if (!isRecord(profile) || !requiredString(profile.id) || !requiredString(profile.email) || !requiredString(profile.createdAt) || !requiredString(profile.updatedAt)) {
        invalid("profile_fields");
      }
    });
    await add("invalid-sign-in", async () => {
      let invalidSession: AppSession | undefined;
      try {
        invalidSession = await backend.createSession({ email: fixture.owner.email, password: "invalid" });
        throw new BenchmarkOperationError("invalid_response", { code: "accepted_invalid_password" });
      } catch (error) {
        if (classifyOperationError(error) !== "authentication") throw error;
      } finally {
        await invalidSession?.close();
      }
    });
    if (aborted) return { findings, aborted, abortReason };

    await add("profile-read-update", async () => {
      const session = requireSession(owner, "owner");
      const profile = await session.getProfile();
      if (!isRecord(profile) || !requiredString(profile.id) || !requiredString(profile.email) || !requiredString(profile.createdAt) || !requiredString(profile.updatedAt)) {
        invalid("profile_fields");
      }
      const updated = await session.updateProfile({ displayName: "Owner checked" });
      if (updated.id !== profile.id || updated.displayName !== "Owner checked" ||
          !requiredString(updated.email) || !requiredString(updated.createdAt) || !requiredString(updated.updatedAt)) {
        invalid("profile_update");
      }
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
      assertTask(created, { id: created.id, projectId: fixture.projectId, creatorId: (await session.getProfile()).id });

      const taskId = fixture.taskId || "task-1";
      const seededDetail = await session.getTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId, comments: { page: 0, pageSize: 10 } });
      assertTaskDetail(seededDetail, taskId, fixture.projectId);
      const createdDetail = await session.getTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId: created.id, comments: { page: 0, pageSize: 10 } });
      assertTaskDetail(createdDetail, created.id, fixture.projectId);

      const updated = await session.updateTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId: created.id, title: "updated" });
      assertTask(updated, { id: created.id, projectId: created.projectId, creatorId: created.creatorId, createdAt: created.createdAt });
      if (updated.title !== "updated") invalid("update_return");

      const first = await session.listTasks({ organizationId: fixture.organizationId, projectId: fixture.projectId, page: 0, pageSize: 1 });
      const second = await session.listTasks({ organizationId: fixture.organizationId, projectId: fixture.projectId, page: 1, pageSize: 1 });
      const combined = await session.listTasks({ organizationId: fixture.organizationId, projectId: fixture.projectId, page: 0, pageSize: 2 });
      const repeat = await session.listTasks({ organizationId: fixture.organizationId, projectId: fixture.projectId, page: 0, pageSize: 2 });
      const firstPageIds = [...first.items, ...second.items].map((task) => task.id);
      const combinedIds = combined.items.map((task) => task.id);
      if (first.page !== 0 || first.pageSize !== 1 || first.total < first.items.length ||
          first.hasNext !== (first.total > 1) || second.page !== 1 || new Set(firstPageIds).size !== firstPageIds.length ||
          firstPageIds.length !== combinedIds.length || firstPageIds.some((id, index) => id !== combinedIds[index]) ||
          combinedIds.length !== repeat.items.length || combinedIds.some((id, index) => id !== repeat.items[index]?.id) || combined.total !== first.total) {
        invalid("pagination_order");
      }

      const done = await session.listTasks({ organizationId: fixture.organizationId, projectId: fixture.projectId, status: "done", page: 0, pageSize: 10 });
      if (done.items.some((task) => task.status !== "done") || done.total !== done.items.length) invalid("pagination_status_filter");
      if (seededDetail.task.assigneeId !== null) {
        const assigned = await session.listTasks({ organizationId: fixture.organizationId, projectId: fixture.projectId, assigneeId: seededDetail.task.assigneeId, page: 0, pageSize: 10 });
        if (assigned.items.some((task) => task.assigneeId !== seededDetail.task.assigneeId)) invalid("pagination_assignee_filter");
      }
    });

    await add("comments-crud-pagination", async () => {
      const session = requireSession(owner, "owner");
      const taskId = fixture.taskId || "task-1";
      const profile = await session.getProfile();
      const created = await session.addComment({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId, body: "check" });
      assertComment(created, { taskId, authorId: profile.id, body: "check" });
      const updated = await session.updateComment({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId, commentId: created.id, body: "updated" });
      assertComment(updated, { id: created.id, taskId, authorId: created.authorId, body: "updated", createdAt: created.createdAt });
      const detail = await session.getTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId, comments: { page: 0, pageSize: 10 } });
      assertTaskDetail(detail, taskId, fixture.projectId);
      if (!detail.comments.items.some((comment) => comment.id === updated.id && comment.body === "updated")) invalid("comment_missing");
    });

    await add("member-tenant-access", async () => {
      const session = await backend.createSession(fixture.member);
      member = session;
      await session.getProfile();
      await session.listTasks({ organizationId: fixture.organizationId, projectId: fixture.projectId, page: 0, pageSize: 10 });
    });
    await add("outsider-read-isolated", async () => {
      const session = await backend.createSession(fixture.outsider);
      outsider = session;
      await expectRejected(() => session.listTasks({ organizationId: fixture.organizationId, projectId: fixture.projectId, page: 0, pageSize: 10 }), "authorization");
    });
    await add("outsider-comment-read-isolated", async () => {
      const session = requireSession(outsider, "outsider");
      await expectRejected(() => session.getTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId: fixture.taskId || "task-1", comments: { page: 0, pageSize: 10 } }), "authorization");
    });
    await add("outsider-write-isolated", async () => {
      const session = requireSession(outsider, "outsider");
      await expectRejected(() => session.createTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, title: "x", description: "x", priority: "low" }), "authorization");
    });
    await add("outsider-comment-write-isolated", async () => {
      const session = requireSession(outsider, "outsider");
      await expectRejected(() => session.addComment({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId: fixture.taskId || "task-1", body: "x" }), "authorization");
    });
    await add("member-role-denied", async () => {
      const session = requireSession(member, "member");
      await expectRejected(() => session.updateMembershipRole({ organizationId: fixture.organizationId, membershipId: fixture.memberMembershipId, role: "admin" }), "authorization");
    });
    await add("admin-role-restore", async () => {
      let session: AppSession;
      if (fixture.admin) {
        session = await backend.createSession(fixture.admin);
        admin = session;
      } else {
        session = requireSession(owner, "owner");
      }
      const before = await session.updateMembershipRole({ organizationId: fixture.organizationId, membershipId: fixture.memberMembershipId, role: "admin" });
      assertMembership(before, { id: fixture.memberMembershipId, organizationId: fixture.organizationId, userId: before.userId, role: "admin" });
      const restored = await session.updateMembershipRole({ organizationId: fixture.organizationId, membershipId: fixture.memberMembershipId, role: "member" });
      assertMembership(restored, { id: before.id, organizationId: before.organizationId, userId: before.userId, role: "member" });
    });
    await add("refresh-signout", async () => {
      const session = requireSession(owner, "owner");
      await session.refreshSession();
      await session.signOut();
      await expectRejected(() => session.getProfile(), "authentication");
    });
    await add("required-data", async () => {
      if (!fixture.organizationId || !fixture.projectId || !fixture.memberMembershipId) invalid("fixture_ids");
    });
  } catch (error) {
    aborted = true;
    abortReason = error instanceof Error ? error.message : String(error);
  } finally {
    await Promise.all([owner?.close(), admin?.close(), member?.close(), outsider?.close()]);
  }

  return { findings, aborted, abortReason };
}
