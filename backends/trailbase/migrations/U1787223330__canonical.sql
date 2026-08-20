PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY,
  publicId TEXT NOT NULL UNIQUE CHECK(length(publicId) = 15 AND publicId NOT GLOB '*[^a-z0-9]*'),
  authId BLOB NOT NULL UNIQUE REFERENCES _user(id),
  email TEXT NOT NULL UNIQUE,
  displayName TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY,
  publicId TEXT NOT NULL UNIQUE CHECK(length(publicId) = 15 AND publicId NOT GLOB '*[^a-z0-9]*'),
  name TEXT NOT NULL,
  ownerId TEXT NOT NULL REFERENCES profiles(publicId),
  _ownerMembershipId TEXT NOT NULL UNIQUE CHECK(length(_ownerMembershipId) = 15 AND _ownerMembershipId NOT GLOB '*[^a-z0-9]*'),
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(publicId, ownerId)
) STRICT;

CREATE TABLE IF NOT EXISTS memberships (
  id INTEGER PRIMARY KEY,
  publicId TEXT NOT NULL UNIQUE CHECK(length(publicId) = 15 AND publicId NOT GLOB '*[^a-z0-9]*'),
  organizationId TEXT NOT NULL REFERENCES organizations(publicId) ON DELETE CASCADE,
  userId TEXT NOT NULL REFERENCES profiles(publicId),
  role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')),
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(organizationId, userId),
  UNIQUE(organizationId, userId, role)
) STRICT;

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  publicId TEXT NOT NULL UNIQUE CHECK(length(publicId) = 15 AND publicId NOT GLOB '*[^a-z0-9]*'),
  organizationId TEXT NOT NULL REFERENCES organizations(publicId),
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(organizationId, publicId)
) STRICT;

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  publicId TEXT NOT NULL UNIQUE CHECK(length(publicId) = 15 AND publicId NOT GLOB '*[^a-z0-9]*'),
  organizationId TEXT NOT NULL REFERENCES organizations(publicId),
  projectId TEXT NOT NULL,
  creatorId TEXT NOT NULL,
  assigneeId TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('todo', 'in_progress', 'done', 'cancelled')),
  priority TEXT NOT NULL CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
  dueDate TEXT,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _seeded INTEGER NOT NULL DEFAULT 0 CHECK(_seeded IN (0, 1)),
  _activityActorId TEXT,
  UNIQUE(organizationId, projectId, publicId),
  FOREIGN KEY(organizationId, projectId) REFERENCES projects(organizationId, publicId),
  FOREIGN KEY(organizationId, creatorId) REFERENCES memberships(organizationId, userId),
  FOREIGN KEY(organizationId, assigneeId) REFERENCES memberships(organizationId, userId),
  FOREIGN KEY(organizationId, _activityActorId) REFERENCES memberships(organizationId, userId)
) STRICT;

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  publicId TEXT NOT NULL UNIQUE CHECK(length(publicId) = 15 AND publicId NOT GLOB '*[^a-z0-9]*'),
  organizationId TEXT NOT NULL REFERENCES organizations(publicId),
  projectId TEXT NOT NULL,
  taskId TEXT NOT NULL,
  authorId TEXT NOT NULL,
  body TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _seeded INTEGER NOT NULL DEFAULT 0 CHECK(_seeded IN (0, 1)),
  _activityActorId TEXT,
  UNIQUE(organizationId, projectId, taskId, publicId),
  FOREIGN KEY(organizationId, projectId) REFERENCES projects(organizationId, publicId),
  FOREIGN KEY(organizationId, projectId, taskId) REFERENCES tasks(organizationId, projectId, publicId),
  FOREIGN KEY(organizationId, authorId) REFERENCES memberships(organizationId, userId),
  FOREIGN KEY(organizationId, _activityActorId) REFERENCES memberships(organizationId, userId)
) STRICT;

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  publicId TEXT NOT NULL UNIQUE CHECK(length(publicId) = 15 AND publicId NOT GLOB '*[^a-z0-9]*'),
  organizationId TEXT NOT NULL REFERENCES organizations(publicId),
  projectId TEXT,
  actorId TEXT NOT NULL,
  action TEXT NOT NULL,
  subjectType TEXT NOT NULL,
  subjectId TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY(organizationId, projectId) REFERENCES projects(organizationId, publicId),
  FOREIGN KEY(organizationId, actorId) REFERENCES memberships(organizationId, userId)
) STRICT;

CREATE INDEX IF NOT EXISTS profiles_auth ON profiles(authId);
CREATE INDEX IF NOT EXISTS memberships_org ON memberships(organizationId, role, userId);
CREATE INDEX IF NOT EXISTS memberships_user ON memberships(userId, organizationId);
CREATE INDEX IF NOT EXISTS projects_org ON projects(organizationId, createdAt, publicId);
CREATE INDEX IF NOT EXISTS tasks_tenant_project ON tasks(organizationId, projectId, createdAt, publicId);
CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(organizationId, assigneeId);
CREATE INDEX IF NOT EXISTS comments_task ON comments(organizationId, projectId, taskId, createdAt, publicId);
CREATE INDEX IF NOT EXISTS activities_org ON activities(organizationId, createdAt, publicId);

CREATE TRIGGER IF NOT EXISTS profiles_identity_frozen
BEFORE UPDATE OF publicId, authId ON profiles
WHEN NEW.publicId IS NOT OLD.publicId OR NEW.authId IS NOT OLD.authId
BEGIN SELECT RAISE(ABORT, 'profile identity is immutable'); END;

CREATE TRIGGER IF NOT EXISTS profiles_display_updated
AFTER UPDATE OF displayName ON profiles
BEGIN UPDATE profiles SET updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS organizations_identity_frozen
BEFORE UPDATE OF publicId, ownerId, _ownerMembershipId ON organizations
WHEN NEW.publicId IS NOT OLD.publicId OR NEW.ownerId IS NOT OLD.ownerId OR NEW._ownerMembershipId IS NOT OLD._ownerMembershipId
BEGIN SELECT RAISE(ABORT, 'organization ownership is immutable'); END;

CREATE TRIGGER IF NOT EXISTS organizations_owner_membership
AFTER INSERT ON organizations
BEGIN
  INSERT INTO memberships(publicId, organizationId, userId, role, createdAt)
  VALUES(NEW._ownerMembershipId, NEW.publicId, NEW.ownerId, 'owner', NEW.createdAt);
END;

CREATE TRIGGER IF NOT EXISTS memberships_identity_frozen
BEFORE UPDATE OF publicId, organizationId, userId ON memberships
WHEN NEW.publicId IS NOT OLD.publicId OR NEW.organizationId IS NOT OLD.organizationId OR NEW.userId IS NOT OLD.userId
BEGIN SELECT RAISE(ABORT, 'membership tenant is immutable'); END;

CREATE TRIGGER IF NOT EXISTS memberships_owner_insert
BEFORE INSERT ON memberships
WHEN (NEW.role = 'owner') IS NOT (NEW.userId = (SELECT ownerId FROM organizations WHERE publicId = NEW.organizationId))
BEGIN SELECT RAISE(ABORT, 'owner membership must match organization owner'); END;

CREATE TRIGGER IF NOT EXISTS memberships_owner_update
BEFORE UPDATE OF role ON memberships
WHEN (NEW.role = 'owner') IS NOT (NEW.userId = (SELECT ownerId FROM organizations WHERE publicId = NEW.organizationId))
BEGIN SELECT RAISE(ABORT, 'owner membership must match organization owner'); END;

CREATE TRIGGER IF NOT EXISTS memberships_owner_delete
AFTER DELETE ON memberships WHEN OLD.role = 'owner'
BEGIN DELETE FROM organizations WHERE publicId = OLD.organizationId AND ownerId = OLD.userId; END;

CREATE TRIGGER IF NOT EXISTS projects_identity_frozen
BEFORE UPDATE OF publicId, organizationId ON projects
WHEN NEW.publicId IS NOT OLD.publicId OR NEW.organizationId IS NOT OLD.organizationId
BEGIN SELECT RAISE(ABORT, 'project tenant is immutable'); END;

CREATE TRIGGER IF NOT EXISTS tasks_identity_frozen
BEFORE UPDATE OF publicId, organizationId, projectId, creatorId, _seeded ON tasks
WHEN NEW.publicId IS NOT OLD.publicId OR NEW.organizationId IS NOT OLD.organizationId OR NEW.projectId IS NOT OLD.projectId OR NEW.creatorId IS NOT OLD.creatorId OR NEW._seeded IS NOT OLD._seeded
BEGIN SELECT RAISE(ABORT, 'task tenant is immutable'); END;

CREATE TRIGGER IF NOT EXISTS comments_identity_frozen
BEFORE UPDATE OF publicId, organizationId, projectId, taskId, authorId, _seeded ON comments
WHEN NEW.publicId IS NOT OLD.publicId OR NEW.organizationId IS NOT OLD.organizationId OR NEW.projectId IS NOT OLD.projectId OR NEW.taskId IS NOT OLD.taskId OR NEW.authorId IS NOT OLD.authorId OR NEW._seeded IS NOT OLD._seeded
BEGIN SELECT RAISE(ABORT, 'comment tenant is immutable'); END;

CREATE TRIGGER IF NOT EXISTS activities_identity_frozen
BEFORE UPDATE OF publicId, organizationId, projectId, actorId ON activities
WHEN NEW.publicId IS NOT OLD.publicId OR NEW.organizationId IS NOT OLD.organizationId OR NEW.projectId IS NOT OLD.projectId OR NEW.actorId IS NOT OLD.actorId
BEGIN SELECT RAISE(ABORT, 'activity tenant is immutable'); END;

CREATE TRIGGER IF NOT EXISTS task_activity_created
AFTER INSERT ON tasks WHEN NEW._seeded = 0
BEGIN
  INSERT INTO activities(publicId, organizationId, projectId, actorId, action, subjectType, subjectId, createdAt)
  VALUES(substr(lower(hex(randomblob(8))), 1, 15), NEW.organizationId, NEW.projectId, NEW.creatorId, 'created', 'task', NEW.publicId, NEW.createdAt);
END;

CREATE TRIGGER IF NOT EXISTS task_activity_updated
AFTER UPDATE OF assigneeId, title, description, status, priority, dueDate ON tasks
BEGIN
  INSERT INTO activities(publicId, organizationId, projectId, actorId, action, subjectType, subjectId, createdAt)
  VALUES(substr(lower(hex(randomblob(8))), 1, 15), NEW.organizationId, NEW.projectId, NEW._activityActorId, 'updated', 'task', NEW.publicId, NEW.updatedAt);
END;

CREATE TRIGGER IF NOT EXISTS comment_activity_created
AFTER INSERT ON comments WHEN NEW._seeded = 0
BEGIN
  INSERT INTO activities(publicId, organizationId, projectId, actorId, action, subjectType, subjectId, createdAt)
  VALUES(substr(lower(hex(randomblob(8))), 1, 15), NEW.organizationId, NEW.projectId, NEW.authorId, 'commented', 'task', NEW.taskId, NEW.createdAt);
END;

CREATE TRIGGER IF NOT EXISTS comment_activity_updated
AFTER UPDATE OF body ON comments
BEGIN
  INSERT INTO activities(publicId, organizationId, projectId, actorId, action, subjectType, subjectId, createdAt)
  VALUES(substr(lower(hex(randomblob(8))), 1, 15), NEW.organizationId, NEW.projectId, NEW._activityActorId, 'comment_updated', 'task', NEW.taskId, NEW.updatedAt);
END;
