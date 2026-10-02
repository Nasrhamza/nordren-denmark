CREATE TABLE IF NOT EXISTS notifications (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL, title text NOT NULL, message text NOT NULL,
 target_id uuid, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_inbox ON notifications(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS complaints (
 id uuid PRIMARY KEY, booking_id uuid NOT NULL REFERENCES bookings(id),
 user_id uuid NOT NULL REFERENCES users(id), message text NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
 response text NOT NULL DEFAULT '', responded_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS complaints_booking ON complaints(booking_id);
ALTER TABLE enquiries DROP CONSTRAINT IF EXISTS enquiries_kind_check;
ALTER TABLE enquiries ADD CONSTRAINT enquiries_kind_check CHECK(kind IN ('quote','contact','business'));
