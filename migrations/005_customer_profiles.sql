ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS address text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS postcode text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS city text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo bytea;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_mime text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_updated_at timestamptz;

UPDATE users
SET first_name=CASE WHEN position(' ' in name)>0 THEN split_part(name,' ',1) ELSE name END,
    last_name=CASE WHEN position(' ' in name)>0 THEN substring(name from position(' ' in name)+1) ELSE '' END
WHERE first_name='';
