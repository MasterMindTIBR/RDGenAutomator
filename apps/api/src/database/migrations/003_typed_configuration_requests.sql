CREATE TABLE IF NOT EXISTS allowed_build_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 80),
  platform text NOT NULL CHECK (platform IN ('windows', 'windows-x86', 'linux', 'android', 'macos')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version, platform)
);

ALTER TABLE build_requests
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS server_id uuid REFERENCES rustdesk_servers(id),
  ADD COLUMN IF NOT EXISTS logo_storage_key text,
  ADD COLUMN IF NOT EXISTS logo_content_type text,
  ADD COLUMN IF NOT EXISTS logo_bytes bigint CHECK (logo_bytes >= 0),
  ADD COLUMN IF NOT EXISTS logo_width integer CHECK (logo_width > 0),
  ADD COLUMN IF NOT EXISTS logo_height integer CHECK (logo_height > 0),
  ADD COLUMN IF NOT EXISTS logo_retention_expires_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS build_requests_creator_idempotency_key_idx
  ON build_requests (creator_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE build_jobs
  ADD COLUMN IF NOT EXISTS version text,
  ADD COLUMN IF NOT EXISTS preset_id uuid REFERENCES presets(id),
  ADD COLUMN IF NOT EXISTS target_id uuid REFERENCES allowed_build_targets(id),
  ADD COLUMN IF NOT EXISTS resolved_configuration_protected_id uuid REFERENCES protected_records(id),
  ADD COLUMN IF NOT EXISTS configuration_redacted jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE build_attempts
  ADD COLUMN IF NOT EXISTS resolved_configuration_protected_id uuid REFERENCES protected_records(id);
