CREATE TABLE booking_photos (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id),
  uploaded_by uuid NOT NULL REFERENCES users(id),
  uploader_name text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('before','after')),
  room text NOT NULL,
  caption text NOT NULL DEFAULT '',
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  original bytea NOT NULL,
  preview bytea NOT NULL,
  original_size integer NOT NULL CHECK(original_size BETWEEN 1 AND 8388608),
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(booking_id,sha256)
);
CREATE INDEX booking_photos_booking ON booking_photos(booking_id,phase,created_at);
