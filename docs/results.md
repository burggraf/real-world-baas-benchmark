# Results index

No publishable three-backend comparison exists yet. Raw local artifacts under `results/` are gitignored and are not present in this repository. Do not reconstruct or publish a ranking from the setup observations or quick smoke result below.

## Task 15 medium-seed validation

Host: Apple M1 macOS development machine. These are setup/seed validation observations, not load-test scores and not post-Task-16 clean-clone verification.

Each backend produced the canonical **626,000 application records** for the medium profile (1,000 organizations, 10,000 users, 10,000 memberships, 5,000 projects, 100,000 tasks, 300,000 comments, and 200,000 activities). Cleanup checks passed for all three.

| Backend | Reset/seed/count-validation elapsed | Observed local data |
| --- | ---: | ---: |
| PocketBase 0.39.11 | 1,446.44 s | approximately 198 MiB |
| TrailBase 0.33.1 | 647.41 s | approximately 234 MiB plus a 4.1 MiB log |
| Supabase CLI 2.115.0 local stack | 416.69 s | unavailable; owned volumes were removed at stop before a defensible size was captured |

These elapsed values include backend-specific administrative setup and are not ordinary-user workflow TPS. The Supabase size is reported as unavailable, not zero.

## Existing PocketBase quick smoke result

One local PocketBase `configs/quick.json` run exists only as nonpublishable diagnostic evidence:

- correctness: **15/15 passed**;
- workflow errors: none;
- workflow TPS at requested users 1/5/10: **0.2666 / 1.7330 / 3.5168**;
- selected capacity: **0**;
- relevant capacity evidence: missing auth/search workflow samples prevented a contiguous passing capacity stage, and read p95 reached **511.4 ms** at 10 users (above the committed 500 ms read SLO).

A quick profile is explicitly nonpublishable, has short stages, and is not evidence of comparative capacity. Capacity zero here means the required sample/SLO contract did not establish a passing contiguous stage; it does not mean the server handled zero requests.

## Verification status

- macOS ARM64 same-host clean-clone setup verification: **passed** at commit `5915981` on the recorded Apple M1 host with Node `v26.7.0`, npm `11.19.0`, Supabase CLI `2.115.0`, and Docker `29.4.0`. A clean checkout completed `npm ci`, staged and manually installed both pinned binaries, passed 208 non-live tests with 6 live tests skipped, and passed all three backend doctors. This is not evidence from a newly provisioned machine.
- Ubuntu x64 clean-host verification: **pending** because no Ubuntu host or VPS is available.

The Ubuntu x64 prerequisites, exact downloader support, commands, and kernel/CPU/memory/version recording checklist are in [methodology.md](methodology.md). No Ubuntu outcome is fabricated here.

A first publishable comparison will require three compatible full medium runs per backend with rotated order, fixed cooldown, retained raw checksums, and all validity gates satisfied. At roughly 35–60+ minutes per backend, nine rotated runs are a multi-hour collection. That future work will create `docs/results/first-comparison.md`; this task intentionally does not create the `docs/results/` directory.
