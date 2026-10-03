-- The encrypted provenance blob itself is append-only once linked to an artifact.
CREATE OR REPLACE FUNCTION reject_immutable_artifact_record_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD.purpose = 'artifact-immutable-provenance' THEN
    RAISE EXCEPTION 'artifact provenance record is immutable';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS protected_records_artifact_provenance_immutable ON protected_records;
CREATE TRIGGER protected_records_artifact_provenance_immutable BEFORE UPDATE OR DELETE ON protected_records
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_artifact_record_mutation();
