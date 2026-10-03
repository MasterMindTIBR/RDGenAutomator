-- Rock 5: immutable local artifact provenance and race-safe expiry.
ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS filename text,
  ADD COLUMN IF NOT EXISTS provenance_protected_id uuid REFERENCES protected_records(id),
  ADD COLUMN IF NOT EXISTS tombstoned_at timestamptz,
  ADD COLUMN IF NOT EXISTS purged_at timestamptz,
  ADD COLUMN IF NOT EXISTS download_lease_owner text,
  ADD COLUMN IF NOT EXISTS download_lease_expires_at timestamptz;

ALTER TABLE build_requests
  ADD COLUMN IF NOT EXISTS logo_tombstoned_at timestamptz,
  ADD COLUMN IF NOT EXISTS logo_purged_at timestamptz;

CREATE INDEX IF NOT EXISTS artifacts_retention_idx
  ON artifacts (retention_expires_at, tombstoned_at, download_lease_expires_at);
CREATE INDEX IF NOT EXISTS build_requests_logo_retention_idx
  ON build_requests (logo_retention_expires_at, logo_tombstoned_at);

CREATE TABLE IF NOT EXISTS retention_leases (
  name text PRIMARY KEY,
  owner text,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO retention_leases (name) VALUES ('persistent-storage') ON CONFLICT (name) DO NOTHING;
