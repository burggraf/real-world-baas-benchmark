# Hardware-qualified Capacity Benchmark Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Add safe configurable local ports, bounded multi-step capacity refinement, explicit co-located result classification, and a portable server-capacity profile.

**Architecture:** Reuse the existing dynamic adapter loading, stage evaluation, lifecycle ownership, and result-settings compatibility checks. A validated CLI port base becomes one process environment value; PocketBase and TrailBase derive one endpoint, while Supabase derives an owned generated workdir and project label. The stage loop maintains a passing/failing bracket and inserts at most four binary-search midpoints, stopping at the integer-user floor.

**Tech Stack:** Node.js 22+, TypeScript, built-in `node:test`, official backend JavaScript SDKs, Supabase CLI/Docker.

---

### Task 1: Add configurable backend port base

**Files:**
- Modify: `src/cli.ts`
- Modify: `backends/pocketbase/process.ts`
- Modify: `backends/trailbase/process.ts`
- Modify: `backends/supabase/process.ts`
- Test: `test/cli.test.ts`
- Test: `test/pocketbase.test.ts`
- Test: `test/trailbase.test.ts`
- Test: `test/supabase.test.ts`

**Step 1: Write failing tests**

Add tests proving:

- `--port-base 18000` parses for every lifecycle/benchmark command;
- values below 1024, above 65526, fractional, nonnumeric, missing, duplicate, and unsupported-command values fail;
- PocketBase and TrailBase derive `http://127.0.0.1:18000` when `BENCH_PORT_BASE=18000` and explicit backend URLs still win;
- Supabase derives the offset map, unique project ID, and `.data/supabase-18000` workdir;
- custom Supabase workdir preparation writes the expected config/migration, accepts its own marker, and rejects nonempty unowned or mismatched directories.

**Step 2: Verify red**

Run:

```sh
npm run build && node --test dist/test/cli.test.js dist/test/pocketbase.test.js dist/test/trailbase.test.js dist/test/supabase.test.js
```

Expected: failures because port-base parsing and custom Supabase preparation do not exist.

**Step 3: Implement the minimum behavior**

- Add `portBase?: number` to `ParsedArgs`.
- Allow `port-base` only on commands that can load/start a backend.
- Validate integer range `1024..65526` during parsing.
- Set `process.env.BENCH_PORT_BASE` before the first `loadBackend` call.
- Derive PocketBase/TrailBase default URLs from `BENCH_PORT_BASE` unless their explicit URL is present.
- Derive Supabase ports with the existing offsets.
- For custom Supabase ports, use `.data/supabase-N`, project ID `realworldbaasbench-N`, a private ownership marker, generated `supabase/config.toml`, and a copied committed migration.
- Call custom-workdir preparation before Supabase start; keep the default tracked workdir unchanged when no port base is supplied.

**Step 4: Verify green**

Run the targeted command from Step 2 and expect all selected tests to pass.

**Step 5: Commit**

```sh
git add src/cli.ts backends/*/process.ts test/cli.test.ts test/pocketbase.test.ts test/trailbase.test.ts test/supabase.test.ts
git commit -m "feat: make benchmark backend ports configurable"
```

### Task 2: Add bounded multi-step boundary refinement

**Files:**
- Modify: `src/run.ts`
- Modify: `src/result.ts`
- Test: `test/run.test.ts`

**Step 1: Write failing tests**

Add one integration-style fake-run test showing execution order:

```text
5, 10, 25, 50, 100, 200, 400, 800, 1600, 3200, 2400, 2800, 2600, 2500
```

for a pass through 2,500 and failure above it. Add tests that:

- no more than four midpoint stages run;
- a recognized runner-overload failure creates an upper bracket and is refined;
- unrelated invalid stages stop without refinement;
- final raw stages remain unique and sorted.

Use a large bracket to prove four refinements bound runtime and a small bracket to prove integer-user precision is retained.

**Step 2: Verify red**

Run:

```sh
npm run build && node --test dist/test/run.test.js
```

Expected: the current one-midpoint scheduler fails the new execution-order assertions.

**Step 3: Implement the minimum scheduler change**

In `src/run.ts`:

- add constants `MAX_REFINEMENT_STAGES = 4` and `MIN_REFINEMENT_USER_GAP = 1`;
- track the highest passing lower point and lowest qualifying failing upper point;
- recognize the stage-local runner-overload result as a boundary failure only when no other integrity reason exists;
- insert `floor((lower + upper) / 2)` immediately after the current stage;
- stop at the gap/count bounds or any non-boundary failure;
- retain configured-stage and doubling behavior.

Do not create a generic scheduler framework.

**Step 4: Verify green**

Run the targeted test and expect all `run.test` cases to pass.

**Step 5: Commit**

```sh
git add src/run.ts src/result.ts test/run.test.ts
git commit -m "feat: refine capacity boundaries within a run"
```

### Task 3: Record and report topology/refinement settings

**Files:**
- Modify: `src/result.ts`
- Modify: `src/run.ts`
- Modify: `src/report.ts`
- Test: `test/run.test.ts`
- Test: `test/report.test.ts`
- Test: `test/result.test.ts`
- Test: `test/system.test.ts`

**Step 1: Write failing tests**

Assert new runs contain:

```ts
executionTopology: "co-located"
capacityRefinement: {
  method: "bounded-binary-search",
  maxStages: 4,
  minUserGap: 1,
}
```

Assert validation rejects malformed values and generated Markdown includes `co-located`. Retain fixture compatibility when optional settings are absent.

**Step 2: Verify red**

Run:

```sh
npm run build && node --test dist/test/run.test.js dist/test/report.test.js dist/test/result.test.js dist/test/system.test.js
```

Expected: missing settings/report output failures.

**Step 3: Implement minimal schema/report support**

Add optional typed settings for schema-version-1 backward compatibility, validate exact allowed values when present, emit them for every new run, and add topology to the report Run table.

**Step 4: Verify green**

Run the targeted command and expect all selected tests to pass.

**Step 5: Commit**

```sh
git add src/result.ts src/run.ts src/report.ts test/run.test.ts test/report.test.ts test/result.test.ts test/system.test.ts
git commit -m "feat: classify co-located capacity results"
```

### Task 4: Add the portable server profile and operating documentation

**Files:**
- Create: `configs/server-capacity.json`
- Modify: `test/config.test.ts`
- Modify: `README.md`
- Modify: `docs/methodology.md`
- Modify: `docs/plans/2026-08-22-hardware-capacity-benchmark-design.md`

**Step 1: Write the failing config test**

Verify the new config is identical to `configs/full.json` except for name and `maxConcurrency`, with `maxConcurrency === 10000`.

**Step 2: Verify red**

Run:

```sh
npm run build && node --test dist/test/config.test.js
```

Expected: failure because the config is absent.

**Step 3: Add config and concise docs**

Document:

- `--port-base 18000` examples;
- derived Supabase offsets and owned workdir;
- co-located interpretation;
- the bounded four-stage/integer-floor refinement rule;
- three compatible repetitions per hardware profile;
- the occupied-host one-backend-at-a-time protocol;
- external-runner mode as explicitly deferred rather than implied.

Replace obsolete claims about fixed Supabase ports, one midpoint, and unavailable Ubuntu hardware.

**Step 4: Verify green**

Run the config test and expect it to pass.

**Step 5: Commit**

```sh
git add configs/server-capacity.json test/config.test.ts README.md docs/methodology.md docs/plans/2026-08-22-hardware-capacity-benchmark-*.md
git commit -m "docs: define hardware-qualified capacity runs"
```

### Task 5: Full verification and review

**Files:**
- Review all files changed above.

**Step 1: Run full checks**

```sh
npm test
git diff --check
git status --short
```

Expected: all non-live tests pass, only intended files plus preserved `next.txt` appear, and no whitespace errors occur.

**Step 2: Run independent reviews**

Use fresh specification and code-quality reviewers. Fix only verified findings, test-first where behavior changes.

**Step 3: Re-run verification**

Repeat Step 1 after fixes.

**Step 4: Push approved commits**

```sh
git push origin main
```

### Task 6: Verify the occupied Ubuntu deployment path

**Files:**
- No repository changes unless a reproducible defect is found.
- Raw artifacts stay under ignored `results/` and are copied to durable storage.

**Step 1: Inspect without changing services**

Record toolchain, ports, Docker access, Git state, load, memory, and disk. Confirm ports 18000 through 18009 are unused.

**Step 2: Create/update a dedicated clean clone**

Check out the pushed commit, run `npm ci`, stage pinned Linux x64 binaries using the downloader's exact instructions, and install Supabase CLI 2.115.0 without altering existing backend services.

**Step 3: Verify software**

```sh
npm test
npm run bench -- doctor --backend pocketbase --port-base 18000
npm run bench -- doctor --backend trailbase --port-base 18000
npm run bench -- doctor --backend supabase --port-base 18000
```

Expected: all tests and doctors pass while existing service identities remain unchanged.

**Step 4: Run a quick sequential preflight**

Run each backend separately with `configs/quick.json`, retaining all artifacts. Do not launch the multi-hour publishable series until the preflight and host record are reviewed.
