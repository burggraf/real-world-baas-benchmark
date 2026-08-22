# TrailBase same-host ceiling canary

This is a **single-run diagnostic follow-up**, not a repeated publishable capacity result and not part of the original three-backend aggregate.

## Bottom line

- TrailBase completed a valid, SLO-passing stage at **1,600 requested and achieved users**.
- The next measured stage requested 3,200 users and achieved 3,128, but it was **invalid because runner CPU stayed above the overload threshold**. Read, write, and auth/search latency and error SLOs also failed.
- The configured 4,000-user ceiling was therefore not attempted.
- Throughput increased 52% from 531.87 workflow TPS at 1,600 users to 810.28 TPS at 3,200, so this was not the benchmark's throughput-plateau saturation condition.
- The experiment bounds the practical capacity of this **shared Apple M1 runner/backend setup** between the passing 1,600-user stage and the invalid 3,200-user stage. It does not establish TrailBase's server-only limit.

The result object's selector retained 1,600 users as the highest passing stage, but the run is correctly marked invalid overall because the 3,200-user stage failed an integrity gate. Treat 1,600 as one diagnostic observation, not a publishable repeated capacity claim.

## Run context

| Field | Value |
|---|---|
| Workload commit | `341bcf89a7065757ff9e9ecf8147779be6534000` |
| Backend / SDK | TrailBase 0.33.1 / official JavaScript SDK 0.14.0 |
| Machine | Apple M1, 8 logical cores, 16,386,818,048 bytes RAM, macOS/Darwin 25.6.0 arm64 |
| Dataset | Deterministic medium profile, seed 42, 626,000 application records plus auth users |
| Config | `trailbase-ceiling`: full workload and SLOs, `maxConcurrency` raised from 1,000 to 4,000 |
| Timing | 120-second warm-up; 300-second measured stages; deterministic 1–5 second think time |
| Correctness | 15/15 passed |
| Run time | 2026-08-22 14:23:05–15:23:45 UTC |
| Power context | Began at 56% battery/discharging; ended at 93%/charging; Low Power Mode remained disabled |
| Raw run validity | Invalid: one or more benchmark prerequisites failed |
| Runner integrity failure | `cpuPercent sustained above threshold` at 3,200 users |

The SLO contract remained unchanged: read p95 ≤500 ms, write p95 ≤750 ms, auth/search p95 ≤1,000 ms, each class error rate strictly below 1%, and at least 95% of requested users achieved.

## Boundary evidence

| Metric | 1,600 users | 3,200 requested users |
|---|---:|---:|
| Achieved users | 1,600 | 3,128 |
| Stage validity | valid | **invalid: sustained runner CPU overload** |
| Workflow TPS | 531.87 | 810.28 |
| Physical SDK calls/s | 2,306.43 | 3,532.75 |
| Read p95 | 12.62 ms | **1,418.45 ms** |
| Write p95 | 27.15 ms | **1,841.21 ms** |
| Auth/search p95 | 27.08 ms | **1,253.71 ms** |
| Read error rate | 0.011% | **1.340%** |
| Write error rate | 0.034% | **1.656%** |
| Auth/search error rate | 0.000% | **1.204%** |
| Physical SDK transport failures | 0 | 4,282 |
| Runner CPU maximum | 108.7% | 168.0% |
| Runner RSS maximum | 506.8 MiB | 680.3 MiB |
| TrailBase CPU maximum | 315.7% | 383.9% |
| TrailBase RSS maximum | 381.1 MiB | 574.7 MiB |
| Runner event-loop p99 maximum | 375.39 ms | 4,068.47 ms |
| Resource samples | 297 | 272 |

CPU can exceed 100% because it is summed across logical cores. At 1,600 users, high runner CPU/event-loop observations were not sustained for the three consecutive samples required by the overload gate; the stage remained valid. At 3,200 users, runner CPU did breach that sustained gate.

The official client logged 4,282 connection-refused transport failures at 3,200 users. Pre/post-stage identity checks did not add a backend-health validity failure, and owned cleanup completed. These failures therefore remain measured overload evidence rather than proof that the TrailBase process permanently crashed.

## Full stage curve

| Requested | Achieved | Stage valid | Workflow TPS | SDK calls/s | Read p95 | Write p95 | Auth/search p95 | Max class error | Runner CPU max | Event-loop p99 max |
|---:|---:|:---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 5 | 5 | yes | 1.64 | 7.23 | 23.55 ms | 23.72 ms | 58.21 ms | 0.000% | 39.5% | 19.07 ms |
| 10 | 10 | yes | 3.27 | 14.37 | 23.87 ms | 23.57 ms | 58.60 ms | 0.341% | 17.3% | 21.12 ms |
| 25 | 25 | yes | 8.29 | 36.05 | 22.69 ms | 21.77 ms | 55.11 ms | 0.357% | 65.7% | 21.66 ms |
| 50 | 50 | yes | 16.66 | 72.43 | 21.23 ms | 21.05 ms | 54.85 ms | 0.000% | 35.4% | 27.54 ms |
| 100 | 100 | yes | 33.38 | 144.99 | 19.57 ms | 20.12 ms | 47.29 ms | 0.000% | 32.9% | 22.45 ms |
| 200 | 200 | yes | 66.76 | 289.88 | 16.31 ms | 16.78 ms | 44.72 ms | 0.015% | 35.5% | 19.05 ms |
| 400 | 400 | yes | 133.66 | 579.53 | 12.05 ms | 13.50 ms | 33.69 ms | 0.007% | 38.7% | 40.76 ms |
| 800 | 800 | yes | 267.13 | 1,157.84 | 8.86 ms | 11.70 ms | 24.42 ms | 0.041% | 51.4% | 49.77 ms |
| 1,600 | 1,600 | yes | 531.87 | 2,306.43 | 12.62 ms | 27.15 ms | 27.08 ms | 0.034% | 108.7% | 375.39 ms |
| 3,200 | 3,128 | **no** | 810.28 | 3,532.75 | **1,418.45 ms** | **1,841.21 ms** | **1,253.71 ms** | **1.656%** | 168.0% | 4,068.47 ms |

`Max class error` is the highest workflow-class error rate at that stage. SDK calls/s counts physical remote calls, not completed application workflows.

## Interpretation and next step

This canary answered the immediate question: simply raising the ceiling on the existing topology reaches the load generator's integrity boundary before identifying a TrailBase server-only endpoint. Repeating the same shared-host probe could characterize that combined-system boundary, but it cannot remove the attribution problem.

A defensible server-only limit now requires a separately qualified protocol with the load generator on another machine, remote lifecycle controls, and server-side resource telemetry. That future series must remain separate from both the original `full` aggregate and this canary.

## Evidence

- [Machine-readable compact result](trailbase-ceiling-canary.json)
- [SHA-256 manifest](trailbase-ceiling-canary.sha256)
- [GitHub evidence release](https://github.com/burggraf/real-world-baas-benchmark/releases/tag/trailbase-ceiling-canary-2026-08-22)
- [Raw evidence archive](https://github.com/burggraf/real-world-baas-benchmark/releases/download/trailbase-ceiling-canary-2026-08-22/trailbase-ceiling-canary-evidence-341bcf8.tar.gz)
- Archive SHA-256: `e1e6298b97b11ee63295604c4c581a93cf761680e87af339c746cbcbead35b60`

The archive contains the raw JSON, generated Markdown/CSV, per-run checksum, run ledger, and exact ceiling config. The original [three-backend comparison](first-comparison.md) remains unchanged.
