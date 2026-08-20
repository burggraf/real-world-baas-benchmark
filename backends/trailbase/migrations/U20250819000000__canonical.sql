CREATE TABLE IF NOT EXISTS profiles (id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE CHECK(length(public_id)=15 AND public_id GLOB '[a-z0-9]*'), email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS profiles_email ON profiles(email);
