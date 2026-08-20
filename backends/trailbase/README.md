# TrailBase adapter

Pinned compatibility target: TrailBase server `v0.33.1` and npm SDK `trailbase@0.14.0`.
The local depot is ignored and selected with `TRAILBASE_DATA_DIR`; binary and endpoint
may be overridden with `TRAILBASE_BIN` and `TRAILBASE_URL`. Record APIs expose a
portable text `public_id`; TrailBase's internal integer key is never returned at the
shared boundary.
