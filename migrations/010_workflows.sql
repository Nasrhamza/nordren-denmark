ALTER TABLE bookings ADD COLUMN reschedule_request jsonb;
ALTER TABLE bookings ADD COLUMN acknowledgements jsonb NOT NULL DEFAULT '{}';
ALTER TABLE enquiries ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE TABLE business_offers (
 enquiry_id uuid PRIMARY KEY REFERENCES enquiries(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id),
 details jsonb NOT NULL,
 total integer NOT NULL CHECK(total>=0),
 status text NOT NULL DEFAULT 'sent' CHECK(status IN ('sent','accepted','declined')),
 booking_id uuid REFERENCES bookings(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE complaint_messages (
 id uuid PRIMARY KEY,
 complaint_id uuid NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
 author_id uuid REFERENCES users(id) ON DELETE SET NULL,
 author_name text NOT NULL,
 author_role text NOT NULL,
 message text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX complaint_messages_thread ON complaint_messages(complaint_id,created_at,id);
INSERT INTO complaint_messages(id,complaint_id,author_id,author_name,author_role,message,created_at) SELECT c.id,c.id,c.responded_by,coalesce(u.name,'NordRen'),coalesce(u.role,'admin'),c.response,c.updated_at FROM complaints c LEFT JOIN users u ON u.id=c.responded_by WHERE c.response<>'';
