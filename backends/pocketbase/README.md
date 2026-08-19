# PocketBase local backend

Tested versions:

- PocketBase `0.39.11`
- official npm SDK `pocketbase@0.28.0` (exactly pinned)

## Install the local binary

The adapter never downloads or updates executables. Put the verified binary at
`.tools/pocketbase-0.39.11/pocketbase`, or set `POCKETBASE_BIN` to an absolute or
repository-relative path.

| Platform | Release asset | SHA-256 |
| --- | --- | --- |
| macOS ARM64 | `pocketbase_0.39.11_darwin_arm64.zip` | `9da6fbe11e82c5b1704e56f7457b24682e01c510206c29b798a458119fa2be20` |
| Linux x64 | `pocketbase_0.39.11_linux_amd64.zip` | `08b9fcda0d5fd42cb315dc15a36dfa121c993855bd635f01d347c31b4328ec34` |
| Linux ARM64 | `pocketbase_0.39.11_linux_arm64.zip` | `8c785618840df7ebba795fdf4eba33a5fed64ac5307ad8023b955b4ebb82048b` |

Example Linux x64 installation (replace the asset and checksum with the Linux
ARM64 row on ARM64):

```sh
mkdir -p .tools/pocketbase-0.39.11
curl --fail --location --proto '=https' --tlsv1.2 \
  -o .tools/pocketbase_0.39.11_linux_amd64.zip \
  https://github.com/pocketbase/pocketbase/releases/download/v0.39.11/pocketbase_0.39.11_linux_amd64.zip
printf '%s  %s\n' \
  '08b9fcda0d5fd42cb315dc15a36dfa121c993855bd635f01d347c31b4328ec34' \
  '.tools/pocketbase_0.39.11_linux_amd64.zip' | sha256sum --check -
unzip .tools/pocketbase_0.39.11_linux_amd64.zip -d .tools/pocketbase-0.39.11
chmod 755 .tools/pocketbase-0.39.11/pocketbase
.tools/pocketbase-0.39.11/pocketbase --version
```

The macOS verification equivalent uses `shasum -a 256 -c -`.

## Run

```sh
BENCH_LIVE=1 npm test
BENCH_LIVE=1 BENCH_LIVE_SEED=1 npm test
```

Defaults are `http://127.0.0.1:8090` and `.data/pocketbase`. Override them with
`POCKETBASE_URL` and `POCKETBASE_DATA_DIR`. The URL must remain local HTTP. The
adapter always supplies absolute `--dir` and `--migrationsDir` values and spawns
without a shell.

`reset()` stops only the process owned by this adapter, removes only the
configured data directory, applies the committed migration, provisions the
local setup superuser, and restarts. Server output is appended to
`.data/logs/pocketbase.log`. Setup and benchmark users have separate local
password constants; neither is included in adapter errors or result output.

## Schema and authorization notes

The prebuilt v0.39.11 application supplies the `users` auth collection; the
migration configures it for benchmark password auth and adds `displayName`.
Organizations, memberships, projects, tasks, comments, and activities are
created entirely by the migration. Batch requests are explicitly enabled and
capped at 50 requests.

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
