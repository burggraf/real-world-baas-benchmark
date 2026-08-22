# Results index

## First publishable local comparison

The first three-backend comparison is published in [results/first-comparison.md](results/first-comparison.md), with a [machine-readable aggregate](results/first-comparison.json) and [SHA-256 manifest](results/first-comparison.sha256).

Nine valid full medium-profile runs were collected on one Apple M1 host using three rotated orders and fixed 600-second cooldowns. Every selected run used clean workload commit `79480b382f101f7867b93a5e4ae43e74e0169412`, passed 15/15 correctness checks, met integrity and sampling gates, and completed owned cleanup.

| Backend | Repeated capacity result | Interpretation |
| --- | ---: | --- |
| PocketBase 0.39.11 | 75 / 75 / 75 | Read p95 crossed the 500 ms SLO at 100 users. |
| Supabase CLI 2.115.0 | 600 / 600 / 600 | 800 users failed achieved-user, latency, and/or error SLO evidence. |
| TrailBase 0.33.1 | 1,000 / 1,000 / 1,000 | Passed the configured maximum; actual saturation was not observed. |

These are local, machine-qualified outcomes—not a universal vendor ranking. The detailed report names the clients, hardware, deterministic dataset, workload mix, think time, SLOs, stage curves, resource spread, exclusions, and limitations.

Raw selected and rejected full-run evidence is attached to the [`first-comparison-2026-08-22` release](https://github.com/burggraf/real-world-baas-benchmark/releases/tag/first-comparison-2026-08-22). The evidence archive SHA-256 is `e58d2fa52398e9d2f54b77b024f3c7898c77bfa937b2b99530360997ee78a1ed`.

## TrailBase same-host ceiling canary

A separate [TrailBase ceiling follow-up](results/trailbase-ceiling-canary.md) raised the full medium profile's maximum from 1,000 to 4,000 users without changing its workload or SLOs. In one diagnostic run, 1,600 requested users passed with all 1,600 achieved; the 3,200-user stage achieved 3,128 but failed every class SLO and the sustained runner-CPU integrity gate. The 4,000-user ceiling was not attempted.

This is not a repeated capacity result. It bounds the combined Apple M1 runner/backend setup and does not establish TrailBase's server-only limit. The original three-backend comparison remains unchanged. Compact machine data and checksums are adjacent to the report; raw evidence is attached to the [`trailbase-ceiling-canary-2026-08-22` release](https://github.com/burggraf/real-world-baas-benchmark/releases/tag/trailbase-ceiling-canary-2026-08-22).

## Task 15 medium-seed validation

Host: Apple M1 macOS development machine. These are setup/seed validation observations, not load-test scores.

Each backend produced the canonical **626,000 application records** for the medium profile (1,000 organizations, 10,000 users, 10,000 memberships, 5,000 projects, 100,000 tasks, 300,000 comments, and 200,000 activities). Cleanup checks passed for all three.

| Backend | Reset/seed/count-validation elapsed | Observed local data |
| --- | ---: | ---: |
| PocketBase 0.39.11 | 1,446.44 s | approximately 198 MiB |
| TrailBase 0.33.1 | 647.41 s | approximately 234 MiB plus a 4.1 MiB log |
| Supabase CLI 2.115.0 local stack | 416.69 s | unavailable; owned volumes were removed at stop before a defensible size was captured |

These elapsed values include backend-specific administrative setup and are not ordinary-user workflow TPS. The Supabase size is reported as unavailable, not zero.

## Nonpublishable quick evidence

Quick-profile runs use the small dataset, short stages, and a one-sample class floor. They are diagnostics, not comparative capacity evidence. The final-commit preflight passed all three backends with 15/15 correctness, exact achieved concurrency at 1/5/10 users, zero workflow and physical SDK-call failures, valid stage integrity, and clean lifecycle checks. Overall quick results remained nonpublishable because low-concurrency deterministic streams did not always exercise auth/search and may miss a quick SLO.

## Verification status

- Final workload commit: `79480b382f101f7867b93a5e4ae43e74e0169412`.
- Final non-live suite before collection: 260 tests total, 254 passed, 6 live skipped, 0 failed; TypeScript build and diff checks passed.
- macOS ARM64 same-host clean-clone setup verification: passed at commit `5915981` with Node `v26.7.0`, npm `11.19.0`, Supabase CLI `2.115.0`, and Docker `29.4.0`. A clean checkout completed `npm ci`, staged and manually installed both pinned binaries, passed its then-current non-live suite, and passed all three backend doctors. This is not evidence from a newly provisioned machine.
- Ubuntu x64 clean-host verification: pending because no Ubuntu host or VPS was available. No Ubuntu outcome is fabricated.

## Retained exclusions

Runs before the final physical SDK-call accounting commit are incompatible with the selected aggregate. The release archive and full-run ledger retain the important rejected and diagnostic evidence, including:

- `full-s1-01-supabase-900038c`, whose adaptive stage prepared only 94/100 users;
- Supabase canaries at `b5cc5cb` and `bf1a7b9`, which exposed superseded zero-error/global-abort semantics;
- valid `eb06cc6` Supabase artifacts, excluded because SDK-call accounting changed afterward;
- the rejected `eb06cc6` PocketBase attempt, whose medium correctness check exposed relation-expansion stalls;
- the valid final-commit PocketBase canary, excluded because it was validation evidence outside the prespecified rotated sets.

Invalid artifacts were retained rather than rewritten or selected away. See [methodology.md](methodology.md) for compatibility, capacity, and retention rules.
