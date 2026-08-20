# TrailBase adapter

Compatibility is pinned to TrailBase server `v0.33.1` (`darwin-arm64`) and the
official npm SDK `trailbase@0.14.0`. npm integrity is
`sha512-IyD+TuPpgWOf7NXIWpZpE2bJx85GAQEtmFgcdehDUveL8osNg4C2H3Ey/0PJF9ahAEPYneKsGi4rQzi7tlZj0Q==`
(SHA-1 shasum `2208db5fb72030c7d87119bdf5807affe3560342`), obtained from the npm
registry metadata for 0.14.0. The release binary must be supplied at
`.tools/trailbase-0.33.1/trail` (or `TRAILBASE_BIN`); release asset SHA-256 was not
published by the source release, so deployments must record their locally computed
archive SHA-256 before use. The GitHub release API currently reports archive
SHA-256 `72ca231b0b02c51da587c69b120107312b1dd649bf6140db4f8101d0b58a4622` for
`https://github.com/trailbaseio/trailbase/releases/download/v0.33.1/trailbase_v0.33.1_arm64_apple_darwin.zip`.

The local endpoint defaults to `http://127.0.0.1:8090`; override it with
`TRAILBASE_URL`. `TRAILBASE_DATA_DIR` selects the ignored depot. `reset` copies the
repository migration/config into the depot and TrailBase applies migrations on start.
No setup credential is passed in argv or process logs.

TrailBase Record APIs require an internal integer primary key. Every canonical table
therefore has that minimum internal key plus a unique, strict 15-character lowercase
`publicId`; the adapter maps `publicId` at the shared boundary. SDK list requests use
explicit bounded pages (100 maximum), stable order, and typed filters. Record API
list denials can appear as empty pages, while protected record denials can appear as
404; this is the unavoidable server behavior and is normalized by the adapter.
