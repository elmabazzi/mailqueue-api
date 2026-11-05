-- Up Migration

-- One row per email submitted to the API. The background worker updates the row
-- as it processes the job: pending -> sent, or pending -> failed after all retries.
CREATE TABLE email_jobs (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email            text        NOT NULL,
  subject             text        NOT NULL,
  body                text        NOT NULL,
  status              text        NOT NULL DEFAULT 'pending',
  attempts            integer     NOT NULL DEFAULT 0,
  last_error          text,
  provider_message_id text,
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- Only the three statuses the application knows about are allowed.
  CONSTRAINT email_jobs_status_check
    CHECK (status IN ('pending', 'sent', 'failed')),

  CONSTRAINT email_jobs_attempts_check
    CHECK (attempts >= 0),

  -- Safety net behind the API validation: no empty or oversized values.
  -- 320 = max length of an email address; 998 = max length of an email header line.
  CONSTRAINT email_jobs_to_email_length_check
    CHECK (char_length(to_email) BETWEEN 3 AND 320),
  CONSTRAINT email_jobs_subject_length_check
    CHECK (char_length(subject) BETWEEN 1 AND 998),
  CONSTRAINT email_jobs_body_length_check
    CHECK (char_length(body) BETWEEN 1 AND 100000),

  -- A job has a sent_at timestamp if and only if it was actually sent.
  CONSTRAINT email_jobs_sent_at_matches_status_check
    CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);

-- Speeds up "list emails, optionally filtered by status, newest first".
CREATE INDEX email_jobs_status_created_at_idx ON email_jobs (status, created_at DESC);
CREATE INDEX email_jobs_created_at_idx ON email_jobs (created_at DESC);

-- Keep updated_at correct automatically on every UPDATE, even if code forgets to set it.
CREATE FUNCTION email_jobs_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER email_jobs_set_updated_at
  BEFORE UPDATE ON email_jobs
  FOR EACH ROW EXECUTE FUNCTION email_jobs_set_updated_at();

-- Down Migration

DROP TRIGGER IF EXISTS email_jobs_set_updated_at ON email_jobs;
DROP FUNCTION IF EXISTS email_jobs_set_updated_at();
DROP TABLE IF EXISTS email_jobs;
