import test from "node:test";
import assert from "node:assert/strict";
import { backend, createSupabaseClient, seedSupabaseCorrectnessFixture } from "../backends/supabase/adapter.js";
import { runSynchronousProbe, supabaseProcess } from "../backends/supabase/process.js";
import { BenchmarkOperationError, runCorrectness } from "../src/correctness.js";
import { profileExpectedCounts } from "../src/seed.js";

const live = process.env.BENCH_LIVE === "1";
const denied = (error: unknown): boolean => error instanceof BenchmarkOperationError && error.classification === "authorization";

type ContainerState = { id: string; name: string; image: string; running: boolean };
function supaflareState(): ContainerState[] {
  const names = runSynchronousProbe("docker", ["ps", "-a", "--format", "{{.Names}}", "--filter", "label=com.supabase.cli.project=supaflare"], "Docker");
  const result: ContainerState[] = [];
  for (const name of names.trim().split(/\s+/).filter(Boolean)) {
    const inspect = runSynchronousProbe("docker", ["inspect", "--format", "{{.Id}}|{{.Name}}|{{.Config.Image}}|{{.State.Running}}", name], "Docker");
    const [id, containerName, image, running] = inspect.trim().split("|");
    result.push({ id: id!, name: containerName!.replace(/^\//, ""), image: image!, running: running === "true" });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
function benchmarkContainers(): string[] {
  return runSynchronousProbe("docker", ["ps", "-a", "--format", "{{.Names}}", "--filter", "label=com.supabase.cli.project=realworldbaasbench"], "Docker").trim().split(/\s+/).filter(Boolean).sort();
}

test("Supabase live shared correctness and database tenant boundaries", { skip: live ? false : "set BENCH_LIVE=1 to run", timeout: 600_000 }, async (t) => {
  const before = supaflareState();
  try {
    await backend.reset();
    await seedSupabaseCorrectnessFixture();
    const fixture = await seedSupabaseCorrectnessFixture();
    const correctness = await runCorrectness(backend, fixture);
    assert.equal(correctness.aborted, false, correctness.abortReason);
    assert.deepEqual(correctness.findings.filter(finding => !finding.passed), []);

    await t.test("adapter binds memberships and assignees to their tenant", async () => {
      const admin = await backend.createSession(fixture.admin);
      const owner = await backend.createSession(fixture.owner);
      const member = await backend.createSession(fixture.member);
      try {
        await assert.rejects(admin.updateMembershipRole({ organizationId: fixture.organizationId, membershipId: fixture.foreignMembershipId, role: "admin" }), denied);
        await assert.rejects(member.updateMembershipRole({ organizationId: fixture.organizationId, membershipId: fixture.adminMembershipId, role: "member" }), denied);
        await assert.rejects(owner.createTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, title: "bad assignee", description: "cross tenant", priority: "low", assigneeId: fixture.outsiderUserId }), denied);

        const task = await owner.createTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, title: "activity check", description: "", priority: "low" });
        const searchTask = await owner.createTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, title: "Percent 100%_Done", description: "", priority: "low" });
        const search = await owner.searchTasks({ organizationId: fixture.organizationId, projectId: fixture.projectId, query: "100%_done", page: 0, pageSize: 10 });
        assert.deepEqual(search.items.map(item => item.id), [searchTask.id]);
        const dashboard = await owner.dashboard({ organizationId: fixture.organizationId, projectId: fixture.projectId, activityPage: { page: 0, pageSize: 2 } });
        assert.equal(dashboard.organization.id, fixture.organizationId);
        assert.ok(dashboard.projects.some(project => project.id === fixture.projectId));
        assert.ok(dashboard.recentActivity.length <= 2);
        await owner.updateTask({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId: task.id, title: "activity updated" });
        const comment = await owner.addComment({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId: task.id, body: "activity comment" });
        await owner.updateComment({ organizationId: fixture.organizationId, projectId: fixture.projectId, taskId: task.id, commentId: comment.id, body: "activity comment updated" });
        const status = await supabaseProcess.status();
        const audit = createSupabaseClient(status.API_URL, String(status.PUBLISHABLE_KEY || status.ANON_KEY), "realworldbaasbench", "activity-live");
        assert.equal((await audit.auth.signInWithPassword(fixture.owner)).error, null);
        const activities = await audit.from("activities").select("action,subject_type,subject_id,actor_id").eq("organization_id", fixture.organizationId).eq("subject_id", task.id);
        assert.equal(activities.error, null);
        assert.deepEqual(activities.data?.map(row => row.action).sort(), ["comment_updated", "commented", "created", "updated"]);
        assert.ok(activities.data?.every(row => row.subject_type === "task" && row.subject_id === task.id));
        await audit.auth.signOut();
      } finally { await Promise.all([admin.close(), owner.close(), member.close()]); }
    });

    await t.test("database constraints reject direct cross-tenant relations and members can insert activity", async () => {
      const status = await supabaseProcess.status();
      const client = createSupabaseClient(status.API_URL, String(status.PUBLISHABLE_KEY || status.ANON_KEY), "realworldbaasbench", "direct-live");
      const auth = await client.auth.signInWithPassword(fixture.member);
      assert.equal(auth.error, null);
      const memberRole = await client.from("memberships").update({ role: "admin" }).eq("id", fixture.memberMembershipId).eq("organization_id", fixture.organizationId).select("id");
      assert.ok(memberRole.error || memberRole.data?.length === 0);
      const badTask = await client.from("tasks").insert({ id: "sxbad0000000001", organization_id: fixture.organizationId, project_id: fixture.projectId, creator_id: fixture.memberUserId, assignee_id: fixture.outsiderUserId, title: "bad", description: "bad", status: "todo", priority: "low" });
      assert.ok(badTask.error);
      const badComment = await client.from("comments").insert({ id: "sxbad0000000002", organization_id: fixture.organizationId, project_id: fixture.projectId, task_id: fixture.taskId, author_id: fixture.outsiderUserId, body: "bad" });
      assert.ok(badComment.error);
      const badActivity = await client.from("activities").insert({ id: "sxbad0000000003", organization_id: fixture.organizationId, project_id: fixture.projectId, actor_id: fixture.outsiderUserId, action: "bad", subject_type: "task", subject_id: fixture.taskId });
      assert.ok(badActivity.error);
      const activity = await client.from("activities").insert({ id: "sxact0000000001", organization_id: fixture.organizationId, project_id: fixture.projectId, actor_id: fixture.memberUserId, action: "checked", subject_type: "task", subject_id: fixture.taskId }).select("id").single();
      assert.equal(activity.error, null);
      assert.equal(activity.data?.id, "sxact0000000001");
      const immutable = await client.from("tasks").update({ organization_id: fixture.secondOrganizationId }).eq("id", fixture.taskId).select("id");
      assert.ok(immutable.error || immutable.data?.length === 0);
      const badAssigneeUpdate = await client.from("tasks").update({ assignee_id: fixture.outsiderUserId }).eq("id", fixture.taskId).select("id");
      assert.ok(badAssigneeUpdate.error || badAssigneeUpdate.data?.length === 0);
      await client.auth.signOut();

      const manager = createSupabaseClient(status.API_URL, String(status.PUBLISHABLE_KEY || status.ANON_KEY), "realworldbaasbench", "manager-live");
      assert.equal((await manager.auth.signInWithPassword(fixture.admin)).error, null);
      const promoted = await manager.from("memberships").update({ role: "admin" }).eq("id", fixture.memberMembershipId).eq("organization_id", fixture.organizationId).select("role").single();
      assert.equal(promoted.error, null);
      assert.equal(promoted.data?.role, "admin");
      const restored = await manager.from("memberships").update({ role: "member" }).eq("id", fixture.memberMembershipId).eq("organization_id", fixture.organizationId).select("role").single();
      assert.equal(restored.error, null);
      assert.equal(restored.data?.role, "member");
      await manager.auth.signOut();
    });
  } finally {
    await backend.stop();
    assert.deepEqual(benchmarkContainers(), []);
    assert.deepEqual(supaflareState(), before);
  }
});

test("Supabase full small seed clears repeatably and verifies auth plus table counts", { skip: live && process.env.BENCH_LIVE_SEED === "1" ? false : "set BENCH_LIVE=1 BENCH_LIVE_SEED=1 to run", timeout: 1_800_000 }, async () => {
  const before = supaflareState();
  try {
    await backend.reset();
    await backend.seed({ name: "small", definition: { ...profileExpectedCounts("small") } }, 42);
    await backend.seed({ name: "small", definition: { ...profileExpectedCounts("small") } }, 42);
  } finally {
    await backend.stop();
    assert.deepEqual(benchmarkContainers(), []);
    assert.deepEqual(supaflareState(), before);
  }
});
