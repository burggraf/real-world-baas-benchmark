# PocketBase local backend

Tested versions:

- PocketBase `0.39.11`
- official npm SDK `pocketbase@0.28.0` (exactly pinned)

## Install the local binary

From the repository root, install the pinned binary with:

```sh
npm run download-backends
```

The downloader verifies the exact release archive, extracts only the root
`pocketbase` entry, and installs without replacing a different existing file at
`.tools/pocketbase-0.39.11/pocketbase`. `POCKETBASE_BIN` may select an absolute
or repository-relative manual installation; doctor still requires exact version
`0.39.11`.

| Target | Release asset | Archive SHA-256 | Executable SHA-256 |
| --- | --- | --- | --- |
| macOS ARM64 | `pocketbase_0.39.11_darwin_arm64.zip` | `9da6fbe11e82c5b1704e56f7457b24682e01c510206c29b798a458119fa2be20` | `804f9ef353684c1c6b03eaaa33ad7b3fef1eda8eb66ec5ecb113730a07f7a210` |
| macOS x64 | `pocketbase_0.39.11_darwin_amd64.zip` | `888892fe5fe64cea4a1441937671e191b32ed8f322fa09d3d7b3ca2fc1d7be29` | `3e6092e9825030ff9b48a685efd8d688ad87c17f4ea9d6a7cd9fc1e17b3d0748` |
| Linux ARM64 | `pocketbase_0.39.11_linux_arm64.zip` | `8c785618840df7ebba795fdf4eba33a5fed64ac5307ad8023b955b4ebb82048b` | `bb6f2e3373c7cdbed7f7919a203856f29d713d04cdc550dfec359d5d1437e5b3` |
| Linux x64 | `pocketbase_0.39.11_linux_amd64.zip` | `08b9fcda0d5fd42cb315dc15a36dfa121c993855bd635f01d347c31b4328ec34` | `88370d5f6fa4820cd2414fa53c6e168d3dd0e33b7a7fd9ff914265492a7aa3b6` |

## Run

```sh
BENCH_LIVE=1 npm test
BENCH_LIVE=1 BENCH_LIVE_SEED=1 npm test
```

Defaults are `http://127.0.0.1:8090` and `.data/pocketbase`. Override them with
`POCKETBASE_URL` and `POCKETBASE_DATA_DIR`. The URL must remain local HTTP. The
adapter always supplies absolute `--dir` and `--migrationsDir` values and spawns
without a shell.

`reset()` stops only the process owned by this adapter, refuses to remove
unowned/in-use data, removes only the configured data directory, applies the
committed migration (which provisions the setup superuser without putting its
password in a process argument), and restarts. Server output is appended to
`.data/logs/pocketbase.log`. Setup and benchmark users have separate local
password constants; neither is included in adapter errors or result output.

## Schema and authorization notes

The prebuilt v0.39.11 application supplies the `users` auth collection; the
migration configures it for benchmark password auth and adds `displayName`.
Organizations, memberships, projects, tasks, comments, and activities are
created entirely by the migration. Batch requests are explicitly enabled and
capped at 50 requests with an 8 MiB maximum batch body.

Tasks store `organization` in addition to `project`; comments store both
`organization` and `project` in addition to `task`. This deliberate
denormalization keeps tenant rules and their indexes direct and measurable.
Write rules freeze those tenant keys and require every non-empty task assignee
to have a membership in the task organization. Members can CRUD tasks and
comments; only organization owners/admins can change roles for memberships in
the organization supplied to the adapter. Activity creation
is included transactionally in each measured task/comment workflow.

PocketBase applies non-empty list rules as filters, so an unauthorized list is
an empty HTTP 200 page. Unauthorized protected record reads/updates/deletes are
concealed as HTTP 404. The adapter preserves status 404 while safely classifying
it as authorization denial; it does not rewrite it to 403.
