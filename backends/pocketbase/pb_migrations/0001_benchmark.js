/// <reference path="../../../.data/pocketbase/types.d.ts" />

migrate((app) => {
  const memberRule = '@request.auth.id != "" && @collection.memberships:requestMembership.user ?= @request.auth.id && @collection.memberships:requestMembership.organization ?= organization'
  const organizationMemberRule = '@request.auth.id != "" && @collection.memberships:requestMembership.user ?= @request.auth.id && @collection.memberships:requestMembership.organization ?= id'
  const bodyMemberRule = '@request.auth.id != "" && @collection.memberships:requestMembership.user ?= @request.auth.id && @collection.memberships:requestMembership.organization ?= @request.body.organization'
  const bodyAssigneeRule = '(@request.body.assignee = "" || (@collection.memberships:assigneeMembership.user ?= @request.body.assignee && @collection.memberships:assigneeMembership.organization ?= @request.body.organization))'
  const recordAssigneeRule = '(@request.body.assignee = "" || (@collection.memberships:assigneeMembership.user ?= @request.body.assignee && @collection.memberships:assigneeMembership.organization ?= organization))'
  const managerRule = `${memberRule} && (@collection.memberships:requestMembership.role ?= "owner" || @collection.memberships:requestMembership.role ?= "admin")`
  const organizationManagerRule = `${organizationMemberRule} && (@collection.memberships:requestMembership.role ?= "owner" || @collection.memberships:requestMembership.role ?= "admin")`
  const userPeerRule = '@request.auth.id != "" && (@request.auth.id = id || (@collection.memberships:subjectMembership.user ?= id && @collection.memberships:subjectMembership.organization ?= @collection.memberships:requestMembership.organization && @collection.memberships:requestMembership.user ?= @request.auth.id))'

  const users = app.findCollectionByNameOrId("users")
  users.listRule = null
  users.viewRule = null
  users.createRule = null
  users.updateRule = '@request.auth.id = id'
  users.deleteRule = null
  users.fields.add(new TextField({ name: "displayName", required: true, max: 120 }))
  users.passwordAuth.enabled = true
  users.passwordAuth.identityFields = ["email"]
  app.save(users)

  const organizations = new Collection({
    type: "base",
    name: "organizations",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "name", type: "text", required: true, max: 160 },
      { name: "owner", type: "relation", required: true, collectionId: users.id, maxSelect: 1 },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  })
  app.save(organizations)

  const memberships = new Collection({
    type: "base",
    name: "memberships",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "organization", type: "relation", required: true, collectionId: organizations.id, maxSelect: 1, cascadeDelete: true },
      { name: "user", type: "relation", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true },
      { name: "role", type: "select", required: true, maxSelect: 1, values: ["owner", "admin", "member"] },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_memberships_organization_user ON memberships (organization, user)",
      "CREATE INDEX idx_memberships_user_organization_role ON memberships (user, organization, role)",
    ],
  })
  app.save(memberships)

  const savedUsers = app.findCollectionByNameOrId("users")
  savedUsers.listRule = userPeerRule
  savedUsers.viewRule = userPeerRule
  app.save(savedUsers)
  const savedOrganizations = app.findCollectionByNameOrId("organizations")
  savedOrganizations.listRule = organizationMemberRule
  savedOrganizations.viewRule = organizationMemberRule
  savedOrganizations.updateRule = organizationManagerRule
  app.save(savedOrganizations)
  const savedMemberships = app.findCollectionByNameOrId("memberships")
  savedMemberships.listRule = memberRule
  savedMemberships.viewRule = memberRule
  savedMemberships.updateRule = `${managerRule} && @request.body.organization:changed = false && @request.body.user:changed = false`
  app.save(savedMemberships)

  const projects = new Collection({
    type: "base",
    name: "projects",
    listRule: memberRule,
    viewRule: memberRule,
    createRule: bodyMemberRule,
    updateRule: `${memberRule} && @request.body.organization:changed = false`,
    deleteRule: managerRule,
    fields: [
      { name: "organization", type: "relation", required: true, collectionId: organizations.id, maxSelect: 1, cascadeDelete: true },
      { name: "name", type: "text", required: true, max: 160 },
      { name: "status", type: "select", required: true, maxSelect: 1, values: ["active", "archived"] },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: ["CREATE INDEX idx_projects_organization_created ON projects (organization, created, id)"],
  })
  app.save(projects)

  const tasks = new Collection({
    type: "base",
    name: "tasks",
    listRule: memberRule,
    viewRule: memberRule,
    createRule: `${bodyMemberRule} && ${bodyAssigneeRule} && @request.body.creator = @request.auth.id && @request.body.project.organization = @request.body.organization`,
    updateRule: `${memberRule} && ${recordAssigneeRule} && @request.body.organization:changed = false && @request.body.project:changed = false && @request.body.creator:changed = false`,
    deleteRule: memberRule,
    fields: [
      { name: "organization", type: "relation", required: true, collectionId: organizations.id, maxSelect: 1, cascadeDelete: true },
      { name: "project", type: "relation", required: true, collectionId: projects.id, maxSelect: 1, cascadeDelete: true },
      { name: "creator", type: "relation", required: true, collectionId: users.id, maxSelect: 1 },
      { name: "assignee", type: "relation", collectionId: users.id, maxSelect: 1 },
      { name: "title", type: "text", required: true, max: 240 },
      { name: "description", type: "text", required: true, max: 10000 },
      { name: "status", type: "select", required: true, maxSelect: 1, values: ["todo", "in_progress", "done", "cancelled"] },
      { name: "priority", type: "select", required: true, maxSelect: 1, values: ["low", "medium", "high", "urgent"] },
      { name: "dueDate", type: "date" },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE INDEX idx_tasks_project_created ON tasks (project, created, id)",
      "CREATE INDEX idx_tasks_project_status_created ON tasks (project, status, created, id)",
      "CREATE INDEX idx_tasks_project_assignee_created ON tasks (project, assignee, created, id)",
    ],
  })
  app.save(tasks)

  const comments = new Collection({
    type: "base",
    name: "comments",
    listRule: memberRule,
    viewRule: memberRule,
    createRule: `${bodyMemberRule} && @request.body.author = @request.auth.id && @request.body.task.organization = @request.body.organization && @request.body.task.project = @request.body.project`,
    updateRule: `${memberRule} && @request.body.organization:changed = false && @request.body.project:changed = false && @request.body.task:changed = false && @request.body.author:changed = false`,
    deleteRule: memberRule,
    fields: [
      { name: "organization", type: "relation", required: true, collectionId: organizations.id, maxSelect: 1, cascadeDelete: true },
      { name: "project", type: "relation", required: true, collectionId: projects.id, maxSelect: 1, cascadeDelete: true },
      { name: "task", type: "relation", required: true, collectionId: tasks.id, maxSelect: 1, cascadeDelete: true },
      { name: "author", type: "relation", required: true, collectionId: users.id, maxSelect: 1 },
      { name: "body", type: "text", required: true, max: 10000 },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: ["CREATE INDEX idx_comments_task_created ON comments (task, created, id)"],
  })
  app.save(comments)

  const activities = new Collection({
    type: "base",
    name: "activities",
    listRule: memberRule,
    viewRule: memberRule,
    createRule: `${bodyMemberRule} && @request.body.actor = @request.auth.id`,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "organization", type: "relation", required: true, collectionId: organizations.id, maxSelect: 1, cascadeDelete: true },
      { name: "project", type: "relation", collectionId: projects.id, maxSelect: 1, cascadeDelete: true },
      { name: "actor", type: "relation", required: true, collectionId: users.id, maxSelect: 1 },
      { name: "action", type: "text", required: true, max: 80 },
      { name: "subjectType", type: "text", required: true, max: 80 },
      { name: "subjectId", type: "text", required: true, max: 64 },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: ["CREATE INDEX idx_activities_organization_created ON activities (organization, created, id)"],
  })
  app.save(activities)

  const settings = app.settings()
  settings.batch.enabled = true
  settings.batch.maxRequests = 50
  settings.batch.timeout = 10
  settings.batch.maxBodySize = 0
  app.save(settings)
}, (app) => {
  for (const name of ["activities", "comments", "tasks", "projects", "memberships", "organizations"]) {
    app.delete(app.findCollectionByNameOrId(name))
  }
  const users = app.findCollectionByNameOrId("users")
  users.fields.removeByName("displayName")
  users.listRule = null
  users.viewRule = "id = @request.auth.id"
  users.createRule = ""
  users.updateRule = "id = @request.auth.id"
  users.deleteRule = "id = @request.auth.id"
  app.save(users)
  const settings = app.settings()
  settings.batch.enabled = false
  app.save(settings)
})
