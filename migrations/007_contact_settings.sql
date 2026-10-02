CREATE TABLE IF NOT EXISTS contact_settings (
  id integer PRIMARY KEY CHECK (id=1),
  whatsapp text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO contact_settings(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
