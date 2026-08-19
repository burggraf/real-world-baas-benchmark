import type { Activity, Comment, Id, Membership, Organization, Project, Role, Task, User } from "./domain.js";
import { mulberry32 } from "./random.js";

export type EntityName = "organization" | "user" | "membership" | "project" | "task" | "comment" | "activity";
export const datasetProfiles = Object.freeze({
  small: Object.freeze({ organizations: 100, users: 1_000, projects: 500, tasks: 10_000, comments: 30_000, activities: 20_000 }),
  medium: Object.freeze({ organizations: 1_000, users: 10_000, projects: 5_000, tasks: 100_000, comments: 300_000, activities: 200_000 }),
  large: Object.freeze({ organizations: 10_000, users: 100_000, projects: 50_000, tasks: 1_000_000, comments: 3_000_000, activities: 2_000_000 }),
} as const);
export type ProfileName = keyof typeof datasetProfiles;
export const PROFILES = datasetProfiles;
export const profiles = datasetProfiles;
type RecordType = Organization | User | Membership | Project | Task | Comment | Activity;
export interface SeedBatch { entity: EntityName; records: RecordType[]; }

const prefixes: Record<EntityName, string> = { organization: "org", user: "usr", membership: "mem", project: "prj", task: "tsk", comment: "cmt", activity: "act" };
const entities = Object.keys(prefixes) as EntityName[];
const counts = (profile: ProfileName) => ({ ...datasetProfiles[profile], memberships: datasetProfiles[profile].users });
function checkProfile(profile: string): asserts profile is ProfileName { if (!(profile in datasetProfiles)) throw new RangeError(`Invalid profile: ${profile}`); }
/** Stable ASCII IDs: a short entity prefix and an eight-digit base36 ordinal. */
export function entityId(entity: EntityName, profile: ProfileName, ordinal: number): Id {
  checkProfile(profile);
  if (!entities.includes(entity)) throw new RangeError(`Invalid entity: ${entity}`);
  const limit = counts(profile)[({ organization: "organizations", user: "users", membership: "memberships", project: "projects", task: "tasks", comment: "comments", activity: "activities" } as const)[entity]];
  if (!Number.isInteger(ordinal) || ordinal < 0 || (limit !== undefined && ordinal >= limit)) throw new RangeError("Invalid ordinal");
  return `${prefixes[entity]}-${ordinal.toString(36).padStart(8, "0")}`;
}
const timestamp = (n: number) => new Date(Date.UTC(2020, 0, 1) + n * 60_000).toISOString();
const text = (kind: string, ordinal: number, random: number) => {
  // ponytail: synthetic text is intentionally small; use a versioned corpus only if payload realism changes measured results.
  return `${kind} ${ordinal} ${Math.floor(random * 1_000_000).toString(36)}`;
};
const pick = <T>(values: readonly T[], random: number) => values[Math.floor(random * values.length)]!;

export async function* seedDataset(profile: ProfileName, seed: number, batchSize = 1_000): AsyncGenerator<SeedBatch> {
  checkProfile(profile);
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new RangeError("batchSize must be a positive integer");
  const c = counts(profile), random = mulberry32(seed);
  const emit = async function* <T extends RecordType>(entity: EntityName, total: number, make: (i: number) => T) {
    for (let start = 0; start < total; start += batchSize) {
      const records: T[] = [];
      for (let i = start; i < Math.min(start + batchSize, total); i++) records.push(make(i));
      yield { entity, records } as SeedBatch;
    }
  };
  for await (const b of emit("organization", c.organizations, i => ({ id: entityId("organization", profile, i), name: text("Organization", i, random()), ownerId: entityId("user", profile, i % c.users), createdAt: timestamp(i) }))) yield b;
  for await (const b of emit("user", c.users, i => ({ id: entityId("user", profile, i), email: `user${i}-${Math.floor(random() * 1_000_000).toString(36)}@example.test`, displayName: text("User", i, random()), createdAt: timestamp(i + Math.floor(random() * 1000)), updatedAt: timestamp(i + 1 + Math.floor(random() * 1000)) }))) yield b;
  for await (const b of emit("membership", c.memberships, i => ({ id: entityId("membership", profile, i), organizationId: entityId("organization", profile, i < c.organizations ? i : i % c.organizations), userId: entityId("user", profile, i), role: (i < c.organizations ? "owner" : i % 10 === 0 ? "admin" : "member") as Role, createdAt: timestamp(i) }))) yield b;
  for await (const b of emit("project", c.projects, i => ({ id: entityId("project", profile, i), organizationId: entityId("organization", profile, i % c.organizations), name: text("Project", i, random()), status: pick(["active", "archived"], random()), createdAt: timestamp(i), updatedAt: timestamp(i + 1) }))) yield b;
  for await (const b of emit("task", c.tasks, i => ({ id: entityId("task", profile, i), projectId: entityId("project", profile, i % c.projects), creatorId: entityId("user", profile, i % c.users), assigneeId: i % 5 === 0 ? null : entityId("user", profile, (i * 7) % c.users), title: text("Task", i, random()), description: text("Description", i, random()), status: pick(["todo", "in_progress", "done", "cancelled"], random()) as Task["status"], priority: pick(["low", "medium", "high", "urgent"], random()) as Task["priority"], dueDate: i % 3 === 0 ? timestamp(i + 100) : null, createdAt: timestamp(i), updatedAt: timestamp(i + 1) }))) yield b;
  for await (const b of emit("comment", c.comments, i => ({ id: entityId("comment", profile, i), taskId: entityId("task", profile, i % c.tasks), authorId: entityId("user", profile, (i * 11) % c.users), body: text("Comment", i, random()), createdAt: timestamp(i), updatedAt: timestamp(i + 1) }))) yield b;
  for await (const b of emit("activity", c.activities, i => ({ id: entityId("activity", profile, i), organizationId: entityId("organization", profile, i % c.organizations), projectId: i % 4 === 0 ? null : entityId("project", profile, i % c.projects), actorId: entityId("user", profile, (i * 13) % c.users), action: pick(["created", "updated", "completed"], random()), subjectType: i % 2 === 0 ? "task" : "project", subjectId: i % 2 === 0 ? entityId("task", profile, i % c.tasks) : entityId("project", profile, i % c.projects), createdAt: timestamp(i) }))) yield b;
}

export type { RecordType as SeedRecord };
