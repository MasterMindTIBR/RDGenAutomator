-- Rock 4: durable intent, lease ownership and encrypted remote metadata.
ALTER TABLE build_jobs
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  ADD COLUMN IF NOT EXISTS manual_retry_after timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_remote_may_continue boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_error_code text;

ALTER TABLE build_attempts
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS start_intent_at timestamptz,
  ADD COLUMN IF NOT EXISTS remote_uuid text,
  ADD COLUMN IF NOT EXISTS remote_filename text,
  ADD COLUMN IF NOT EXISTS remote_platform text,
  ADD COLUMN IF NOT EXISTS remote_stage text,
  ADD COLUMN IF NOT EXISTS remote_metadata_protected_id uuid REFERENCES protected_records(id),
  ADD COLUMN IF NOT EXISTS last_polled_at timestamptz,
  ADD COLUMN IF NOT EXISTS ended_at timestamptz,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS risk_confirmed_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS build_attempts_one_active_per_job
  ON build_attempts (job_id) WHERE active;
CREATE INDEX IF NOT EXISTS build_jobs_recovery_idx ON build_jobs (status, next_retry_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS job_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES build_jobs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('dispatch', 'poll')),
  idempotency_key text NOT NULL UNIQUE,
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_outbox_dispatch_idx ON job_outbox (published_at, available_at);
