-- Clean cutover: platforms and a shared version are request input, not admin-managed targets.
ALTER TABLE build_jobs DROP COLUMN IF EXISTS target_id;
DROP TABLE IF EXISTS allowed_build_targets;

CREATE TABLE IF NOT EXISTS brandings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  company_name text NOT NULL,
  android_application_id text,
  theme text NOT NULL CHECK (theme IN ('light', 'dark', 'system')),
  theme_scope text NOT NULL CHECK (theme_scope IN ('default', 'override')),
  icon_storage_key text,
  icon_content_type text,
  icon_bytes bigint CHECK (icon_bytes >= 0),
  icon_width integer CHECK (icon_width > 0),
  icon_height integer CHECK (icon_height > 0),
  icon_tombstoned_at timestamptz,
  icon_purged_at timestamptz,
  logo_storage_key text,
  logo_content_type text,
  logo_bytes bigint CHECK (logo_bytes >= 0),
  logo_width integer CHECK (logo_width > 0),
  logo_height integer CHECK (logo_height > 0),
  logo_tombstoned_at timestamptz,
  logo_purged_at timestamptz,
  privacy_storage_key text,
  privacy_content_type text,
  privacy_bytes bigint CHECK (privacy_bytes >= 0),
  privacy_width integer CHECK (privacy_width > 0),
  privacy_height integer CHECK (privacy_height > 0),
  privacy_tombstoned_at timestamptz,
  privacy_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE build_requests
  ADD COLUMN IF NOT EXISTS branding_id uuid REFERENCES brandings(id),
  ADD COLUMN IF NOT EXISTS icon_storage_key text,
  ADD COLUMN IF NOT EXISTS icon_content_type text,
  ADD COLUMN IF NOT EXISTS icon_bytes bigint CHECK (icon_bytes >= 0),
  ADD COLUMN IF NOT EXISTS icon_width integer CHECK (icon_width > 0),
  ADD COLUMN IF NOT EXISTS icon_height integer CHECK (icon_height > 0),
  ADD COLUMN IF NOT EXISTS icon_retention_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS icon_tombstoned_at timestamptz,
  ADD COLUMN IF NOT EXISTS icon_purged_at timestamptz,
  ADD COLUMN IF NOT EXISTS privacy_storage_key text,
  ADD COLUMN IF NOT EXISTS privacy_content_type text,
  ADD COLUMN IF NOT EXISTS privacy_bytes bigint CHECK (privacy_bytes >= 0),
  ADD COLUMN IF NOT EXISTS privacy_width integer CHECK (privacy_width > 0),
  ADD COLUMN IF NOT EXISTS privacy_height integer CHECK (privacy_height > 0),
  ADD COLUMN IF NOT EXISTS privacy_retention_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS privacy_tombstoned_at timestamptz,
  ADD COLUMN IF NOT EXISTS privacy_purged_at timestamptz;

CREATE INDEX IF NOT EXISTS build_requests_icon_retention_idx ON build_requests (icon_retention_expires_at, icon_tombstoned_at);
CREATE INDEX IF NOT EXISTS build_requests_privacy_retention_idx ON build_requests (privacy_retention_expires_at, privacy_tombstoned_at);
