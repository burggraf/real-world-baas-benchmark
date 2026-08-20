# Supabase backend

Local lifecycle uses Supabase CLI 2.115.0 with project `realworldbaasbench` and API/database/Studio/Inbucket ports 55321/55322/55323/55324. Commands are project-scoped through the backend workdir and `--project-id`; stop never uses global cleanup.

The service role is restricted to setup/seed operations. Measured sessions use isolated, nonpersistent supabase-js 2.112.3 clients with anon/publishable keys and RLS. `SUPABASE_BIN` may override the CLI path. Large-profile auth provisioning is intentionally bounded by sequential admin user creation; use small/medium profiles for local runs.
