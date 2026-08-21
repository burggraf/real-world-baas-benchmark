# Real-World BaaS Benchmark Design

**Status:** Approved design  
**Date:** 2026-08-19  
**Initial targets:** Supabase, PocketBase, TrailBase  
**Initial client runtime:** JavaScript/TypeScript on Node.js

## 1. Purpose

Build a reproducible local benchmark that answers:

> On this hardware, with this backend and official client SDK, how many concurrent active users can this project-management application support while meeting its usability targets?

The benchmark also reports application transactions per second (TPS), SDK-operation throughput, read/write throughput, latency, errors, and hardware utilization. It does not advertise isolated insert or select microbenchmark numbers as application capacity.

Every result is qualified by backend version, SDK version, dataset, workload, think time, host, configuration, and service-level objectives (SLOs). It is not an absolute vendor capacity claim.

## 2. Decisions

- Use a multi-tenant project-management SaaS workload.
- Run one backend at a time on the same host.
- Run Supabase locally through the Supabase CLI; run pinned PocketBase and TrailBase binaries locally.
- Start with official JavaScript/TypeScript clients.
- Defer Dart and other clients until the workload and result contract are validated.
- Benchmark auth and database behavior in v1.
- Add realtime and file storage later as separate suites, not to the primary score.
- Use small, medium, and large deterministic datasets; medium produces the primary score.
- Define capacity by latency, errors, and saturation—not by the last process that remains alive.

## 3. Goals

1. Exercise operations that a real application performs through public SDKs and normal user credentials.
2. Produce a defensible concurrent-active-user capacity for a specific machine.
3. Expose p50, p95, and p99 latency plus application, read, and write TPS.
4. Detect whether the backend or load runner is the bottleneck.
5. Keep schemas, authorization semantics, result sizes, and workflows equivalent across products.
6. Make clean runs repeatable on macOS ARM64 and Ubuntu.
7. Preserve raw machine-readable results for later aggregation and regression checks.

## 4. Non-goals for v1

- Hosted-service comparisons.
- Cost comparisons.
- Realtime connection or fan-out benchmarks.
- File upload/download benchmarks.
- Full-text search engine comparisons.
- Every supported client language.
- Synthetic single-query peak claims.
- Tuning each backend until it wins; v1 uses documented defaults plus required schema indexes.
- A distributed load-generation control plane.

## 5. Benchmark application

### 5.1 Domain model

| Entity | Important fields and relations |
|---|---|
| User | id, email, display name, created/updated timestamps |
| Organization | id, name, owner, created timestamp |
| Membership | organization, user, role (`owner`, `admin`, `member`) |
| Project | organization, name, status, created/updated timestamps |
| Task | project, creator, optional assignee, title, description, status, priority, due date, timestamps |
| Comment | task, author, body, created/updated timestamps |
| Activity | organization, project, actor, action, subject type/id, created timestamp |

Required constraints and indexes include unique membership per organization/user, task filtering by project/status/assignee, stable task and activity ordering, comment lookup by task/time, and tenant-scoped search fields.

### 5.2 Authorization

Measured application operations use ordinary user sessions. Administrative credentials are restricted to lifecycle, schema, seed, and cleanup work.

Common rules:

- Users can read and update their own profile.
- Organization members can read their organization, membership roster, projects, tasks, comments, and activity.
- Members can create and update tasks and comments inside their organizations.
- Only owners/admins can invite users or change membership roles.
- Cross-tenant reads and writes are denied.

The correctness suite proves these rules before any performance result is accepted.

## 6. Workloads

### 6.1 Primary active-workday mix

A virtual user signs in, chooses an organization and project, and repeats weighted actions with randomized think time.

| Workflow | Weight | Typical application work |
|---|---:|---|
| Dashboard | 20% | Membership authorization, project summary, recent activity |
| Task list | 25% | Filtered, sorted, paginated tasks with assignee data |
| Task detail | 15% | Task, creator, assignee, and paginated comments |
| Create task | 10% | Create task and matching activity entry |
| Update task | 12% | Change status, assignee, priority, or due date; add activity |
| Add comment | 10% | Create comment and matching activity entry |
| Search | 5% | Tenant-scoped title query with a bounded page |
| Profile update | 1% | Change user-visible profile data |
| Sign out/in | 2% | Clear and recreate an authenticated session |

A workflow may require multiple public SDK calls. The benchmark times both the full workflow and each SDK operation so products are compared by user-visible work without hiding extra round trips.

Think time defaults to a deterministic random value between 1 and 5 seconds. The exact distribution is configurable and included in every result.

### 6.2 Lifecycle suite

Run separately because user lifecycle traffic is uncommon relative to daily CRUD:

- register user
- create profile
- sign in with password
- refresh session/token
- update account/profile
- create organization
- invite/add member
- change member role
- sign out

Lifecycle results are reported but do not dominate the primary capacity score.

### 6.3 Contention profiles

- **Normal mix:** users spread across many organizations and projects.
- **Hot project:** many users read and update one project.
- **Write-heavy event:** temporary burst of task and comment creation.

Only normal mix on the medium dataset produces the headline application-capacity score. Other profiles explain limits.

### 6.4 Diagnostic mixes

Optional read-heavy and write-heavy mixes use the same application workflows with adjusted weights. Their read/write thresholds remain contextual application figures and are never presented as raw database limits.

## 7. Dataset profiles

Data is generated from a fixed seed. IDs, text, assignments, states, and timestamps are deterministic.

| Profile | Organizations | Users | Projects | Tasks | Comments | Activities |
|---|---:|---:|---:|---:|---:|---:|
| Small | 100 | 1,000 | 500 | 10,000 | 30,000 | 20,000 |
| Medium | 1,000 | 10,000 | 5,000 | 100,000 | 300,000 | 200,000 |
| Large | 10,000 | 100,000 | 50,000 | 1,000,000 | 3,000,000 | 2,000,000 |

Profiles may be generated in bounded batches rather than stored as large fixture files. Seed time and database size are reported separately from application performance.

## 8. Architecture

### 8.1 Recommended v1

A shared TypeScript workload runner owns configuration, virtual users, deterministic selection, timing, metrics, capacity rules, and report output. Thin backend adapters call official JavaScript clients.

```ts
interface Backend {
  readonly name: "supabase" | "pocketbase" | "trailbase";
  doctor(): Promise<BackendInfo>;
  start(): Promise<void>;
  reset(): Promise<void>;
  seed(profile: DatasetProfile, seed: number): Promise<void>;
  createSession(credentials: Credentials): Promise<AppSession>;
  stop(): Promise<void>;
}

interface AppSession {
  dashboard(input: DashboardInput): Promise<Dashboard>;
  listTasks(input: ListTasksInput): Promise<Page<Task>>;
  getTask(input: GetTaskInput): Promise<TaskDetail>;
  createTask(input: CreateTaskInput): Promise<Task>;
  updateTask(input: UpdateTaskInput): Promise<Task>;
  addComment(input: AddCommentInput): Promise<Comment>;
  searchTasks(input: SearchTasksInput): Promise<Page<Task>>;
  updateProfile(input: UpdateProfileInput): Promise<User>;
  refreshSession(): Promise<void>;
  signOut(): Promise<void>;
}
```

This boundary standardizes application outcomes, not internal query count. Backend-specific behavior remains visible in per-operation metrics.

### 8.2 Why not k6 first

A generic HTTP load tool would provide mature scheduling but would bypass or imperfectly emulate official SDK behavior. Since SDK overhead and request composition are part of the question, the first runner uses the actual SDKs.

### 8.3 Later client runtimes

A Dart runner will consume the same workload configuration and emit the same JSON result schema. The JSON contracts—not a new RPC coordinator—are the initial language-neutral boundary.

## 9. Repository shape

```text
bench/
  package.json
  tsconfig.json
  README.md
  src/
    cli.ts
    config.ts
    domain.ts
    backend.ts
    seed.ts
    correctness.ts
    workload.ts
    metrics.ts
    capacity.ts
    system.ts
    report.ts
  backends/
    pocketbase/
      adapter.ts
      pb_migrations/
    supabase/
      adapter.ts
      supabase/
        config.toml
        migrations/
    trailbase/
      adapter.ts
      traildepot/
        config.textproto
        migrations/
  configs/
    quick.json
    full.json
  test/
  docs/plans/
  results/                 # ignored except examples
```

Do not create a plugin framework. A typed switch selecting three adapters is sufficient for v1.

## 10. Execution lifecycle

A complete run:

1. Validate Node, SDK, backend CLI/binary, Docker where needed, ports, disk space, and host support.
2. Capture host, OS, architecture, CPU, memory, runtime, backend, SDK, CLI, Docker, and configuration metadata.
3. Start one backend.
4. Reset it to a clean state.
5. Apply schema, indexes, and access rules.
6. Generate and seed deterministic data.
7. Run correctness and tenant-isolation checks.
8. Warm up for two minutes without recording score data.
9. Run steady concurrency stages.
10. Sample runner/backend resource use during each stage.
11. Stop after clear SLO failure or configured maximum.
12. Refine between the last passing and first failing stage.
13. Write raw JSON and Markdown summary.
14. Stop the backend and retain logs on failure.

Supabase local lifecycle uses documented CLI commands such as `supabase start`, `supabase status -o json`, `supabase db reset`, and `supabase stop`. PocketBase and TrailBase use pinned binaries and repository-owned migrations/configuration.

Backends run sequentially. Publishable comparisons repeat each backend at least three times and rotate backend order to reduce thermal and cache-order bias.

## 11. Concurrency model

Node runs asynchronous closed-model virtual users. Before measurement, ordinary-user sessions are prepared in deterministic input order in fixed batches of ten with no retries; preparation and final boundary cleanup are unmeasured and any preparation failure invalidates the stage. Each prepared virtual user owns an authenticated session and waits for an action to finish before thinking and starting the next action. Every SDK request uses the configured request timeout through the official fetch transport. At a stage deadline, transport cancellation begins before workers are awaited and cleanup starts only after workers settle; unsupported or ignored abort behavior invalidates/stops the run. Authentication performed by the measured sign-out/sign-in journey remains measured.

Default full stages:

- two-minute warm-up
- 5, 10, 25, and 50 virtual users
- then double until failure or configured maximum
- five minutes of steady measurement per level
- refinement between the last passing and first failing levels

Five users is the publishable measurement floor: the fixed 300-second deterministic one-user stream cannot meet the unchanged 20-sample minimum for the 7% auth/search class. Publishable capacity is therefore established only within the measured range beginning at five; capacity zero means no qualifying capacity was established at or above five, not zero supported users. A quick development profile retains separate one-user evidence with shorter stages and the small dataset. It is never labeled publishable.

Multiple Node worker processes are deferred until measurement shows the runner is limiting achieved load. A remote runner can later target the same backend URL without changing scenarios.

## 12. Metrics

For each workflow and SDK operation:

- attempted, completed, and failed count
- operations per second
- p50, p95, p99, minimum, and maximum latency
- timeout and error classifications
- read/write classification
- validation failures
- optional bytes transferred where the SDK exposes them without replacing its transport

For each stage:

- application workflow TPS
- SDK-operation TPS
- read SDK operations per second
- write SDK operations per second
- requested and achieved active users
- runner CPU and RSS
- backend CPU and RSS
- disk I/O when portable
- Supabase container resource totals and per-service breakdown

`TPS` in reports means completed application workflows per second. SDK-operation throughput is labeled separately.

## 13. SLOs and capacity

Default thresholds:

| Operation class | p95 target |
|---|---:|
| Dashboard, lists, details | <= 500 ms |
| Writes and comments | <= 750 ms |
| Authentication and bounded search | <= 1,000 ms |
| Every class | < 1% errors |

**Application capacity** is the highest sustained concurrency where all operation classes meet latency and error targets.

**Saturation** is flagged when a material concurrency increase yields less than 10% additional throughput while latency or queueing increases. Practical capacity is the lower of the last SLO-passing stage and the stage before sustained saturation.

No result is valid if:

- correctness checks fail;
- achieved concurrency materially trails requested concurrency;
- the runner is CPU- or event-loop-limited;
- the backend restarts or becomes unhealthy;
- the stage is too short or has too few samples for required percentiles.

Reports show the full throughput/latency curve, not only one capacity number.

## 14. Fairness rules

- Same host and exclusive test window.
- One backend at a time.
- Equivalent schema fields, constraints, relationships, indexes, authorization, pagination, selected fields, and semantic result sets.
- Same deterministic dataset and virtual-user choices.
- Same workflow weights, think time, timeouts, stage durations, and SLOs.
- Product defaults unless a change is required for correctness.
- All deviations recorded in result metadata.
- No admin API in measured traffic.
- No unbounded list calls.
- No hidden retry differences; SDK defaults and configured retries are recorded.
- Setup and seed work excluded from application TPS.

Architectural differences are results, not defects in the benchmark. Supabase runs a service stack; PocketBase and TrailBase are single-binary SQLite-based systems. Reports must preserve that context.

## 15. Error handling

Errors are classified as:

- expected application rejection
- authentication or authorization failure
- timeout
- transport/SDK failure
- invalid or inconsistent response
- backend health/process failure
- runner overload

Expected denials in correctness tests pass only when the backend rejects the operation for the intended reason. Unexpected errors count against the measured error rate. Error examples are retained up to a configured bound so failures cannot exhaust runner memory.

Startup, reset, seed, or correctness failure aborts the run. A measured-stage failure writes partial results and backend logs before cleanup.

## 16. Result format

Each run writes immutable JSON containing:

```json
{
  "schemaVersion": 1,
  "run": {
    "id": "...",
    "startedAt": "...",
    "publishable": false,
    "backend": "pocketbase",
    "dataset": "small",
    "seed": 42
  },
  "environment": {},
  "versions": {},
  "config": {},
  "correctness": {},
  "stages": [],
  "capacity": {},
  "failures": []
}
```

A generated Markdown report links to the JSON and summarizes environment, validity, capacity, SLO failures, throughput, latency, and resources. Aggregation uses medians from repeated runs and retains run-to-run spread.

## 17. Testing strategy

- Node's built-in test runner for configuration, deterministic generation, metrics, SLOs, capacity selection, and reporting.
- A fake in-memory backend for runner behavior and failure paths.
- One shared live correctness suite executed against every adapter.
- Quick smoke load against each backend before full tests.
- Result-schema fixture tests to protect future Dart compatibility.
- Clean-machine checks on macOS ARM64 and Ubuntu.

Performance tests do not assert exact TPS in CI. They assert valid lifecycle, sufficient samples, no runner failure, and correct SLO/capacity classification from controlled fixtures.

## 18. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Runner saturates on the same host | Capture event-loop/CPU data; invalidate affected stages; later allow remote runner |
| Semantic mismatch between products | Shared correctness suite and documented per-backend deviations |
| Large seeds dominate development time | Small quick profile and bounded batch generation |
| Thermal throttling changes laptop results | Repeat runs, rotate order, report spread and host power state when available |
| Client SDK retries hide errors | Record versions/configuration and disable retries only when all clients can do so equivalently |
| Search semantics diverge | Keep v1 search bounded and simple; add full-text as a separate future suite |
| Auth rate limits or email flows distort local tests | Use documented local password auth and report configuration; lifecycle remains separate |
| Product architecture differs | Report total process/container resources and per-service detail rather than normalizing it away |

## 19. Acceptance criteria for v1

- All three backends start locally from documented commands.
- The same correctness suite passes against all adapters.
- Small and medium datasets seed deterministically.
- The primary mixed workload runs through official JavaScript SDKs.
- A run produces latency percentiles, workflow TPS, SDK-operation TPS, read/write rates, error classes, and resources.
- Capacity follows the documented SLO and saturation rules.
- Invalid runner/backend conditions cannot produce a valid score.
- JSON and Markdown reports include enough metadata to reproduce a run.
- A clean macOS ARM64 and Ubuntu setup can execute the quick profile.

## 20. Current documentation references

- Supabase CLI local development: <https://github.com/supabase/cli>
- Supabase JavaScript client: <https://github.com/supabase/supabase-js>
- PocketBase JavaScript SDK/docs: <https://pocketbase.io/docs/js-overview/>
- TrailBase repository/docs: <https://github.com/trailbaseio/trailbase>

Versions are pinned during implementation and copied into each result; this design intentionally does not freeze versions before the first compatibility spike.
