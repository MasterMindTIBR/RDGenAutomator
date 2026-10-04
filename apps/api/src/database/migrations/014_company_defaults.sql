-- Rock 3 (RF): company program/executable name defaults.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_display_name text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_technical_name text;
