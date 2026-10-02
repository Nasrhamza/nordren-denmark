CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL, phone text NOT NULL DEFAULT '',
  password_hash text NOT NULL, role text NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin','cleaner')),
  email_verified boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY, user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  csrf text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify','reset')), expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  cleaner_id uuid REFERENCES users(id), details jsonb NOT NULL, total integer NOT NULL CHECK(total >= 0),
  status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','confirmed','assigned','progress','completed','cancelled')),
  paid boolean NOT NULL DEFAULT false, idempotency_key uuid NOT NULL,
  request_hash text NOT NULL, terms_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS bookings_owner ON bookings(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS bookings_cleaner ON bookings(cleaner_id,created_at DESC);
CREATE TABLE IF NOT EXISTS enquiries (
  id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('quote','contact')),
  details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY, actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL, target_id uuid, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mail_outbox (
  id uuid PRIMARY KEY, recipient text NOT NULL, subject text NOT NULL, body text NOT NULL,
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_pending ON mail_outbox(next_attempt_at) WHERE sent_at IS NULL;
CREATE TABLE IF NOT EXISTS rate_limits (
  key text PRIMARY KEY, hits integer NOT NULL, expires_at timestamptz NOT NULL
);
