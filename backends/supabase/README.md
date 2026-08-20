# Supabase backend

Local lifecycle uses Supabase CLI 2.115.0 with project `realworldbaasbench`. Its reserved local ports are API 55321, database 55322, Studio 55323, Inbucket 55324, SMTP 55325, POP3 55326, analytics 55327, pooler 55329, and shadow database 55330. Commands are project-scoped through the backend workdir and `--project-id`; stop never uses global cleanup.

The service role is restricted to setup/seed operations. Measured sessions use isolated, nonpersistent supabase-js 2.112.3 clients with anon/publishable keys and RLS. `SUPABASE_BIN` may override the CLI path. Auth provisioning uses the official admin SDK with concurrency capped at eight; all table inserts stream in batches of at most 100.
