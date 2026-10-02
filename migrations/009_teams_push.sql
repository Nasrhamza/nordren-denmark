CREATE TABLE teams (id uuid PRIMARY KEY, name text NOT NULL, active boolean NOT NULL DEFAULT true);
CREATE TABLE team_members (team_id uuid REFERENCES teams(id) ON DELETE CASCADE, user_id uuid REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(team_id,user_id));
ALTER TABLE bookings ADD COLUMN team_id uuid REFERENCES teams(id);
ALTER TABLE bookings ADD COLUMN duration_minutes integer NOT NULL DEFAULT 120 CHECK(duration_minutes BETWEEN 30 AND 720);
CREATE TABLE booking_members (booking_id uuid REFERENCES bookings(id) ON DELETE CASCADE, user_id uuid REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(booking_id,user_id));
CREATE INDEX booking_members_user ON booking_members(user_id,booking_id);
CREATE TABLE push_subscriptions (endpoint text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, subscription jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE push_outbox (id uuid PRIMARY KEY, notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE, endpoint text NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE, attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, UNIQUE(notification_id,endpoint));
