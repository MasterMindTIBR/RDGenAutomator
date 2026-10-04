-- Rock 2 (RF): actor-bound one-time clone drafts carrying copied effective image bytes.
CREATE TABLE IF NOT EXISTS clone_drafts (
  token uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES users(id),
  source_request_id uuid NOT NULL REFERENCES build_requests(id) ON DELETE CASCADE,
  server_id uuid NOT NULL,
  branding_id uuid,
  company_id uuid,
  presets jsonb NOT NULL DEFAULT '{}'::jsonb,
  profiles text[] NOT NULL,
  platforms text[] NOT NULL,
  version text NOT NULL,
  display_name text NOT NULL,
  technical_name text NOT NULL,
  icon_storage_key text,
  logo_storage_key text,
  privacy_storage_key text,
  icon_missing boolean NOT NULL DEFAULT false,
  logo_missing boolean NOT NULL DEFAULT false,
  privacy_missing boolean NOT NULL DEFAULT false,
  consumed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clone_drafts_actor_idx ON clone_drafts (actor_id, consumed_at, expires_at);
CREATE INDEX IF NOT EXISTS clone_drafts_expiry_idx ON clone_drafts (expires_at, consumed_at);
