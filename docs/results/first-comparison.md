# First local BaaS comparison

Published from nine valid full-profile runs collected on 2026-08-22 UTC. This is a machine-qualified local comparison, not a universal vendor ranking.

- **Workload commit:** [`79480b382f101f7867b93a5e4ae43e74e0169412`](https://github.com/burggraf/real-world-baas-benchmark/commit/79480b382f101f7867b93a5e4ae43e74e0169412)
- **Machine:** Apple M1, 8 logical cores, 16,386,818,048 bytes RAM, macOS/Darwin release 25.6.0, arm64
- **Runtime:** Node.js 26.7.0, npm 11.19.0, Docker 29.4.0
- **Backends/clients:** PocketBase 0.39.11 / SDK 0.28.0; Supabase CLI 2.115.0 / SDK 2.112.3; TrailBase 0.33.1 / SDK 0.14.0
- **Dataset:** deterministic medium profile, seed 42, 626,000 application records plus backend auth users
- **Load model:** closed model with one in-flight journey per user, deterministic 1–5 second think time, 120-second warm-up, 300-second stages
- **Workload mix:** dashboard 20%, task list 25%, task detail 15%, create task 10%, update task 12%, add comment 10%, search 5%, profile update 1%, sign-out/sign-in 2%
- **SLOs:** p95 under 500 ms read, 750 ms write, and 1,000 ms auth/search; each class error rate strictly below 1%; at least 95% of requested users achieved
- **Protocol:** three rotated sets, one backend at a time, fixed 600-second cooldown before every backend, Low Power Mode off, sleep prevention enabled. AC and battery were equivalent protocol states; source transitions were recorded but did not affect validity.

The exact methodology and capacity rules are in [methodology.md](../methodology.md). The machine-readable aggregate with median/min/max spread for every stage is [first-comparison.json](first-comparison.json); selected raw checksums are in [first-comparison.sha256](first-comparison.sha256).

## Result summary

Values are median **[minimum–maximum]** across three compatible runs. `SDK calls/s` counts physical remote calls made through the official clients, grouped under the initiating application operation. It is call amplification, not application TPS.

| Backend | Capacity users | Achieved | Workflow TPS | SDK calls/s | SDK calls/workflow | Read p95 ms | Write p95 ms | Auth/search p95 ms | Read error | Write error | Auth/search error |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| PocketBase | 75 [75–75] | 75 [75–75] | 24.79 [24.77–24.80] | 86.91 [86.83–86.93] | 3.51 | 485.13 [484.36–497.68] | 19.25 [18.63–22.07] | 102.86 [99.88–103.56] | 0.000% [0.000–0.000] | 0.000% [0.000–0.000] | 0.000% [0.000–0.000] |
| Supabase | 600 [600–600] | 588 [587–588] | 193.23 [190.90–194.04] | 622.17 [614.82–624.63] | 3.22 | 27.04 [25.43–89.74] | 28.52 [27.12–87.25] | 270.34 [269.43–296.02] | 0.032% [0.000–0.105] | 0.099% [0.031–0.168] | 0.298% [0.296–0.377] |
| TrailBase | ≥1,000* | 1,000 [1,000–1,000] | 333.38 [332.78–333.54] | 1,445.38 [1,442.69–1,446.12] | 4.34 | 8.76 [8.65–11.52] | 13.87 [12.96–25.24] | 23.79 [23.62–27.16] | 0.007% [0.005–0.012] | 0.033% [0.012–0.036] | 0.000% [0.000–0.000] |

\* TrailBase passed the configured 1,000-user maximum in all three runs. Its saturation endpoint was not observed, so 1,000 is a tested lower bound rather than an estimate of maximum capacity.

### What these numbers support

- PocketBase's repeatable boundary was the read-latency SLO: median read p95 was 485.13 ms at 75 users and 647.15 ms at 100 users. All measured class errors were zero at both stages.
- Supabase passed at 600 users in all runs, achieving 587–588 users. At 800 requested users it achieved 733–749, while latency and auth/search error SLOs failed. Its median capacity is therefore 600 under this contract.
- TrailBase passed every configured stage through 1,000 users. No higher stage was attempted, so the benchmark cannot identify its saturation point on this machine.
- SDK-call rates must not be read as user-visible throughput. TrailBase made the most remote calls per completed workflow at the capacity stage; the complete workflow TPS/latency already includes that cost.

These conclusions apply only to this local Apple M1, these versions, this schema, the active-workday mix, and the committed SLOs. They do not establish cloud, multi-host, realtime, storage, geographic-latency, or cost superiority.

## Same-load comparison at 50 active users

At 50 users every backend remained below saturation, so the closed model and think time produced similar workflow TPS. Latency and call amplification still differed.

| Backend | Workflow TPS | SDK calls/s | SDK calls/workflow | Read p95 ms | Write p95 ms | Auth/search p95 ms | Maximum class error |
|---|---:|---:|---:|---:|---:|---:|---:|
| PocketBase | 16.54 [16.53–16.54] | 58.08 [58.05–58.08] | 3.51 | 337.48 [328.62–340.69] | 22.46 [22.24–25.15] | 109.23 [106.04–109.85] | 0.000% |
| Supabase | 16.62 [16.61–16.62] | 53.59 [53.55–53.60] | 3.22 | 28.35 [28.09–31.94] | 30.56 [30.26–34.45] | 205.75 [204.78–221.44] | 0.000% |
| TrailBase | 16.66 [16.66–16.66] | 72.43 [72.41–72.43] | 4.35 | 21.43 [21.17–22.56] | 21.87 [21.71–23.68] | 52.89 [51.78–53.84] | 0.000% |

## Full median stage curves

The tables below show median values. `Max class error` is the largest error rate observed among the three operation classes in any of the three runs at that stage. Full min/max spread, p50/p95/p99, achieved users, and resources are in the machine-readable aggregate.

### PocketBase

| Users | Achieved | Workflow TPS | SDK calls/s | Read p95 ms | Write p95 ms | Auth/search p95 ms | Max class error |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 5 | 5 | 1.63 | 6.02 | 82.38 | 26.01 | 118.25 | 0.000% |
| 10 | 10 | 3.27 | 11.78 | 114.40 | 25.35 | 113.45 | 0.000% |
| 25 | 25 | 8.26 | 29.09 | 183.91 | 24.18 | 116.81 | 0.000% |
| 50 | 50 | 16.54 | 58.08 | 337.48 | 22.46 | 109.23 | 0.000% |
| 75 | 75 | 24.79 | 86.91 | 485.13 | 19.25 | 102.86 | 0.000% |
| 100 | 100 | 32.89 | 115.41 | 647.15 | 16.82 | 85.07 | 0.000% |

### Supabase

| Users | Achieved | Workflow TPS | SDK calls/s | Read p95 ms | Write p95 ms | Auth/search p95 ms | Max class error |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 5 | 5 | 1.63 | 5.42 | 34.81 | 38.36 | 220.21 | 0.000% |
| 10 | 10 | 3.27 | 10.67 | 33.42 | 36.50 | 213.66 | 0.000% |
| 25 | 25 | 8.27 | 26.65 | 31.89 | 33.71 | 205.05 | 0.000% |
| 50 | 50 | 16.62 | 53.59 | 28.35 | 30.56 | 205.75 | 0.000% |
| 100 | 100 | 33.31 | 107.64 | 22.45 | 24.01 | 193.84 | 0.000% |
| 200 | 200 | 66.54 | 214.58 | 17.97 | 19.48 | 201.92 | 0.000% |
| 400 | 398 | 131.71 | 424.11 | 17.34 | 19.14 | 222.10 | 0.146% |
| 600 | 588 | 193.23 | 622.17 | 27.04 | 28.52 | 270.34 | 0.377% |
| 800 | 739 | 228.40 | 737.68 | 1,536.78 | 1,292.16 | 1,238.39 | 1.531% |

### TrailBase

| Users | Achieved | Workflow TPS | SDK calls/s | Read p95 ms | Write p95 ms | Auth/search p95 ms | Max class error |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 5 | 5 | 1.63 | 7.22 | 23.47 | 23.58 | 55.29 | 0.000% |
| 10 | 10 | 3.28 | 14.39 | 22.58 | 22.61 | 54.50 | 0.000% |
| 25 | 25 | 8.30 | 36.06 | 22.24 | 22.13 | 54.77 | 0.595% |
| 50 | 50 | 16.66 | 72.43 | 21.43 | 21.87 | 52.89 | 0.000% |
| 100 | 100 | 33.38 | 145.01 | 19.34 | 19.97 | 49.79 | 0.091% |
| 200 | 200 | 66.75 | 289.86 | 15.99 | 16.62 | 43.89 | 0.030% |
| 400 | 400 | 133.66 | 579.54 | 11.80 | 12.84 | 32.74 | 0.030% |
| 800 | 800 | 267.16 | 1,157.94 | 8.76 | 11.19 | 24.69 | 0.030% |
| 1,000 | 1,000 | 333.38 | 1,445.38 | 8.76 | 13.87 | 23.79 | 0.036% |

## Resource maxima at each capacity stage

Values are median **[minimum–maximum]** of each run's stage maximum. CPU may exceed 100% because it is summed across logical cores. Supabase runs in multiple containers, so its backend resources are reported as project-container aggregates rather than one process.

| Backend at capacity stage | Samples | Runner CPU % | Runner RSS MiB | Backend CPU % | Backend RSS MiB | Event-loop p99 ms | Supabase CPU % | Supabase memory MiB | Block read GB | Block write GB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| PocketBase @ 75 | 295 [294–296] | 25.4 [21.8–27.5] | 174.0 [148.9–193.5] | 704.0 [651.7–730.2] | 231.3 [231.2–232.7] | 18.78 [14.82–19.76] | unavailable | unavailable | unavailable | unavailable |
| Supabase @ 600 | 96 [96–96] | 54.0 [49.2–58.4] | 261.4 [261.0–271.3] | unavailable | unavailable | 22.82 [21.17–33.88] | 444.5 [400.2–530.9] | 2,122.1 [2,088.5–2,139.7] | 11.36 [11.21–11.86] | 7.58 [7.56–7.65] |
| TrailBase @ 1,000 | 295 [295–296] | 87.4 [82.6–95.8] | 381.2 [359.6–383.3] | 380.3 [357.2–402.4] | 359.9 [356.5–373.3] | 282.07 [143.00–576.19] | unavailable | unavailable | unavailable | unavailable |

The runner-overload gate evaluates consecutive samples, not a single stage maximum; all selected stages passed that gate. TrailBase's high runner CPU/event-loop maxima at 1,000 users are additional reasons to treat its result as a tested lower bound, not an unconstrained server-capacity claim.

Supabase block figures are cumulative container block-I/O counters observed at the stage, not on-disk database size. Per-run disk telemetry was unavailable for PocketBase and TrailBase and is reported as unavailable rather than zero. Separate seed-validation observations were approximately 198 MiB for PocketBase and 234 MiB plus a 4.1 MiB log for TrailBase; Supabase on-disk size was unavailable after owned-volume cleanup.

## Repetition, validity, and exclusions

The selected order was fixed before collection:

1. Supabase → PocketBase → TrailBase
2. PocketBase → TrailBase → Supabase
3. TrailBase → Supabase → PocketBase

All nine selected runs were valid, used the same clean workload commit, passed 15/15 correctness checks, retained exact requested-stage integrity, met sampling requirements, and completed owned cleanup without changing unrelated Docker container identity. Compatibility checks found no mismatches within any backend's three-run group. Capacity spread was zero stages for every backend: 75/75/75, 600/600/600, and 1,000/1,000/1,000.

Earlier artifacts were not selected post hoc:

- Pre-`79480b3` Supabase canaries and one valid Supabase set run used incompatible session/error or SDK-call accounting and cannot be aggregated.
- The rejected `900038c` Supabase run prepared only 94/100 users at an adaptive stage.
- The rejected `b5cc5cb` and `bf1a7b9` canaries used superseded zero-error/global-abort semantics.
- The `eb06cc6` PocketBase set attempt failed medium-dataset correctness because PocketBase relation expansion stalled. The final adapter uses exact related-record SDK reads and reports their call amplification.
- The valid final-commit PocketBase canary was retained as validation evidence but excluded from the prespecified three rotated sets.

## Raw evidence and reproducibility

A release archive contains the selected raw JSON, generated Markdown/CSV reports, per-run checksums, the full-run ledger, compatible aggregate, and retained full-run canary/rejection evidence:

- [GitHub release](https://github.com/burggraf/real-world-baas-benchmark/releases/tag/first-comparison-2026-08-22)
- [Download `first-comparison-full-evidence-79480b3.tar.gz`](https://github.com/burggraf/real-world-baas-benchmark/releases/download/first-comparison-2026-08-22/first-comparison-full-evidence-79480b3.tar.gz)
- Archive SHA-256: `e58d2fa52398e9d2f54b77b024f3c7898c77bfa937b2b99530360997ee78a1ed`

Raw JSON remains the source evidence. The committed aggregate can be regenerated with `aggregateBenchmarkResultsByBackend` from `src/aggregate.ts`. The archive's selected JSON checksums and aggregate checksum are repeated in [first-comparison.sha256](first-comparison.sha256).

## Limits

- One fanless laptop and three repetitions do not generalize to production servers, managed cloud deployments, different cooling, or different data distributions.
- The server and load generator shared the same host; resource contention is part of this result.
- Local loopback excludes real network latency, TLS termination, and geographic effects.
- TrailBase's endpoint was not found within the configured 1,000-user ceiling.
- Capacity is SLO-specific. Changing the workload mix, think time, sample floor, latency ceilings, error threshold, schema, indexes, or client versions changes the question.
- No composite score or cost ranking is reported.
