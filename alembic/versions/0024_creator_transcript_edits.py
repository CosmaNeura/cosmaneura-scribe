"""Retain explicit creator corrections and named speaker confirmations.

Revision ID: 0024
Revises: e9c4b7220d31
"""
from alembic import op

revision = "0024"
down_revision = "e9c4b7220d31"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '60s'")
    statements = """
    CREATE TABLE public.creator_transcript_edits (
        tenant_id uuid NOT NULL, session_id uuid NOT NULL, edit_id uuid NOT NULL,
        source_transcript_version integer NOT NULL,
        prior_working_version integer NOT NULL CHECK (prior_working_version >= 1),
        result_working_version integer NOT NULL,
        creator_actor_id varchar(128) NOT NULL, request jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (tenant_id, edit_id),
        UNIQUE (tenant_id, session_id, result_working_version),
        CHECK (result_working_version = prior_working_version + 1),
        CHECK (jsonb_typeof(request) = 'object' AND octet_length(request::text) <= 4000000),
        FOREIGN KEY (tenant_id, session_id, source_transcript_version)
            REFERENCES public.normalized_source_transcripts
                (tenant_id, session_id, source_transcript_version) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, session_id, prior_working_version)
            REFERENCES public.normalized_working_transcripts
                (tenant_id, session_id, working_transcript_version) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, session_id, result_working_version)
            REFERENCES public.normalized_working_transcripts
                (tenant_id, session_id, working_transcript_version)
            ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
    );
    ALTER TABLE public.creator_transcript_edits ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.creator_transcript_edits FORCE ROW LEVEL SECURITY;
    CREATE POLICY creator_transcript_edits_tenant_isolation ON public.creator_transcript_edits
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    REVOKE ALL PRIVILEGES ON public.creator_transcript_edits FROM PUBLIC;
    CREATE TRIGGER creator_transcript_edits_immutable BEFORE UPDATE
        ON public.creator_transcript_edits FOR EACH ROW
        EXECUTE FUNCTION public.reject_normalized_working_update();
    CREATE TRIGGER creator_transcript_edits_delete_fence BEFORE DELETE
        ON public.creator_transcript_edits FOR EACH ROW
        EXECUTE FUNCTION public.enforce_normalized_working_delete_fence();
    """
    for statement in statements.split(";"):
        if statement.strip():
            op.execute(statement)
    op.execute("""
    CREATE FUNCTION public.enforce_creator_transcript_edit() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
    DECLARE valid boolean; item jsonb; total_chars bigint; edit_count integer;
    BEGIN
        SELECT true INTO valid FROM public.scribe_sessions s
        JOIN public.consent_records c ON c.tenant_id = s.tenant_id AND c.id = s.consent_record_id
        WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.session_id
          AND s.creator_actor_id = NEW.creator_actor_id AND c.revoked_at IS NULL
          AND c.all_parties_consented AND s.content_purged_at IS NULL
          AND clock_timestamp() < s.transcript_content_expires_at
          AND s.current_source_transcript_version = NEW.source_transcript_version
          AND s.working_transcript_id = (NEW.request->>'expected_working_transcript_id')::uuid
          AND s.current_working_transcript_version = CASE WHEN TG_WHEN = 'BEFORE'
              THEN NEW.prior_working_version ELSE NEW.result_working_version END
          AND s.status IN (
              'transcript_ready','review_required','translation_pending','quality_blocked')
        FOR UPDATE OF s, c;
        IF NOT COALESCE(valid, false) THEN
            RAISE EXCEPTION 'creator edit outside live creator scope' USING ERRCODE = '23514';
        END IF;
        IF TG_WHEN <> 'BEFORE' THEN RETURN NULL; END IF;
        IF NEW.request->>'schema_version' IS DISTINCT FROM '1.0'
           OR (NEW.request->>'expected_source_transcript_version')::integer IS DISTINCT FROM
               NEW.source_transcript_version
           OR (NEW.request->>'expected_working_transcript_version')::integer IS DISTINCT FROM
               NEW.prior_working_version
           OR (SELECT count(*) FROM jsonb_object_keys(NEW.request)) <> 6
           OR jsonb_typeof(NEW.request->'corrections') IS DISTINCT FROM 'array'
           OR jsonb_typeof(NEW.request->'speakers') IS DISTINCT FROM 'array'
           OR jsonb_array_length(NEW.request->'corrections') > 128
           OR jsonb_array_length(NEW.request->'speakers') > 128
           OR jsonb_array_length(NEW.request->'corrections') +
               jsonb_array_length(NEW.request->'speakers') = 0 THEN
            RAISE EXCEPTION 'creator edit request invalid' USING ERRCODE = '23514';
        END IF;
        FOR item IN SELECT value FROM jsonb_array_elements(NEW.request->'corrections') LOOP
            IF (SELECT count(*) FROM jsonb_object_keys(item)) <> 3
               OR NOT (item ?& ARRAY[
                   'source_segment_id','expected_source_segment_version','content'])
               OR jsonb_typeof(item->'content') IS DISTINCT FROM 'string'
               OR char_length(btrim(item->>'content')) NOT BETWEEN 1 AND 100000
               OR NOT EXISTS (SELECT 1 FROM public.normalized_working_segments w
                   WHERE w.tenant_id = NEW.tenant_id AND w.session_id = NEW.session_id
                     AND w.working_transcript_version = NEW.prior_working_version
                     AND w.source_transcript_version = NEW.source_transcript_version
                     AND w.source_segment_id = (item->>'source_segment_id')::uuid
                     AND w.source_segment_version =
                         (item->>'expected_source_segment_version')::integer
                     AND w.resolution <> 'unresolved' AND w.content IS NOT NULL) THEN
                RAISE EXCEPTION 'creator correction target invalid' USING ERRCODE = '23514';
            END IF;
        END LOOP;
        FOR item IN SELECT value FROM jsonb_array_elements(NEW.request->'speakers') LOOP
            IF (SELECT count(*) FROM jsonb_object_keys(item)) <> 4
               OR NOT (item ?& ARRAY['speaker_id','role','display_name','detail'])
               OR jsonb_typeof(item->'display_name') NOT IN ('string','null')
               OR jsonb_typeof(item->'detail') NOT IN ('string','null')
               OR (item->>'role') NOT IN ('clinician','patient','other','unknown')
               OR item->>'role' IS NULL
               OR (item->>'detail' IS NOT NULL AND (item->>'role' <> 'other' OR item->>'detail'
                   NOT IN ('interpreter','other')))
               OR (item->>'display_name' IS NOT NULL AND (item->>'role' = 'unknown'
                   OR char_length(btrim(item->>'display_name')) NOT BETWEEN 1 AND 120
                   OR item->>'display_name' ~ '[[:cntrl:]]'))
               OR NOT EXISTS (SELECT 1 FROM public.normalized_source_segments s
                   WHERE s.tenant_id = NEW.tenant_id AND s.session_id = NEW.session_id
                     AND s.source_transcript_version = NEW.source_transcript_version
                     AND s.speaker_id = (item->>'speaker_id')::uuid) THEN
                RAISE EXCEPTION 'creator speaker target invalid' USING ERRCODE = '23514';
            END IF;
        END LOOP;
        IF (SELECT count(*) FROM jsonb_array_elements(NEW.request->'corrections')) <>
           (SELECT count(DISTINCT value->>'source_segment_id') FROM
               jsonb_array_elements(NEW.request->'corrections'))
           OR (SELECT count(*) FROM jsonb_array_elements(NEW.request->'speakers')) <>
           (SELECT count(DISTINCT value->>'speaker_id') FROM
               jsonb_array_elements(NEW.request->'speakers')) THEN
            RAISE EXCEPTION 'creator edit duplicate target' USING ERRCODE = '23514';
        END IF;
        SELECT count(*), COALESCE(sum((SELECT COALESCE(sum(char_length(value->>'content')),0)
            FROM jsonb_array_elements(e.request->'corrections'))),0)
        INTO edit_count, total_chars FROM public.creator_transcript_edits e
        WHERE e.tenant_id = NEW.tenant_id AND e.session_id = NEW.session_id
          AND e.source_transcript_version = NEW.source_transcript_version;
        IF edit_count >= 1024 OR total_chars + (SELECT
            COALESCE(sum(char_length(value->>'content')),0)
            FROM jsonb_array_elements(NEW.request->'corrections')) > 1000000 THEN
            RAISE EXCEPTION 'creator edit history limit reached' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END; $$;
    """)
    statements = """
    REVOKE ALL PRIVILEGES ON FUNCTION public.enforce_creator_transcript_edit() FROM PUBLIC;
    CREATE TRIGGER creator_transcript_edits_insert_fence BEFORE INSERT
        ON public.creator_transcript_edits FOR EACH ROW EXECUTE FUNCTION
            public.enforce_creator_transcript_edit();
    CREATE CONSTRAINT TRIGGER creator_transcript_edits_precommit AFTER INSERT
        ON public.creator_transcript_edits DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION public.enforce_creator_transcript_edit();
    """
    for statement in statements.split(";"):
        if statement.strip():
            op.execute(statement)
    # Preserve the existing complete-source, translation, consent and readiness
    # checks. Only exact immutable creator evidence may override these 3 values.
    for previous, array, match, field in (
        ("source.speaker_role", "speakers", "speaker_id", "role"),
        ("source.content", "corrections", "source_segment_id", "content"),
        ("translation.content", "corrections", "source_segment_id", "content"),
    ):
        column = "speaker_role" if field == "role" else "content"
        predicate = f"working.{column} IS DISTINCT FROM {previous}"
        replacement = f"""working.{column} IS DISTINCT FROM COALESCE((
            SELECT item->>'{field}' FROM public.creator_transcript_edits e,
                LATERAL jsonb_array_elements(e.request->'{array}') item
            WHERE e.tenant_id = NEW.tenant_id AND e.session_id = NEW.session_id
              AND e.source_transcript_version = NEW.source_transcript_version
              AND e.result_working_version <= NEW.working_transcript_version
              AND (item->>'{match}')::uuid = working.{match}
            ORDER BY e.result_working_version DESC LIMIT 1), {previous})"""
        op.execute(f"""
        DO $replace$ DECLARE definition text; previous text := $old${predicate}$old$;
        BEGIN
            SELECT pg_get_functiondef('public.enforce_working_transcript_complete()'::regprocedure)
                INTO STRICT definition;
            IF length(definition) - length(replace(definition, previous, '')) <> length(previous)
                THEN
                RAISE EXCEPTION 'unexpected working transcript lineage predicate';
            END IF;
            EXECUTE replace(definition, previous, $new${replacement}$new$);
        END; $replace$;
        """)


def downgrade() -> None:
    raise RuntimeError(
        "expand recovery retains larger transcript capacity and creator edit history"
    )
