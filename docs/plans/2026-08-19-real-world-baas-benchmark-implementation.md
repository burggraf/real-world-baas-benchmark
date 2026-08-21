# Real-World BaaS Benchmark Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Build a local TypeScript benchmark that measures realistic project-management application capacity across Supabase, PocketBase, and TrailBase through their official JavaScript clients.

**Architecture:** A shared Node.js runner executes deterministic virtual-user journeys against thin backend adapters. Each adapter provides equivalent auth, CRUD, pagination, and authorization behavior while JSON results preserve backend, SDK, workload, environment, and resource metadata.

**Tech Stack:** Node.js 22 LTS, TypeScript, Node's built-in test runner, official Supabase/PocketBase/TrailBase JavaScript clients, Supabase CLI and Docker, pinned PocketBase and TrailBase binaries.

---

## Working rules

- Read `docs/plans/2026-08-19-real-world-baas-benchmark-design.md` before starting.
- Keep one workload contract; do not build a plugin framework.
- Use test-first steps for logic.
- Use ordinary user credentials for measured operations.
- Never publish results from the quick profile.
- Commit after each task once its checks pass.
- Pin exact package and backend versions when compatibility is proven; do not guess versions from this plan.

## Target command surface

```bash
npm run bench -- doctor
npm run bench -- up --backend pocketbase
npm run bench -- reset --backend pocketbase --dataset small --seed 42
npm run bench -- correctness --backend pocketbase
npm run bench -- run --backend pocketbase --config configs/quick.json
npm run bench -- compare --config configs/full.json
npm run bench -- down --backend pocketbase
npm run bench -- report results/<run>.json
```

## Task 1: Bootstrap the TypeScript project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.node-version`
- Create: `src/cli.ts`
- Create: `test/cli.test.ts`
- Create: `README.md`

**Step 1: Initialize the repository if needed**

Run:

```bash
git init
npm init -y
```

Expected: a new Git repository and `package.json` exist.

**Step 2: Install only the initial build dependency**

Run:

```bash
npm install --save-dev typescript @types/node
```

Expected: `package-lock.json` is created. Do not install SDKs until their adapter tasks.

**Step 3: Configure ESM and scripts**

Set `package.json` scripts to:

```json
{
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "npm run build && node --test dist/test/**/*.test.js",
    "bench": "npm run build --silent && node dist/src/cli.js"
  }
}
```

Use this minimal `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": ".",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "backends/**/*.ts", "test/**/*.ts"]
}
```

Write `22` to `.node-version`. Ignore `node_modules/`, `dist/`, backend data directories, binaries, and `results/*` except `results/.gitkeep`.

**Step 4: Write the failing CLI test**

```ts
// test/cli.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/cli.js";

test("parses a backend command", () => {
  assert.deepEqual(parseArgs(["doctor", "--backend", "pocketbase"]), {
    command: "doctor",
    backend: "pocketbase",
  });
});
```

**Step 5: Run the test and verify failure**

Run: `npm test`  
Expected: compilation fails because `parseArgs` does not exist.

**Step 6: Add the smallest CLI parser**

Implement an exported `parseArgs(argv: string[])` using a loop over `process.argv.slice(2)`. Support a command and `--key value` options. Reject missing option values and unknown duplicate options. Do not add a CLI library.

**Step 7: Add help output and entry-point guard**

`npm run bench -- --help` must print the target command surface and exit zero. A missing command must print help and exit nonzero.

**Step 8: Verify**

Run:

```bash
npm test
npm run bench -- --help
```

Expected: tests pass and help lists `doctor`, `up`, `reset`, `correctness`, `run`, `compare`, `down`, and `report`.

**Step 9: Commit**

```bash
git add .
git commit -m "chore: bootstrap benchmark runner"
```

## Task 2: Define and validate configuration

**Files:**
- Create: `src/config.ts`
- Create: `configs/quick.json`
- Create: `configs/full.json`
- Create: `test/config.test.ts`

**Step 1: Write failing validation tests**

Cover:

- quick config parses;
- unknown backend fails;
- workflow weights must total 100;
- durations and concurrency must be positive;
- stages must be strictly increasing;
- SLO error rate must be between 0 and 1;
- dataset must be `small`, `medium`, or `large`.

Example:

```ts
test("rejects workflow weights that do not total 100", () => {
  assert.throws(() => parseConfig({ ...validConfig, weights: { dashboard: 99 } }), /weights.*100/);
});
```

**Step 2: Verify failure**

Run: `npm test`  
Expected: compilation fails because `parseConfig` is missing.

**Step 3: Add explicit configuration types**

The top-level shape must contain:

```ts
type BenchmarkConfig = {
  name: string;
  publishable: boolean;
  dataset: "small" | "medium" | "large";
  seed: number;
  warmupSeconds: number;
  stageSeconds: number;
  concurrency: number[];
  maxConcurrency: number;
  timeoutMs: number;
  thinkTimeMs: { min: number; max: number };
  weights: Record<WorkflowName, number>;
  slos: Record<OperationClass, { p95Ms: number; maxErrorRate: number }>;
};
```

Validate parsed JSON with small local assertion helpers. This is a trust boundary; do not cast unknown JSON directly and do not add a schema library for two config files.

**Step 4: Add profiles**

`configs/quick.json`:

- `publishable: false`
- small dataset
- 5-second warm-up
- 15-second stages
- concurrency `[1, 5, 10]`
- maximum 10

`configs/full.json`:

- `publishable: true`
- medium dataset
- 120-second warm-up
- 300-second stages
- concurrency `[5, 10, 25, 50]`
- a configurable maximum, initially 1,000

The five-user publishable floor preserves the 20-sample minimum for every active class without changing fixed stage duration or workload weights. Capacity is established only within the measured range; zero means no qualifying stage at or above five users. One-user quick evidence remains separate and nonpublishable.

Both use approved weights and SLOs from the design.

**Step 5: Verify**

Run: `npm test`  
Expected: all configuration tests pass.

**Step 6: Commit**

```bash
git add src/config.ts configs test/config.test.ts
git commit -m "feat: add benchmark configuration"
```

## Task 3: Define domain, result, and adapter contracts

**Files:**
- Create: `src/domain.ts`
- Create: `src/backend.ts`
- Create: `src/result.ts`
- Create: `test/result.test.ts`

**Step 1: Write the result fixture test**

Create a minimal valid `BenchmarkResult` fixture, serialize it, parse it back, and assert `schemaVersion === 1`, backend name, dataset, stages, validity, and capacity are retained.

**Step 2: Verify failure**

Run: `npm test`  
Expected: missing contract modules.

**Step 3: Add domain types**

Define IDs as strings at the shared boundary even where a backend stores integers. Add types for users, organizations, projects, tasks, comments, activity, pages, credentials, and each workflow input/output. Keep types data-only.

**Step 4: Add the two-level adapter contract**

Add `Backend` for lifecycle/seeding/session creation and `AppSession` for measured user actions, matching the design document. Include `close()` on sessions to release SDK resources.

Do not create factories or registries. Add one function:

```ts
export async function loadBackend(name: BackendName): Promise<Backend> {
  switch (name) {
    case "pocketbase": return (await import("../backends/pocketbase/adapter.js")).backend;
    case "supabase": return (await import("../backends/supabase/adapter.js")).backend;
    case "trailbase": return (await import("../backends/trailbase/adapter.js")).backend;
  }
}
```

Temporary adapter files may throw `NotImplemented` so compilation succeeds until their tasks.

**Step 5: Add result types**

Include schema version, run identity, environment, versions, exact config, correctness result, stage metrics, capacity, failures, and validity reasons. Store elapsed times as integer microseconds or milliseconds consistently; document the unit in field names.

**Step 6: Verify**

Run: `npm test`  
Expected: result round-trip test passes.

**Step 7: Commit**

```bash
git add src backends test/result.test.ts
git commit -m "feat: define benchmark contracts"
```

## Task 4: Build deterministic dataset generation

**Files:**
- Create: `src/random.ts`
- Create: `src/seed.ts`
- Create: `test/seed.test.ts`

**Step 1: Write failing determinism tests**

Assert that:

- two generators using seed 42 emit identical first and last records;
- seed 43 differs;
- generated foreign keys refer to generated parents;
- profile counts match the design;
- generation yields bounded batches instead of retaining the whole dataset.

**Step 2: Verify failure**

Run: `npm test`  
Expected: generator imports fail.

**Step 3: Implement one tiny seeded PRNG**

Use a documented 32-bit generator such as Mulberry32 in `src/random.ts`. Do not add a faker dependency. Generate readable deterministic names and text from small local word arrays.

Add this upgrade note beside the generator:

```ts
// ponytail: synthetic text is intentionally small; use a versioned corpus only if payload realism changes measured results.
```

**Step 4: Implement async batch generation**

Expose an async generator yielding ordered batches:

1. users
2. organizations
3. memberships
4. projects
5. tasks
6. comments
7. activities

Default batch size: 1,000. IDs must be stable from `(profile, entity, ordinal)` and portable across all backends.

**Step 5: Verify**

Run: `npm test`  
Expected: deterministic generation and relationship tests pass without large memory growth.

**Step 6: Commit**

```bash
git add src/random.ts src/seed.ts test/seed.test.ts
git commit -m "feat: generate deterministic benchmark data"
```

## Task 5: Add the shared correctness suite and fake backend

**Files:**
- Create: `src/correctness.ts`
- Create: `test/fake-backend.ts`
- Create: `test/correctness.test.ts`

**Step 1: Write a failing correctness-suite test**

The fake backend should initially allow a cross-tenant task read. Assert that `runCorrectness(fakeBackend)` fails with a tenant-isolation finding.

**Step 2: Verify failure**

Run: `npm test`  
Expected: missing correctness runner.

**Step 3: Implement the minimum shared checks**

Run through public adapter methods and verify:

- password sign-in succeeds and bad credentials fail;
- own profile read/update works;
- project/task/comment create, read, update, list, and bounded pagination work;
- stable ordering has no duplicates across pages;
- member can access own tenant;
- outsider cannot read or mutate tenant data;
- ordinary member cannot change roles;
- admin can change a role;
- session refresh and sign-out behavior works;
- returned IDs and required fields are valid.

Return structured findings; do not throw on the first application failure. Abort only on backend health loss.

**Step 4: Fix the fake backend**

Enforce tenant isolation and assert the suite passes. Add targeted fake failure modes for auth, timeout, malformed response, and process health loss.

**Step 5: Verify**

Run: `npm test`  
Expected: correctness tests pass and each failure mode is classified.

**Step 6: Commit**

```bash
git add src/correctness.ts test
git commit -m "feat: add shared backend correctness suite"
```

## Task 6: Implement the PocketBase vertical slice

**Files:**
- Modify: `package.json`
- Create: `backends/pocketbase/adapter.ts`
- Create: `backends/pocketbase/process.ts`
- Create: `backends/pocketbase/pb_migrations/0001_benchmark.js`
- Create: `backends/pocketbase/README.md`
- Create: `test/pocketbase.live.test.ts`

**Step 1: Run a compatibility spike before writing adapter code**

Download a PocketBase release for the current OS/architecture into an ignored `.tools/` directory, record its version, and verify:

```bash
.tools/pocketbase --version
.tools/pocketbase serve --dir .data/pocketbase
```

Expected: the binary starts on the documented local port. Stop it after the check.

**Step 2: Install and pin the official SDK**

Run: `npm install --save-exact pocketbase@<verified-compatible-version>`  
Expected: lockfile pins the tested version.

**Step 3: Write the live test first**

Gate it behind `BENCH_LIVE=1`. Start a clean PocketBase process, apply migrations, seed the small correctness fixture, call `runCorrectness`, and assert success. Without `BENCH_LIVE=1`, mark it skipped.

**Step 4: Verify expected failure**

Run: `BENCH_LIVE=1 npm test`  
Expected: PocketBase adapter reports not implemented.

**Step 5: Add one migration**

Create auth and base collections for the canonical model, API rules, uniqueness constraints, and required indexes. Store activity as its own collection. Rules must enforce the approved tenant and role semantics.

Use PocketBase JS migrations; do not require manual dashboard setup.

**Step 6: Implement lifecycle and seed methods**

- `doctor`: binary path/version and port availability
- `start`: spawn pinned binary and wait for health
- `reset`: stop and remove only the configured ignored data directory, then restart
- `seed`: authenticate as setup superuser and insert generated batches
- `stop`: terminate only the process started by this run

Capture stdout/stderr to the run artifact directory.

**Step 7: Implement user sessions through the SDK**

Create one `PocketBase` client per virtual user because the SDK auth store is mutable. Implement paginated `getList`, bounded relation expansion, create/update, auth refresh, and sign-out. Never use `getFullList` in measured workflows.

**Step 8: Run correctness**

Run:

```bash
BENCH_LIVE=1 npm test
```

Expected: PocketBase live correctness passes.

**Step 9: Commit**

```bash
git add package.json package-lock.json backends/pocketbase test/pocketbase.live.test.ts
git commit -m "feat: add PocketBase benchmark adapter"
```

## Task 7: Implement the Supabase adapter

**Files:**
- Modify: `package.json`
- Create: `backends/supabase/adapter.ts`
- Create: `backends/supabase/process.ts`
- Create: `backends/supabase/supabase/config.toml`
- Create: `backends/supabase/supabase/migrations/0001_benchmark.sql`
- Create: `backends/supabase/README.md`
- Create: `test/supabase.live.test.ts`

**Step 1: Run a CLI compatibility spike**

Verify the installed Supabase CLI and Docker:

```bash
supabase --version
docker version
cd backends/supabase && supabase start && supabase status -o json
```

Expected: local URL and keys are available as JSON. Then run `supabase stop --no-backup`.

If local directory initialization is required, run it once and retain only the minimal generated configuration needed by this project.

**Step 2: Install and pin the official SDK**

Run: `npm install --save-exact @supabase/supabase-js@<verified-compatible-version>`

**Step 3: Write the gated live test**

Match the PocketBase live test and call the same `runCorrectness` function.

**Step 4: Verify expected failure**

Run: `BENCH_LIVE=1 npm test`  
Expected: Supabase adapter reports not implemented.

**Step 5: Add SQL schema and RLS**

Create canonical tables, foreign keys, unique constraints, and indexes. Enable row-level security on every application table. Add policies for self-profile access, tenant reads/writes, and role administration. Activity insertion must be available to normal members without granting cross-tenant access.

Do not add database functions merely to make Supabase use fewer SDK calls unless equivalent application semantics require an atomic server operation on every backend.

**Step 6: Implement lifecycle and setup**

Use documented local commands:

- start: `supabase start`
- health/config: `supabase status -o json`
- reset/migrations: `supabase db reset`
- stop: `supabase stop --no-backup`

Parse status JSON rather than scraping human output. Keep the service-role key in memory and artifacts marked sensitive; never print it in reports.

**Step 7: Implement sessions through `@supabase/supabase-js`**

Create isolated auth state per virtual user. Configure Node-safe nonpersistent auth storage, explicitly check `{ data, error }`, use bounded `.range()`, stable ordering, selected fields, and normal authenticated RLS paths.

**Step 8: Run correctness**

Run: `BENCH_LIVE=1 npm test`  
Expected: Supabase live correctness passes.

**Step 9: Commit**

```bash
git add package.json package-lock.json backends/supabase test/supabase.live.test.ts
git commit -m "feat: add Supabase benchmark adapter"
```

## Task 8: Implement the TrailBase adapter

**Files:**
- Modify: `package.json`
- Create: `backends/trailbase/adapter.ts`
- Create: `backends/trailbase/process.ts`
- Create: `backends/trailbase/traildepot/config.textproto`
- Create: `backends/trailbase/traildepot/migrations/0001_benchmark.sql`
- Create: `backends/trailbase/README.md`
- Create: `test/trailbase.live.test.ts`

**Step 1: Run a binary and client compatibility spike**

Download a TrailBase release for the current OS/architecture to `.tools/`, record its version, start a disposable traildepot, and verify its health and auth/record endpoints. Confirm the exact official npm package name and current API from TrailBase's repository before pinning it; documentation examples may lag releases.

**Step 2: Install the verified official client exactly**

Run: `npm install --save-exact <verified-trailbase-client>@<verified-version>`

**Step 3: Write the gated live test**

Use the same correctness suite and expected result as both existing adapters.

**Step 4: Verify expected failure**

Run: `BENCH_LIVE=1 npm test`  
Expected: TrailBase adapter reports not implemented.

**Step 5: Add migrations and Record API configuration**

Create strict SQLite tables, foreign keys, uniqueness constraints, and indexes. Configure one or more Record APIs with authenticated ACLs and access rules that implement the shared tenant semantics. Prefer views only where needed to expose an equivalent bounded response.

**Step 6: Implement lifecycle and seed methods**

Start the pinned binary with the repository-owned traildepot, wait for health, capture logs, and clean only the configured ignored data path. Use administrative setup APIs or migration/seed facilities outside measured traffic.

**Step 7: Implement SDK sessions**

Create independent auth state per virtual user. Use Record API list/read/create/update methods with bounded limits, stable order, cursor/offset semantics documented in metadata, and explicit errors.

**Step 8: Run correctness and document deviations**

Run: `BENCH_LIVE=1 npm test`  
Expected: TrailBase correctness passes. Any unavoidable semantic difference is added to `backends/trailbase/README.md` and result metadata; do not hide it in the adapter.

**Step 9: Commit**

```bash
git add package.json package-lock.json backends/trailbase test/trailbase.live.test.ts
git commit -m "feat: add TrailBase benchmark adapter"
```

## Task 9: Implement deterministic workload journeys

**Files:**
- Create: `src/workflows.ts`
- Create: `src/workload.ts`
- Create: `test/workload.test.ts`

**Step 1: Write failing selection tests**

With a fixed random sequence, assert 10,000 selected workflows match configured weights within a small deterministic tolerance. Assert every list uses a configured page size and every virtual user remains inside its assigned tenant.

**Step 2: Write a failing closed-model test**

Using the fake backend, block one operation and assert that virtual user does not issue another operation before the first completes. Advance injected fake sleep/time instead of waiting in real time.

**Step 3: Verify failure**

Run: `npm test`  
Expected: workload modules missing.

**Step 4: Implement workflows**

Add dashboard, task list/detail, create/update task, add comment, search, profile update, and sign-out/sign-in journeys. Time the full journey and each adapter call. Validate required response fields and tenant IDs.

Use deterministic per-user random streams derived from run seed and virtual-user index. This preserves choices when concurrency changes.

**Step 5: Implement virtual-user scheduling**

Use `AbortController`, `performance.now()`, and promise loops. Inject `now` and `sleep` into tests. Stop launching work at stage end and allow a bounded grace period for in-flight work.

**Step 6: Verify**

Run: `npm test`  
Expected: deterministic weights, closed-model behavior, cancellation, and validation tests pass.

**Step 7: Commit**

```bash
git add src/workflows.ts src/workload.ts test/workload.test.ts
git commit -m "feat: add realistic virtual-user workload"
```

## Task 10: Implement metrics and bounded error capture

**Files:**
- Create: `src/metrics.ts`
- Create: `test/metrics.test.ts`

**Step 1: Write failing metric tests**

Use a known latency set and assert counts, rate, min, max, p50, p95, and p99. Cover timeouts, auth errors, transport errors, invalid responses, expected rejections, and a maximum retained-example count.

**Step 2: Verify failure**

Run: `npm test`  
Expected: metrics module missing.

**Step 3: Implement the minimum accurate accumulator**

Start with per-stage numeric latency arrays by operation, sorted once at finalization. Record an explicit maximum sample count and invalidate a stage if it is exceeded rather than silently sampling inaccurate percentiles.

Add:

```ts
// ponytail: exact in-memory samples are simplest; replace with HDR histograms when a real run reaches the configured sample ceiling.
```

Do not add a histogram dependency before measured volume requires it.

**Step 4: Add operation dimensions**

Every sample includes workflow, SDK operation, operation class, read/write kind, status, and elapsed time. Compute workflow TPS separately from SDK-operation TPS.

**Step 5: Verify**

Run: `npm test`  
Expected: all known-value and bound tests pass.

**Step 6: Commit**

```bash
git add src/metrics.ts test/metrics.test.ts
git commit -m "feat: collect benchmark latency and throughput"
```

## Task 11: Implement SLO, saturation, and capacity evaluation

**Files:**
- Create: `src/capacity.ts`
- Create: `test/capacity.test.ts`

**Step 1: Write table-driven failing tests**

Cover:

- all stages pass;
- latency fails before error rate;
- error rate fails;
- throughput plateaus with rising latency;
- runner overload invalidates a stage;
- no passing stage returns no capacity;
- a failing stage after a passing stage selects the last pass.

Example:

```ts
test("capacity is the last valid SLO-passing stage", () => {
  assert.equal(evaluateCapacity([pass(25), pass(50), failLatency(100)]).users, 50);
});
```

**Step 2: Verify failure**

Run: `npm test`  
Expected: evaluator missing.

**Step 3: Implement explicit rules**

For each stage:

1. reject invalid runner/backend stages;
2. require minimum samples per active operation class;
3. compare per-class p95 and error rate to config;
4. compare achieved/requested concurrency;
5. flag saturation only when concurrency materially increases, throughput gain is under 10%, and latency/queueing rises.

Return reasons and evidence, not only a number.

**Step 4: Verify**

Run: `npm test`  
Expected: capacity tests pass.

**Step 5: Commit**

```bash
git add src/capacity.ts test/capacity.test.ts
git commit -m "feat: evaluate SLO capacity and saturation"
```

## Task 12: Capture environment and resource utilization

**Files:**
- Create: `src/system.ts`
- Create: `test/system.test.ts`

**Step 1: Write parser tests before shell integration**

Add fixtures for macOS `sysctl`/`ps`, Linux `/proc` or `lscpu`/`ps`, and Docker stats JSON. Assert CPU model, core count, memory, architecture, process RSS/CPU, and Supabase container totals parse correctly.

**Step 2: Verify failure**

Run: `npm test`  
Expected: parsers missing.

**Step 3: Implement environment capture with standard tools**

Use `node:os`, `process.versions`, and `child_process.spawn` with argument arrays. Never invoke a shell with interpolated values. Add platform-specific commands only for data Node does not expose.

Capture:

- OS/release/architecture
- CPU model/logical cores
- total memory
- Node and npm versions
- backend and SDK versions
- Docker and Supabase CLI versions where applicable
- Git commit and dirty state

**Step 4: Implement resource sampling**

Sample runner resource usage and registered backend process IDs at a configurable interval. For Supabase, aggregate `docker stats --no-stream --format '{{json .}}'` for this project's containers and retain per-container values.

If a metric is unavailable, record `null` plus a reason; do not substitute zero.

**Step 5: Add runner overload checks**

Record event-loop delay using Node's `monitorEventLoopDelay`. Mark a stage invalid when configured CPU/event-loop thresholds show the runner cannot sustain requested work.

**Step 6: Verify**

Run:

```bash
npm test
npm run bench -- doctor
```

Expected: parser tests pass and doctor prints environment data without secrets.

**Step 7: Commit**

```bash
git add src/system.ts test/system.test.ts
git commit -m "feat: capture benchmark environment and resources"
```

## Task 13: Wire lifecycle and run orchestration into the CLI

**Files:**
- Modify: `src/cli.ts`
- Create: `src/run.ts`
- Create: `test/run.test.ts`

**Step 1: Write failing orchestration tests using the fake backend**

Assert call order:

```text
doctor -> start -> reset -> seed -> correctness -> warmup -> stages -> result write -> stop
```

Also assert:

- reset failure prevents measured work;
- correctness failure prevents measured work;
- stage failure writes a partial invalid result;
- stop runs in `finally`;
- secrets are redacted from output.

**Step 2: Verify failure**

Run: `npm test`  
Expected: run orchestrator missing.

**Step 3: Implement `run`**

Use the configured backend and exact lifecycle above. Create the result directory before startup so logs survive early failure. Use ISO timestamps plus backend/config in run IDs; avoid random IDs when timestamp and backend are unique enough.

**Step 4: Implement automatic stage extension**

After configured stages pass, double concurrency up to `maxConcurrency`. Stop after a clear failure. Add a simple midpoint refinement stage between last pass and first fail when the gap is useful.

**Step 5: Wire CLI commands**

- `doctor`: all or selected backend prerequisites
- `up` / `down`: explicit lifecycle
- `reset`: reset and seed selected profile
- `correctness`: shared suite
- `run`: one full run
- `compare`: sequential runs only; no parallel backends

**Step 6: Verify with fake backend**

Run: `npm test`  
Expected: lifecycle and cleanup tests pass.

**Step 7: Run quick live smoke tests**

For each available backend:

```bash
npm run bench -- run --backend pocketbase --config configs/quick.json
npm run bench -- run --backend supabase --config configs/quick.json
npm run bench -- run --backend trailbase --config configs/quick.json
```

Expected: each writes valid JSON and exits cleanly. Missing backends should fail in `doctor`, not halfway through a run.

**Step 8: Commit**

```bash
git add src/cli.ts src/run.ts test/run.test.ts
git commit -m "feat: orchestrate complete benchmark runs"
```

## Task 14: Generate Markdown reports and repeated-run comparisons

**Files:**
- Create: `src/report.ts`
- Create: `src/aggregate.ts`
- Create: `test/report.test.ts`
- Create: `test/fixtures/result-pass.json`
- Create: `test/fixtures/result-fail.json`

**Step 1: Write snapshot-style assertions without a snapshot library**

Generate Markdown from fixed JSON and assert exact important sections:

- environment and versions
- valid/invalid banner
- capacity and reason
- stage throughput/latency table
- operation-class SLO table
- resource table
- failures/deviations
- raw JSON link

**Step 2: Write aggregation tests**

Given three valid runs, assert median capacity/TPS/latency and min/max spread. Assert incompatible backend versions, configs, datasets, or seeds cannot be aggregated without an explicit override.

**Step 3: Verify failure**

Run: `npm test`  
Expected: report modules missing.

**Step 4: Implement reporting**

Use string templates and standard array operations. Do not add a templating, statistics, or charting dependency. Emit Markdown and CSV stage tables alongside JSON.

**Step 5: Implement comparison rules**

Compare only compatible runs. Keep backend architecture and total resource usage visible. Never calculate a single vendor ranking that combines latency, capacity, and resources into an unexplained score.

**Step 6: Verify**

Run:

```bash
npm test
npm run bench -- report test/fixtures/result-pass.json
```

Expected: tests pass and a Markdown report is written.

**Step 7: Commit**

```bash
git add src/report.ts src/aggregate.ts test
git commit -m "feat: report and aggregate benchmark results"
```

## Task 15: Add dataset profiles and seeding performance checks

**Files:**
- Modify: `src/seed.ts`
- Modify: `configs/full.json`
- Create: `configs/large.json`
- Create: `test/seed-performance.test.ts`

**Step 1: Add a bounded-memory test**

Generate the medium profile without a backend sink and assert batches never exceed the configured size. Record elapsed generation time for information; do not assert a brittle speed threshold.

**Step 2: Verify current behavior**

Run: `npm test`  
Expected: bounded batching passes before attempting live seed work.

**Step 3: Seed each backend's medium profile**

Run reset/seed separately and record setup time and data size. If a backend's administrative SDK path is too slow, add a backend-native bulk setup path only for unmeasured seeding and document it.

**Step 4: Add large profile configuration**

`configs/large.json` must remain non-default and require an explicit confirmation flag because it creates millions of records.

**Step 5: Verify record counts**

Add backend setup checks that count every entity after seed and compare against profile definitions before correctness/load runs.

**Step 6: Commit**

```bash
git add src/seed.ts configs test/seed-performance.test.ts
git commit -m "feat: add medium and large dataset profiles"
```

## Task 16: Reproducibility and clean-machine documentation

**Files:**
- Modify: `README.md`
- Create: `docs/methodology.md`
- Create: `docs/results.md`
- Create: `scripts/download-backends.mjs`
- Create: `test/download-backends.test.ts`

**Step 1: Write checksum parser tests**

Before adding downloads, test release-manifest parsing, OS/architecture selection, checksum verification, and refusal to overwrite a different binary.

**Step 2: Implement the minimum download helper**

Use Node `fetch`, streams, `crypto`, and archive tools already available on the target platform. Pin URLs and SHA-256 checksums in one small data object. If portable archive extraction becomes complex, document manual install instead of adding a package.

**Step 3: Complete setup documentation**

Document:

- Node 22 installation
- Supabase CLI and Docker prerequisites
- backend binary download/checksum
- ports and ignored data paths
- quick correctness and smoke commands
- full-run duration and disk expectations
- result validity rules
- laptop power, thermal, and background-process guidance
- how to rotate backend order for three-run comparisons
- why results cannot be generalized beyond recorded hardware/configuration

**Step 4: Verify on macOS ARM64**

From a clean clone:

```bash
npm ci
npm test
npm run bench -- doctor
npm run bench -- run --backend pocketbase --config configs/quick.json
npm run bench -- run --backend supabase --config configs/quick.json
npm run bench -- run --backend trailbase --config configs/quick.json
```

Expected: all tests and quick runs pass.

**Step 5: Verify on Ubuntu**

Repeat the same commands on a clean VPS. Record OS/kernel, CPU, memory, backend versions, and any documented deviations.

**Step 6: Commit**

```bash
git add README.md docs scripts test/download-backends.test.ts
git commit -m "docs: document reproducible benchmark runs"
```

## Task 17: Produce the first publishable comparison

**Files:**
- Create: `results/.gitkeep`
- Create: `docs/results/first-comparison.md`
- Modify: `docs/results.md`

**Step 1: Prepare the host**

Use AC power, disable avoidable background jobs, leave product defaults unchanged, and record the clean Git commit. Confirm all correctness suites pass.

**Step 2: Rotate run order**

Execute three full medium-dataset runs per backend using a balanced order, for example:

```text
Run set 1: Supabase -> PocketBase -> TrailBase
Run set 2: PocketBase -> TrailBase -> Supabase
Run set 3: TrailBase -> Supabase -> PocketBase
```

Allow a fixed cooldown between backends.

**Step 3: Validate every run**

Reject any run with correctness failure, backend restart, runner overload, missed concurrency, insufficient samples, or configuration mismatch. Repeat rejected runs and retain them as invalid artifacts.

**Step 4: Aggregate results**

Report median and spread for capacity, workflow TPS, SDK-operation TPS, read/write operations per second, p95/p99 latency, CPU, memory, and disk usage. Include full stage curves.

**Step 5: Review claims**

Every conclusion must name the machine, backend/client versions, medium dataset, active-workday mix, think time, and SLO. Do not claim universal vendor superiority.

**Step 6: Commit the report, not bulky raw data**

Store raw results in a release artifact or documented external location if large. Commit the human-readable report and checksums/links.

```bash
git add docs/results docs/results.md
git commit -m "docs: publish first local BaaS comparison"
```

## Deferred work

Add only after v1 produces trustworthy results:

1. Dart runner using the same JSON config/result contracts.
2. Realtime subscription/fan-out suite.
3. File storage suite with fixed payload corpus.
4. Remote load-generator mode for isolating server hardware.
5. Full-text search suite with explicitly comparable semantics.
6. Regression command comparing a candidate run to a saved baseline.
7. HDR histogram storage if exact samples hit the configured ceiling.

## Final verification checklist

Run immediately before declaring v1 complete:

```bash
npm ci
npm test
npm run bench -- doctor
npm run bench -- correctness --backend pocketbase
npm run bench -- correctness --backend supabase
npm run bench -- correctness --backend trailbase
npm run bench -- run --backend pocketbase --config configs/quick.json
npm run bench -- run --backend supabase --config configs/quick.json
npm run bench -- run --backend trailbase --config configs/quick.json
```

Expected:

- unit tests pass;
- all live correctness suites pass;
- all quick runs produce valid JSON and Markdown;
- no report contains credentials;
- every result includes environment and exact versions;
- quick results are marked non-publishable.
