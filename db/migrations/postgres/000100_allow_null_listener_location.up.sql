BEGIN;

ALTER TABLE contractlisteners ALTER COLUMN location DROP NOT NULL;

COMMIT;