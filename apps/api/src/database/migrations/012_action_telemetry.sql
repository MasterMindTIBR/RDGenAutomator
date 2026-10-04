-- Rock 1 (RF): shared GitHub Action snapshot cache, per-attempt telemetry, bounded workflow retry counter.
CREATE TABLE IF NOT EXISTS action_snapshots (
  run_id text PRIMARY KEY,
  source text NOT NULL,
  snapshot jsonb NOT NULL,
  complete boolean NOT NULL DEFAULT false,
  terminal boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL,
  attempted_at timestamptz NOT NULL,
  fetch_error text
);
CREATE INDEX IF NOT EXISTS action_snapshots_terminal_prune_idx ON action_snapshots (terminal, observed_at);

ALTER TABLE build_attempts ADD COLUMN IF NOT EXISTS action_telemetry jsonb;
ALTER TABLE build_jobs ADD COLUMN IF NOT EXISTS consecutive_workflow_infrastructure_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_workflow_infrastructure_failures >= 0);
