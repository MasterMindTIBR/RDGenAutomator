CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  server_id uuid NOT NULL REFERENCES rustdesk_servers(id),
  branding_id uuid REFERENCES brandings(id) ON DELETE SET NULL,
  preset_full_id uuid REFERENCES presets(id) ON DELETE SET NULL,
  preset_qs_id uuid REFERENCES presets(id) ON DELETE SET NULL,
  is_public boolean NOT NULL DEFAULT false,
  public_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE build_requests ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS build_requests_company_id_idx ON build_requests (company_id);

ALTER TABLE companies ADD CONSTRAINT companies_public_request_id_fkey
  FOREIGN KEY (public_request_id) REFERENCES build_requests(id) ON DELETE SET NULL;
