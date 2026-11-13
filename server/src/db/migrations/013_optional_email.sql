-- Some operators and technicians have no corporate e-mail: they log in with the registration number.
-- Every user still needs one of the two to log in.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_login_ck CHECK (email IS NOT NULL OR registration IS NOT NULL);
