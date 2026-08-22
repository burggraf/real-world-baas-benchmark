# Hardware-qualified capacity benchmark design

## Goal

Answer this bounded question reproducibly:

> On this exact hardware and execution topology, what is the highest tested concurrent-active-user level that meets the committed workload SLOs?

The answer is never a universal backend ranking. Every claim remains qualified by hardware, topology, workload/config, versions, commit, SLOs, and repetition count.

## Scope of this milestone

This milestone adds:

- a configurable loopback port base for all three local backends;
- bounded multi-step binary refinement after a passing/failing bracket is found;
- explicit `co-located` topology metadata in new results and reports;
- one portable medium-dataset capacity config with a 10,000-user ceiling;
- deployment instructions for clean, one-backend-at-a-time runs on an occupied server.

A true external-runner implementation is deferred. It needs a separately authenticated remote lifecycle/setup channel; merely pointing SDK traffic at a remote URL would not preserve reset, seed, ownership, resource, and identity guarantees. Until that channel exists, no result is labelled server-only or external-runner.

## Port model

The CLI accepts `--port-base N` for `doctor`, `up`, `reset`, `correctness`, `run`, and `compare`. `N` must be an unprivileged port and leave room through `N + 9`.

- PocketBase listens on `N`.
- TrailBase listens on `N`.
- Supabase preserves its existing service offsets: API `N`, database `N+1`, Studio `N+2`, Inbucket `N+3`, SMTP `N+4`, POP3 `N+5`, analytics `N+6`, pooler `N+8`, and shadow database `N+9`.

The CLI passes the validated value through `BENCH_PORT_BASE` before dynamically loading an adapter. Explicit backend URL variables continue to take precedence for PocketBase and TrailBase.

Supabase cannot receive numeric port overrides from its CLI. For a custom port base, the benchmark creates a private workdir below `.data/`, writes the exact equivalent `config.toml`, and copies the committed migration. It marks that directory with the expected project ID and refuses a nonempty unowned or mismatched directory. Lifecycle operations remain scoped to the derived project label; no global Docker cleanup is introduced.

## Boundary search

The configured stages remain authoritative initial stages. After they pass, the runner doubles concurrency up to `maxConcurrency` as it does today.

Once a lower passing stage and an upper boundary failure are known, the runner schedules integer midpoints inside that bracket. It stops when either:

- the bracket is one user wide; or
- four refinement stages have run.

The four-stage bound is the practical resolution control: it leaves at most one-sixteenth of the initial bracket width (for example, about 100 users from a 1,600-to-3,200 bracket) without sacrificing precision on small servers.

A boundary failure is either:

- an otherwise valid, conclusive SLO/capacity failure; or
- a stage invalid only because the co-located runner crossed its sustained overload threshold.

Missing samples, backend identity changes, resource-collection failures, lifecycle failures, grace expiry, and other integrity failures stop the search without being treated as a capacity bracket.

Stages remain sorted by requested users in the raw result even though refinement executes them out of order. Resource records retain stage-specific names. A runner-overload upper bound still makes the overall run invalid; its lower passing stage is useful whole-machine evidence but must not be described as isolated backend capacity.

## Result classification

New results record:

- `settings.executionTopology: "co-located"`;
- the bounded refinement method, four-stage maximum, and one-user integer floor.

Reports show the topology. Old schema-version-1 artifacts remain valid because these new settings are optional during validation, while aggregation naturally rejects old/new setting mixtures as incompatible.

## Portable capacity profile

`configs/server-capacity.json` keeps the existing medium dataset, workload weights, stage duration, warm-up, timeout, and SLOs. It starts at 5/10/25/50 users and allows adaptive growth through 10,000, matching the medium profile's 10,000 deterministic users.

This single config is used unchanged across hardware profiles. Different hosts are separate result groups. Each publishable capacity claim requires three compatible runs; the highest repeated passing point and any repeated failing/runner-bound point are reported without interpolation.

## Occupied-host protocol

For `azabab.com` or another occupied host:

1. Use a clean benchmark clone and clean pushed commit.
2. Use a dedicated unoccupied port base such as 18000.
3. Run one backend at a time.
4. Do not stop, reconfigure, or delete unrelated Nginx, PocketBase, Samba, Docker, or other services.
5. Accept that shared CPU, memory, disk, and network contention are part of the recorded co-located host state.
6. Retain every valid and invalid artifact.

Temporary service slowdown is accepted by the operator, but lifecycle ownership rules remain unchanged.
