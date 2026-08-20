export type Timestamp = string;
export type Id = string;
export type Role = "owner" | "admin" | "member";
export type TaskStatus = "todo" | "in_progress" | "done" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "urgent";

export interface User { id: Id; email: string; displayName: string; createdAt: Timestamp; updatedAt: Timestamp; }
export interface Organization { id: Id; name: string; ownerId: Id; createdAt: Timestamp; }
export interface Membership { id: Id; organizationId: Id; userId: Id; role: Role; createdAt: Timestamp; }
export interface Project { id: Id; organizationId: Id; name: string; status: string; createdAt: Timestamp; updatedAt: Timestamp; }
export interface Task { id: Id; projectId: Id; creatorId: Id; assigneeId: Id | null; title: string; description: string; status: TaskStatus; priority: TaskPriority; dueDate: Timestamp | null; createdAt: Timestamp; updatedAt: Timestamp; }
export interface Comment { id: Id; taskId: Id; authorId: Id; body: string; createdAt: Timestamp; updatedAt: Timestamp; }
export interface Activity { id: Id; organizationId: Id; projectId: Id | null; actorId: Id; action: string; subjectType: string; subjectId: Id; createdAt: Timestamp; }
export interface Credentials { email: string; password: string; }
export interface BenchmarkVirtualUserSpec { credentials: Credentials; organizationId: Id; projectId: Id; taskId: Id; commentId?: Id; }
export interface CorrectnessSetupFixture { owner: Credentials; admin: Credentials; member: Credentials; outsider: Credentials; organizationId: Id; projectId: Id; taskId?: Id; ownerMembershipId: Id; memberMembershipId: Id; adminMembershipId: Id; memberUserId?: Id; foreignMembershipId: Id; outsiderUserId?: Id; }
export interface Page<T> { items: T[]; page: number; pageSize: number; total: number; hasNext: boolean; }
export interface DatasetProfile { name: "small" | "medium" | "large"; definition: Record<string, number>; }
export interface TenantProjectContext { organizationId: Id; projectId: Id; }
export interface Pagination { page: number; pageSize: number; }
export interface Dashboard { organization: Organization; projects: Project[]; recentActivity: Activity[]; }
export interface TaskDetail { task: Task; creator: User; assignee: User | null; comments: Page<Comment>; }
export interface DashboardInput extends TenantProjectContext { activityPage?: Pagination; }
export interface ListTasksInput extends TenantProjectContext, Pagination { status?: TaskStatus; assigneeId?: Id | null; }
export interface GetTaskInput extends TenantProjectContext { taskId: Id; comments: Pagination; }
export interface CreateTaskInput extends TenantProjectContext { title: string; description: string; priority: TaskPriority; assigneeId?: Id | null; dueDate?: Timestamp | null; }
export interface UpdateTaskInput extends TenantProjectContext { taskId: Id; status?: TaskStatus; priority?: TaskPriority; assigneeId?: Id | null; dueDate?: Timestamp | null; title?: string; description?: string; }
export interface AddCommentInput extends TenantProjectContext { taskId: Id; body: string; }
export interface UpdateCommentInput extends TenantProjectContext { taskId: Id; commentId: Id; body: string; }
export interface UpdateMembershipRoleInput { organizationId: Id; membershipId: Id; role: Role; }
export interface SearchTasksInput extends TenantProjectContext, Pagination { query: string; }
export interface UpdateProfileInput { displayName: string; }
