# Benchmark methodology

## Question and scope

The benchmark asks:

> On the recorded local host, how many concurrent active users can this project-management application support through the selected official JavaScript SDK while its configured latency, error, sampling, lifecycle, and runner-validity requirements hold?

The answer is qualified by the raw result's Git commit, dirty state, host name, OS/kernel release, architecture, CPU model/core count, memory, Node/npm, backend/CLI, SDK, Docker where applicable, config, dataset, seed, endpoint, known backend deviations, and resource samples. It is not a hosted-service test, a cost comparison, an isolated query microbenchmark, or a claim about other machines or configurations. Realtime and file storage are outside this suite.

## Compatibility baseline

- Runtime: Node.js `>=22`.
- Supabase CLI: `2.115.0`; SDK: `@supabase/supabase-js@2.112.3`.
- PocketBase server: `0.39.11`; SDK: `pocketbase@0.28.0`.
- TrailBase server: `0.33.1`; SDK: `trailbase@0.14.0`.
- npm dependencies: the committed `package-lock.json` installed with `npm ci`.
- PocketBase and TrailBase: pinned release archives fetched and verified with `node scripts/download-backends.mjs`; missing binaries are manually copied from its private staging instructions, and both doctors check the exact current-target executable digest before version probing.

Do not mix results after changing a backend binary, CLI, SDK, lockfile, schema, config, workload, seed, host, or benchmark settings.

## Application and deterministic data

The application models users, organizations, memberships and roles, projects, tasks, comments, and activity history with tenant authorization and required indexes. The profile counts are:

| Profile | Organizations | Users | Memberships | Projects | Tasks | Comments | Activities | Total app records |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small | 100 | 1,000 | 1,000 | 500 | 10,000 | 30,000 | 20,000 | 62,600 |
| medium | 1,000 | 10,000 | 10,000 | 5,000 | 100,000 | 300,000 | 200,000 | 626,000 |
| large | 10,000 | 100,000 | 100,000 | 50,000 | 1,000,000 | 3,000,000 | 2,000,000 | 6,260,000 |

The generator uses the profile plus integer seed (the committed configs use `42`) to produce stable lowercase IDs, relationships, roles, enums, null placement, text, and timestamps. It streams bounded batches rather than retaining the whole dataset. Every backend verifies the exact canonical entity counts after setup and before correctness/load work. The large profile is nonpublishable by default and requires `--confirm-large`.

Each virtual user receives deterministic ordinary credentials and tenant/project/task context. A per-user PRNG derived from the config seed selects workflows, page sizes, payload suffixes, and think time. Runtime scheduling and backend state still make exact transaction counts and timings nondeterministic; the seed makes the requested workload reproducible, not the measured latency.

## Credentials and setup separation

Measured sessions authenticate as ordinary application users through the official SDK and normal authorization policy. Privileged paths are deliberately unmeasured:

- Supabase service-role/admin operations provision auth users, seed, validate counts, and clean up.
- PocketBase's setup superuser is provisioned by migration and used only for setup/seed/cleanup.
- TrailBase's promoted setup user and its documented owned-depot compatibility transaction are limited to setup/seed/cleanup.

Setup and benchmark passwords are separate local constants. Credentials and admin output must not appear in result files or command errors. Administrative speed is setup cost, not workload TPS.

## Workflow mix

The configured weights total 100%:

| Workflow | Weight | Operation class |
| --- | ---: | --- |
| dashboard | 20% | read |
| task list | 25% | read |
| task detail | 15% | read |
| create task | 10% | write |
| update task | 12% | write |
| add comment | 10% | write |
| search | 5% | auth/search |
| profile update | 1% | write |
| sign out/sign in | 2% | auth/search |

Users repeatedly select a workflow, execute its complete SDK journey, then wait a deterministic random think time from 1,000 through 5,000 ms. Writes are real and mutate the reset dataset. Dashboard/detail/list journeys validate returned shape, pagination, and tenant context. Task/comment writes include each backend's equivalent activity semantics. Search uses the same application intent, not a backend-specific peak query. Before each measured stage, ordinary-user sessions are prepared in input order in fixed batches of ten with no retries; preparation failures invalidate the stage without emitting samples. Every measured physical remote call issued through an official SDK, including replacement authentication and remote refresh/sign-out/close calls, uses the configured `timeoutMs` through the official SDK fetch transport. Stage cancellation aborts those transports before cleanup; workers are awaited after cancellation, and cleanup starts only after they settle. Boundary session preparation and final cleanup are unmeasured, while the weighted sign-out/sign-in journey remains measured, including the remote calls it causes. Local-only SDK or auth-store operations emit no SDK-call sample. An SDK that ignores the official transport signal invalidates/stops the run rather than being silently accepted.

Before measured stages, the 15-check correctness suite covers valid/invalid sign-in, profile mutation, task/comment CRUD and stable pagination, tenant read/write isolation, role authorization/restoration, refresh/sign-out, and required fixture identity. A correctness failure aborts load measurement.

## Lifecycle and execution order

A `run` performs this order inside one owning process:

1. Doctor the exact toolchain and local port availability.
2. Start only the selected backend.
3. Capture initial environment and process/container identity.
4. Reset only owned backend data.
5. Re-doctor the stable post-reset identity.
6. Deterministically seed and verify canonical counts.
7. Seed the correctness fixture and run all correctness checks.
8. Recheck backend identity and capture the measured environment.
9. Run an unscored warm-up at the profile's maximum configured concurrency. Warm-up writes remain in the measured database state but warm-up samples do not contribute to scores.
10. Run measured concurrency stages in configured order. Each stage prepares ordinary-user sessions in fixed batches of ten, then starts its timer/resource collection only after all requested sessions are ready; boundary preparation and final cleanup are unmeasured. Check backend identity before and after each stage and collect resources in parallel.
11. Evaluate SLO capacity and, where necessary, add bounded adaptive stages/refinement up to `maxConcurrency`.
12. Stop only the owned lifecycle and atomically write the raw result. A bounded `.partial.json` is retained on failure.

The quick profile has a 5-second warm-up and 15-second stages at 1/5/10 users. The full medium profile has a 120-second warm-up and 300-second configured stages at 5/10/25/50 users, with `maxConcurrency` 1,000. Five users is the publishable measurement floor because the deterministic 300-second one-user stream cannot meet the unchanged 20-sample requirement for the 7% auth/search class. Configured stage time excludes reset, seed, correctness, startup, cleanup, grace periods, and adaptive stages.

The TrailBase-only `trailbase-ceiling` profile changes only the profile name and `maxConcurrency`, raising the bound to 4,000 while preserving the full medium workload and SLO contract. After its configured 5/10/25/50-user stages pass, bounded doubling adds 100/200/400/800/1,600/3,200/4,000 while stages continue to pass; the normal single midpoint refinement follows a first conclusive failure. It is a separate follow-up series and is not aggregation-compatible with `full` results. On the shared-host topology, a runner-overload failure bounds the combined runner/backend system; it must not be presented as TrailBase server saturation. A server-only endpoint above that boundary requires a separate load-generator host and a separately qualified protocol.

`up` is a foreground diagnostic: it owns the lifecycle until Ctrl-C (`SIGINT`) or `SIGTERM`, then stops only that handle. Cross-process `down` is intentionally unsupported because a new process cannot prove ownership. Never substitute a broad `pkill`, global Supabase stop, or Docker prune.

## TPS and latency definitions

- **Application workflow TPS** is the number of successfully completed whole workflow samples divided by actual monotonic stage elapsed seconds. A multi-call dashboard or detail journey counts once.
- **Per-workflow TPS** applies the same definition to one workflow name.
- **SDK operations/s** is successfully completed individual physical remote calls issued through official SDK clients divided by actual stage elapsed seconds. Authorization helpers and related-record reads count separately, exposing call amplification; calls are grouped under the initiating application operation name.
- **Read SDK/s** and **write SDK/s** split successful remote SDK calls by the initiating operation's declared read/write kind. Local-only SDK/auth-store state changes do not count.
- Latency percentiles are nearest-rank values over attempted samples. SDK-call latency covers one physical remote call. Workflow operation-class SLOs aggregate complete workflow samples, not the inner SDK calls.
- Errors count attempted samples that did not complete. Error rate is `failed / attempted`; missing samples are not treated as zero-latency successes.

Application workflow TPS is the primary throughput context for concurrent-active-user capacity. SDK throughput describes call amplification and must not be presented as application TPS.

## SLO and capacity rules

Committed quick/full SLOs are:

| Workflow operation class | p95 ceiling | Maximum error rate |
| --- | ---: | ---: |
| read | 500 ms | `< 1%` |
| write | 750 ms | `< 1%` |
| auth/search | 1,000 ms | `< 1%` |

A capacity stage must:

- have valid workload/lifecycle/resource collection;
- achieve at least 95% of requested users;
- include every operation class with nonzero configured weight;
- have at least 20 attempted workflow samples in each active class for publishable configs (quick requires at least one);
- satisfy p95 `<=` its ceiling and error rate strictly below 1%.

Capacity is the highest **contiguous** SLO-passing stage from the beginning, bounded before the first qualifying saturation point. Publishable capacity is established only within the measured range beginning at five users. A failed first full stage therefore yields capacity zero even if a later stage appears to pass; zero means no qualifying capacity was established at or above five users, not that the backend supports zero users. One-user quick evidence remains separate and nonpublishable.

Saturation requires two adjacent passing stages where requested users increase by at least 20%, workflow TPS rises by strictly less than 10%, and at least one active class has a rising p95. A backend merely staying alive is not capacity evidence. Failure to reach saturation does not invent a saturation point; the result reports that it was not observed within measured bounds.

## Stage and run validity

At the fixed stage deadline the runner stops launching workflows, allows each in-flight workflow the configured bounded grace period, and cancels pending SDK transport only if grace expires or an external/failure abort occurs. Cleanup starts only after every worker settles. Recognized measured SDK, authentication, authorization, timeout, transport/SDK, application, and backend-health errors are scored through the class error-rate SLO; malformed responses, unknown/local validation errors, external cancellation, grace expiry, and unresolved lifecycle/cleanup failures remain integrity failures. Session-loss errors retire only the affected virtual user and reduce achieved users. A stage is invalid if any required integrity condition fails, including backend identity/restart changes, backend doctor failure, session-preparation failure, workload integrity failure, unresolved session-close failure, grace expiry, failure to start all requested users, missing/malformed resource metrics, a resource sample ceiling breach, or runner overload. The result records `measuredRequestTimeoutMs`; aggregation treats runs with incompatible timeout settings (including old results that omit this setting) as incompatible. Preparation and final boundary session operations are excluded from measured samples and elapsed time; authentication inside the measured sign-out/sign-in journey is not excluded. SLO failures constrain selected capacity but remain useful curve evidence when the stage itself is otherwise valid.

Runner overload is flagged when any of these is sustained for three consecutive resource snapshots:

- runner CPU above 90%;
- runner event-loop p99 above 100 ms;
- runner event-loop maximum above 250 ms.

Resource collection uses a nominal one-second delay between bounded serialized probes, with a ceiling of `ceil((stageDurationMs + timeoutMs) / 1000) + 2`. Probe execution time is additional, so realized Supabase cadence is slower when Docker statistics take longer than the nominal delay; every retained snapshot carries its monotonic timestamp. PocketBase/TrailBase require runner and exact owned-process CPU/RSS plus event-loop metrics. Supabase requires runner/event-loop metrics and totals from the exact project-labeled container set, including CPU, memory, and block I/O. Unavailable required metrics invalidate rather than silently becoming zero.

Latency retention is capped at 2,000,000 samples per stage; crossing the ceiling invalidates the stage. Error examples are redacted, deduplicated, and bounded at 100. All numeric result values must be finite and counts/rates/percentiles must be internally consistent. A publishable run also needs a nonzero selected capacity, all correctness checks, clean stage integrity, complete environment identity, `publishable: true`, and an identical clean Git commit for aggregation.

Keep invalid artifacts and their `.partial.json` evidence. Never remove a bad run and silently substitute another; record why it was rejected and repeat it as a distinct run.

## One-backend-at-a-time rotation

Do not run backends concurrently. For three repetitions, use a balanced order and one fixed documented cooldown, for example:

```text
set 1: Supabase -> PocketBase -> TrailBase
set 2: PocketBase -> TrailBase -> Supabase
set 3: TrailBase -> Supabase -> PocketBase
```

The `compare` command is useful for a sequential smoke pass, but it does not impose thermal cooldowns or rotate later sets. Publishable collection should invoke individual `run` commands in the chosen order, wait the same cooldown after each backend, and record start/end times and rejected attempts. A current full run is approximately 30–55+ minutes per backend; nine rotated runs are multi-hour.

Use one stable normal-power mode with Low Power Mode disabled and enough charge for the set; AC and battery are treated as equivalent protocol states on this benchmark host. Record the power source as context and prevent sleep. Start from a stable cool/idle state, leave comparable thermal headroom, close browsers, IDE indexing, backups, virus scans, package updates, VMs, and other avoidable work. Record unavoidable background services. Do not use a single laptop run to generalize to servers or other cooling/power states.

## Cleanup ownership

PocketBase and TrailBase use lifecycle ownership markers and exact binary/data paths; reset refuses filesystem roots, repository/home ancestors, foreign owners, live external users, and unowned nonempty depots. Supabase scopes operations to project `realworldbaasbench`, discovers containers by exact project label, and stops/removes only that project's containers with `--no-backup`. This means Supabase owned volumes can disappear at stop, so disk size must be sampled before cleanup if it is required.

The runner always attempts owned stop in `finally`. If cleanup fails, the result is invalid and records the failure. Inspect before manual cleanup; never use `docker system prune`, global process matching, or deletion outside the selected ignored `.data` path. Downloader staging never writes a missing repository binary; manual installation is followed by doctor verification, and different executables are refused.

## Results, reports, and aggregation

Raw JSON is authoritative. `npm run bench -- report results/<run>.json` validates schema/content and writes adjacent Markdown plus stage CSV without overwriting existing output. It does not make an invalid or quick run publishable.

Aggregation requires at least three distinct valid runs per backend. Without an explicit nonpublishable override, runs must be publishable, have the same clean Git commit, and match backend name/version/endpoint/deviations, SDK/npm/Docker/Supabase versions, runtime, full config and settings, dataset/seed/schema, version map, and hardware identity (CPU, cores, memory, OS/release, architecture, host). Missing adaptive stages are reported; only common stages are aggregated. The aggregate reports median/min/max spread and never combines backends into an unexplained composite score. Cross-backend output is grouped by backend after each group's compatibility checks.

## Raw artifact retention and host record

For every attempt retain:

- raw final JSON and any partial JSON;
- generated Markdown and stage CSV;
- command, order position, cooldown, start/end time, and validity/rejection note;
- the clean commit and host/tool checklist;
- SHA-256 checksums of every retained artifact.

Examples:

```sh
# macOS
shasum -a 256 results/*.json results/*.md results/*-stages.csv > results/SHA256SUMS

# Ubuntu
sha256sum results/*.json results/*.md results/*-stages.csv > results/SHA256SUMS
```

`results/*` is gitignored. Copy raw artifacts and `SHA256SUMS` to durable storage without editing them; the repository docs may summarize them honestly but do not contain the raw local files.

Before claiming a platform verification, record this checklist:

```sh
git rev-parse HEAD
git status --porcelain
node --version
npm --version
supabase --version
docker --version
unzip -v | head -n 2
uname -a
```

On macOS also record `sysctl -n machdep.cpu.brand_string`, `sysctl -n hw.logicalcpu`, and `sysctl -n hw.memsize`. On Ubuntu record `uname -srvm`, `lscpu`, and `free -b`. Include Docker engine state/version and all backend/SDK versions captured in the result. The macOS ARM64 clean-clone setup path passed on the recorded Apple M1 host at commit `5915981`: `npm ci`, pinned download and manual staging installation, 208 non-live tests, and all three backend doctors. This is same-host clean-checkout evidence, not a newly provisioned host. Ubuntu x64 verification remains pending for lack of a host.
