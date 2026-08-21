# Real-world local BaaS benchmark

This repository measures a deterministic multi-tenant project-management workload against local Supabase, PocketBase, and TrailBase instances through their official JavaScript SDKs. It reports concurrent-active-user capacity, application workflow TPS, SDK-operation throughput, latency, errors, and owned-process/container resources. It is not a vendor ranking or a general capacity claim.

See [the methodology](docs/methodology.md) before interpreting a result and [the results index](docs/results.md) for the evidence currently available.

## Pinned compatibility

| Backend | Local server/CLI | Official JavaScript SDK |
| --- | --- | --- |
| Supabase | Supabase CLI `2.115.0` and the local services it pins | `@supabase/supabase-js@2.112.3` |
| PocketBase | server `0.39.11` | `pocketbase@0.28.0` |
| TrailBase | server `0.33.1` | `trailbase@0.14.0` |

`package-lock.json` pins the npm dependency graph. Doctor rejects any Supabase CLI or PocketBase/TrailBase binary that does not match the required checks. PocketBase and TrailBase use exact executable SHA-256 values per supported target, and the downloader independently checks both pinned archive and extracted executable bytes.

## Prerequisites

All hosts need:

- Node.js `>=22` and npm;
- Git;
- the installed `unzip` executable (the downloader invokes it directly, never through a shell);
- Supabase CLI exactly `2.115.0` on `PATH`, or selected with `SUPABASE_BIN`;
- a running Docker engine usable by the current user for local Supabase.

On macOS ARM64, use a native Node 22+ build, Docker Desktop or another compatible Docker engine, and Supabase CLI 2.115.0. The system `unzip` is sufficient.

On Ubuntu x64, install a native x64 Node 22+ release, npm, Git, `unzip`, Docker Engine with Compose support, and the official Supabase CLI 2.115.0 x64 binary. Add the current user to Docker's permitted group only according to Docker's security guidance, then verify `docker info` works without changing benchmark commands. The pinned downloader supports the exact Linux x64 PocketBase and TrailBase release assets listed in the backend READMEs.

Ubuntu clean-host verification is **pending** because no Ubuntu host or VPS is available. macOS ARM64 clean-clone verification passed on this Apple M1 host at commit `5915981`: `npm ci`, pinned download and manual staging installation, all 208 non-live tests, and all three backend doctors completed successfully. This verifies the setup path on the recorded host, not on a newly provisioned machine.

## Clean setup

```sh
npm ci
npm run download-backends
npm test
supabase --version        # must print 2.115.0
docker info               # must succeed before Supabase doctor
npm run bench -- doctor
```

The downloader accepts no version or URL arguments. It fetches only PocketBase `0.39.11` and TrailBase `0.33.1` from pinned HTTPS GitHub release URLs, verifies the archive and exact root executable, and stages verified files privately. Existing identical files are reported unchanged; missing files print manual steps for creating the parent directory, copying the staged file, and applying mode 0755 (the downloader never installs into `.tools`):

- `.tools/pocketbase-0.39.11/pocketbase`
- `.tools/trailbase-0.33.1/trail`

It supports macOS and Linux on ARM64 and x64. Run `node scripts/download-backends.mjs --help` for its small command surface. Follow the printed instructions, then run `doctor`; `.tools/`, `.data/`, and `results/*` are intentionally gitignored; raw local results are not committed.

## Local ports and paths

PocketBase and TrailBase each default to `http://127.0.0.1:8090`, so run only one at a time. Their loopback HTTP endpoint, data directory, and binary can be selected with `POCKETBASE_URL`, `POCKETBASE_DATA_DIR`, `POCKETBASE_BIN`, or `TRAILBASE_URL`, `TRAILBASE_DATA_DIR`, `TRAILBASE_BIN`. URLs must remain loopback HTTP endpoints. Defaults are `.data/pocketbase` and `.data/trailbase`; logs are below `.data/`.

Supabase uses a repository-scoped project and fixed reserved ports:

| Service | Port |
| --- | ---: |
| API | 55321 |
| database | 55322 |
| Studio | 55323 |
| Inbucket | 55324 |
| SMTP | 55325 |
| POP3 | 55326 |
| analytics | 55327 |
| pooler | 55329 |
| shadow database | 55330 |

Do not have unrelated listeners on those ports. `SUPABASE_BIN` may select the exact CLI executable; the benchmark does not expose Supabase port overrides because consistent ports are part of the local configuration.

## Commands

```sh
# Check all backends, or one backend.
npm run bench -- doctor
npm run bench -- doctor --backend pocketbase

# Foreground lifecycle check; stop with Ctrl-C.
npm run bench -- up --backend pocketbase

# Reset, deterministically seed, verify canonical counts, then stop.
npm run bench -- reset --backend pocketbase --dataset small --seed 42

# Reset/seed and run the 15-check correctness suite.
npm run bench -- correctness --backend pocketbase --config configs/quick.json

# Complete lifecycle: doctor, start, reset, seed, correctness, warm-up,
# measured stages, result write, and owned cleanup.
npm run bench -- run --backend pocketbase --config configs/quick.json
npm run bench -- run --backend pocketbase --config configs/full.json

# Sequential smoke comparison. Use explicit individual runs for controlled
# publishable rotations and cooldowns described in docs/methodology.md.
npm run bench -- compare --backends supabase,pocketbase,trailbase --config configs/quick.json

# Convert one raw JSON result to adjacent Markdown and stage CSV files.
npm run bench -- report results/<run>.json
```

`up` retains the in-process ownership handle and stops that owned backend on `SIGINT`/`SIGTERM`; press Ctrl-C and wait for shutdown. `down` is intentionally unsupported across processes: `npm run bench -- down --backend ...` refuses rather than guessing at ownership or stopping unrelated services. Use Ctrl-C in the original `up` process. `run`, `reset`, and `correctness` stop what they own in `finally` cleanup.

The non-default large profile creates millions of records and always requires explicit acknowledgement:

```sh
npm run bench -- run --backend pocketbase --config configs/large.json --confirm-large
```

Do not add `--confirm-large` to automation casually.

## Time and disk planning

- `configs/quick.json` uses the small dataset, a 5-second warm-up, and three 15-second stages at 1/5/10 users. Allow minutes rather than assuming the 50 measured seconds are the whole run: reset, seed, correctness, startup, and cleanup are additional work. Quick results are never publishable.
- `configs/full.json` uses the 626,000-record medium dataset, a 120-second warm-up, and at least four 300-second stages at 5/10/25/50 users. Publishable capacity is established only within that measured range: capacity zero means no qualifying capacity was established at or above five users, not that the backend supports zero users. One-user quick evidence is separate and nonpublishable. A current full run is approximately **30–55+ minutes per backend**, based on the measured medium seed plus configured warm-up/stages; adaptive capacity stages can make it longer.
- Observed medium setup occupied about 198 MiB for PocketBase and 234 MiB plus a 4.1 MiB log for TrailBase. Supabase size was unavailable because owned volumes were removed at stop. Docker images and engine storage can require several additional GiB. Keep comfortable free space and measure the actual run.
- The large profile has not been characterized; expect multiple GiB and substantially longer setup/run time.
- Three rotated full runs for each of three backends are nine runs and therefore a multi-hour exercise before cooldowns or reruns.

## Reproducible run discipline

Use AC power, disable sleep, keep thermal conditions stable, close avoidable background work, and avoid software updates during a comparison. Keep product defaults and the committed schema/indexes unchanged. Run one backend at a time, rotate backend order across three run sets, and use one fixed documented cooldown between backends. Record rejected runs instead of deleting them.

Measured operations always use ordinary application-user credentials and official SDK clients. Backend administrative credentials are separate and confined to setup, deterministic seed, count validation, and cleanup paths; they are not measured sessions.

Raw JSON is the source artifact. Preserve valid and invalid JSON/partial files outside ephemeral workspaces, record SHA-256 checksums, and generate reports without editing the JSON. Reports and aggregation reject malformed or incompatible data; see [methodology](docs/methodology.md) for exact SLO, capacity, validity, sampling, compatibility, and retention rules.
