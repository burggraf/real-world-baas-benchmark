import type { Backend, AppSession, BackendInfo } from "../src/backend.js";
import type { Comment, Credentials, DatasetProfile, Membership, Organization, Page, Project, Task, TaskDetail, User } from "../src/domain.js";
import { BenchmarkOperationError } from "../src/correctness.js";

export interface FakeFixture {
  owner: Credentials;
  admin: Credentials;
  member: Credentials;
  outsider: Credentials;
  organizationId: string;
  projectId: string;
  taskId: string;
  ownerMembershipId: string;
  memberMembershipId: string;
  foreignMembershipId: string;
  foreignProjectId: string;
  otherProjectId: string;
}

export interface FakeOptions {
  insecureTenantIsolation?: boolean;
  acceptInvalidLogin?: boolean;
  malformedPage?: boolean;
  leakError?: "normal" | "health";
  failures?: Partial<Record<"authentication" | "timeout" | "malformed" | "application" | "backend_health", number>>;
}

type FakeBackend = Backend & {
  fixture: FakeFixture;
  sessions: number;
  closedSessions: number;
};
type FailureKind = "authentication" | "timeout" | "malformed" | "application" | "backend_health";

const now = "2026-01-01T00:00:00.000Z";

export function createFakeBackend(options: FakeOptions = {}): FakeBackend {
  const users: User[] = ["owner", "member", "outsider"].map((name) => ({
    id: `u-${name}`,
    email: `${name}@example.test`,
    displayName: name,
    createdAt: now,
    updatedAt: now,
  }));
  const organization: Organization = { id: "org-1", name: "Example", ownerId: "u-owner", createdAt: now };
  const project: Project = { id: "project-1", organizationId: organization.id, name: "Project", status: "active", createdAt: now, updatedAt: now };
  const otherProject: Project = { id: "project-2", organizationId: organization.id, name: "Other", status: "active", createdAt: now, updatedAt: now };
  const foreignProject: Project = { id: "project-foreign", organizationId: "org-foreign", name: "Foreign", status: "active", createdAt: now, updatedAt: now };
  const projects = [project, otherProject, foreignProject];
  const tasks: Task[] = [{
    id: "task-1",
    projectId: project.id,
    creatorId: "u-owner",
    assigneeId: "u-member",
    title: "Seed task",
    description: "seed",
    status: "todo",
    priority: "medium",
    dueDate: null,
    createdAt: now,
    updatedAt: now,
  }];
  const comments: Comment[] = [];
  const memberships: Membership[] = [
    { id: "membership-owner", organizationId: organization.id, userId: "u-owner", role: "owner", createdAt: now },
    { id: "membership-member", organizationId: organization.id, userId: "u-member", role: "member", createdAt: now },
    { id: "membership-foreign", organizationId: "org-foreign", userId: "u-owner", role: "member", createdAt: now },
  ];
  let health = true;
  let sessions = 0;
  let closedSessions = 0;
  const remaining = { ...(options.failures || {}) };
  const fixture: FakeFixture = {
    owner: { email: "owner@example.test", password: "owner-pass" },
    admin: { email: "owner@example.test", password: "owner-pass" },
    member: { email: "member@example.test", password: "member-pass" },
    outsider: { email: "outsider@example.test", password: "outsider-pass" },
    organizationId: organization.id,
    projectId: project.id,
    taskId: tasks[0]!.id,
    ownerMembershipId: memberships[0]!.id,
    memberMembershipId: memberships[1]!.id,
    foreignMembershipId: memberships[2]!.id,
    foreignProjectId: foreignProject.id,
    otherProjectId: otherProject.id,
  };

  const fail = (kind: FailureKind): void => {
    if (options.leakError === "health" && kind === "backend_health") {
      throw new BenchmarkOperationError("backend_health", { code: `backend-${fixture.owner.password}` });
    }
    if (remaining[kind]) {
      remaining[kind]!--;
      if (options.leakError === "normal" && kind === "application") {
        throw new BenchmarkOperationError("application", { code: `backend-${fixture.owner.password}` });
      }
      throw new BenchmarkOperationError(kind === "malformed" ? "invalid_response" : kind, { code: kind });
    }
  };

  const createSession = (credentials: Credentials): AppSession => {
    fail("authentication");
    const user = users.find((candidate) => candidate.email === credentials.email);
    if (!user || (!options.acceptInvalidLogin && credentials.password !== `${user.email.split("@")[0]}-pass`)) {
      throw new BenchmarkOperationError("authentication", { code: "invalid_credentials" });
    }
    let active = true;
    sessions++;

    const check = (_write = false, organizationId = organization.id): Membership | undefined => {
      fail("backend_health");
      if (!health) throw new BenchmarkOperationError("backend_health", { code: "unhealthy" });
      if (!active) throw new BenchmarkOperationError("authentication", { code: "signed_out" });
      const membership = memberships.find((candidate) => candidate.userId === user.id && candidate.organizationId === organizationId);
      if (!membership && !options.insecureTenantIsolation) throw new BenchmarkOperationError("authorization", { code: "tenant_denied" });
      return membership;
    };
    const checkProject = (organizationId: string, projectId: string): Project => {
      check(false, organizationId);
      const target = projects.find((candidate) => candidate.id === projectId);
      if (!target || target.organizationId !== organizationId) {
        throw new BenchmarkOperationError("authorization", { code: "project_tenant_denied" });
      }
      return target;
    };
    const checkTaskProject = (taskId: string, projectId: string): Task => {
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new BenchmarkOperationError("application", { code: "not_found" });
      if (task.projectId !== projectId) throw new BenchmarkOperationError("authorization", { code: "task_project_denied" });
      return task;
    };
    const page = <T>(items: T[], pagination: { page: number; pageSize: number }): Page<T> => ({
      items: items.slice(pagination.page * pagination.pageSize, (pagination.page + 1) * pagination.pageSize),
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: items.length,
      hasNext: (pagination.page + 1) * pagination.pageSize < items.length,
    });

    return {
      dashboard: async (input) => {
        checkProject(input.organizationId, input.projectId);
        return { organization, projects: projects.filter((candidate) => candidate.organizationId === input.organizationId), recentActivity: [] };
      },
      listTasks: async (input) => {
        checkProject(input.organizationId, input.projectId);
        const result = page(tasks.filter((task) => task.projectId === input.projectId &&
          (!input.status || task.status === input.status) &&
          (input.assigneeId === undefined || task.assigneeId === input.assigneeId)), input);
        if (options.malformedPage) {
          // ponytail: malformed fixture data is intentionally localized to this simulation.
          return { ...result, items: [{} as Task] };
        }
        return result;
      },
      getTask: async (input): Promise<TaskDetail> => {
        checkProject(input.organizationId, input.projectId);
        const task = checkTaskProject(input.taskId, input.projectId);
        const creator = users.find((candidate) => candidate.id === task.creatorId);
        if (!creator) throw new BenchmarkOperationError("application", { code: "missing_creator" });
        return {
          task,
          creator,
          assignee: task.assigneeId ? users.find((candidate) => candidate.id === task.assigneeId) || null : null,
          comments: page(comments.filter((comment) => comment.taskId === task.id), input.comments),
        };
      },
      createTask: async (input) => {
        checkProject(input.organizationId, input.projectId);
        const membership = check(true, input.organizationId);
        if (!membership) throw new BenchmarkOperationError("authorization", { code: "tenant_denied" });
        const task: Task = {
          id: `task-${tasks.length + 1}`,
          projectId: input.projectId,
          creatorId: user.id,
          assigneeId: input.assigneeId || null,
          title: input.title,
          description: input.description,
          status: "todo",
          priority: input.priority,
          dueDate: input.dueDate || null,
          createdAt: now,
          updatedAt: now,
        };
        tasks.push(task);
        return task;
      },
      updateTask: async (input) => {
        checkProject(input.organizationId, input.projectId);
        const task = checkTaskProject(input.taskId, input.projectId);
        if (input.status !== undefined) task.status = input.status;
        if (input.priority !== undefined) task.priority = input.priority;
        if (input.assigneeId !== undefined) task.assigneeId = input.assigneeId;
        if (input.dueDate !== undefined) task.dueDate = input.dueDate;
        if (input.title !== undefined) task.title = input.title;
        if (input.description !== undefined) task.description = input.description;
        task.updatedAt = now;
        return task;
      },
      addComment: async (input) => {
        checkProject(input.organizationId, input.projectId);
        checkTaskProject(input.taskId, input.projectId);
        check(true, input.organizationId);
        const comment: Comment = { id: `comment-${comments.length + 1}`, taskId: input.taskId, authorId: user.id, body: input.body, createdAt: now, updatedAt: now };
        comments.push(comment);
        return comment;
      },
      updateComment: async (input) => {
        checkProject(input.organizationId, input.projectId);
        checkTaskProject(input.taskId, input.projectId);
        check(true, input.organizationId);
        const comment = comments.find((candidate) => candidate.id === input.commentId);
        if (!comment) throw new BenchmarkOperationError("application", { code: "not_found" });
        if (comment.taskId !== input.taskId) throw new BenchmarkOperationError("authorization", { code: "task_mismatch" });
        comment.body = input.body;
        comment.updatedAt = now;
        return comment;
      },
      updateMembershipRole: async (input) => {
        const membership = check(true, input.organizationId);
        if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
          throw new BenchmarkOperationError("authorization", { code: "role_denied" });
        }
        const target = memberships.find((candidate) => candidate.id === input.membershipId);
        if (!target) throw new BenchmarkOperationError("application", { code: "not_found" });
        if (target.organizationId !== input.organizationId) throw new BenchmarkOperationError("authorization", { code: "tenant_denied" });
        target.role = input.role;
        return target;
      },
      searchTasks: async (input) => {
        checkProject(input.organizationId, input.projectId);
        return page(tasks.filter((task) => task.projectId === input.projectId), input);
      },
      getProfile: async () => {
        check();
        fail("timeout");
        fail("application");
        if (remaining.malformed) {
          remaining.malformed!--;
          // ponytail: malformed fixture data is intentionally localized to this simulation.
          return {} as User;
        }
        return user;
      },
      updateProfile: async (input) => {
        check(true);
        user.displayName = input.displayName;
        user.updatedAt = now;
        return user;
      },
      refreshSession: async () => {
        check();
      },
      signOut: async () => {
        check();
        active = false;
      },
      close: async () => {
        if (active) active = false;
        closedSessions++;
      },
    };
  };

  const backend = {
    name: "pocketbase" as const,
    doctor: async (): Promise<BackendInfo> => ({ name: "pocketbase", version: "fake", endpoint: "fake" }),
    start: async () => { health = true; },
    reset: async () => {},
    seed: async (_profile: DatasetProfile, _seed: number) => {},
    createSession: async (credentials: Credentials) => createSession(credentials),
    stop: async () => { health = false; },
    fixture,
    sessions,
    closedSessions,
  } as FakeBackend;
  Object.defineProperties(backend, {
    sessions: { get: () => sessions },
    closedSessions: { get: () => closedSessions },
  });
  return backend;
}

export const fakeFixture = (backend: FakeBackend): FakeFixture => backend.fixture;
