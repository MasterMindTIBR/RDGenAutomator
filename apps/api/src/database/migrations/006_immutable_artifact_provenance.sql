-- Immutable local evidence: retention may update its lifecycle columns only.
CREATE OR REPLACE FUNCTION reject_artifact_provenance_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD.storage_key <> NEW.storage_key OR OLD.filename IS DISTINCT FROM NEW.filename OR OLD.sha256 <> NEW.sha256
     OR OLD.bytes <> NEW.bytes OR OLD.content_type <> NEW.content_type OR OLD.provenance_protected_id IS DISTINCT FROM NEW.provenance_protected_id THEN
    RAISE EXCEPTION 'artifact provenance is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS artifacts_provenance_immutable ON artifacts;
CREATE TRIGGER artifacts_provenance_immutable BEFORE UPDATE ON artifacts
  FOR EACH ROW EXECUTE FUNCTION reject_artifact_provenance_mutation();
