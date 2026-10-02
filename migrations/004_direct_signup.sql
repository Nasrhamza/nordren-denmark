UPDATE users SET email_verified=true WHERE email_verified=false;
ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT true;
DELETE FROM auth_tokens WHERE purpose='verify';
