export const SCHEMA = /* sql */ `
PRAGMA foreign_keys = ON;

CREATE TABLE companies (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE,
  erp_system       TEXT,
  default_currency TEXT NOT NULL,
  is_active        INTEGER NOT NULL
);

CREATE TABLE retailers (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  type   TEXT NOT NULL,
  region TEXT NOT NULL
);

CREATE TABLE reasons (
  code                 TEXT PRIMARY KEY,
  label                TEXT NOT NULL,
  category             TEXT NOT NULL,
  typically_disputable INTEGER NOT NULL
);

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  title         TEXT,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'analyst')),
  password_hash TEXT NOT NULL
);

-- Which companies a person may see. Admins implicitly see every company plus
-- records whose company could not be resolved.
CREATE TABLE memberships (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  PRIMARY KEY (user_id, company_id)
);

-- Small key/value store (currently just the session-signing key).
CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per deduction from the export. Cleaned values sit next to the raw
-- value they came from so nothing is lost and every fix is explainable.
CREATE TABLE deductions (
  id                 INTEGER PRIMARY KEY,           -- id from the export
  company_id         INTEGER REFERENCES companies(id), -- NULL: unresolved, admin-only
  source_company_ref TEXT,
  retailer_id        INTEGER REFERENCES retailers(id),
  retailer_raw       TEXT,
  reason_code        TEXT REFERENCES reasons(code),
  reason_raw         TEXT,
  invoice_number     TEXT,
  invoice_raw        TEXT,
  invoice_format     TEXT,
  amount_cents       INTEGER,
  amount_flag        TEXT NOT NULL CHECK (amount_flag IN ('ok', 'missing', 'suspect')),
  amount_raw         TEXT,
  amount_format      TEXT,
  currency           TEXT NOT NULL,
  deducted_on        TEXT,
  date_flag          TEXT NOT NULL CHECK (date_flag IN ('ok', 'missing', 'suspect')),
  deducted_raw       TEXT,
  date_format        TEXT,
  status             TEXT NOT NULL CHECK (status IN ('new', 'in_review', 'with_ops', 'disputed', 'closed')),
  resolution         TEXT CHECK (resolution IN ('accepted', 'recovered', 'partially_recovered', 'denied', 'withdrawn', 'written_off', 'legacy_unknown')),
  source_status      TEXT,
  record_state       TEXT NOT NULL CHECK (record_state IN ('active', 'deleted', 'duplicate', 'empty')),
  duplicate_of       INTEGER,
  assignee_id        INTEGER REFERENCES users(id),
  source_note        TEXT,
  ocr_confidence     REAL,
  field_aliases      TEXT,
  raw_json           TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CHECK ((status = 'closed') = (resolution IS NOT NULL))
);

CREATE INDEX deductions_scope ON deductions (record_state, company_id, status);
CREATE INDEX deductions_retailer ON deductions (retailer_id);
CREATE INDEX deductions_assignee ON deductions (assignee_id);

CREATE TABLE deduction_issues (
  id              INTEGER PRIMARY KEY,
  deduction_id    INTEGER NOT NULL REFERENCES deductions(id),
  code            TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('error', 'warning', 'info')),
  field           TEXT NOT NULL,
  message         TEXT NOT NULL,
  raw_value       TEXT,
  resolved_at     TEXT,
  resolved_by     INTEGER REFERENCES users(id),
  resolution_note TEXT
);

CREATE INDEX issues_deduction ON deduction_issues (deduction_id, resolved_at);

-- At most one dispute per deduction. Appeals stay on the same dispute.
CREATE TABLE disputes (
  id                    INTEGER PRIMARY KEY,
  deduction_id          INTEGER NOT NULL UNIQUE REFERENCES deductions(id),
  stage                 TEXT NOT NULL CHECK (stage IN ('preparing', 'submitted', 'approved', 'denied', 'closed')),
  claim_cents           INTEGER CHECK (claim_cents IS NULL OR claim_cents > 0),
  approved_cents        INTEGER CHECK (approved_cents IS NULL OR approved_cents >= 0),
  claim_reference       TEXT,
  submitted_on          TEXT,
  decided_on            TEXT,
  closed_on             TEXT,
  outcome               TEXT CHECK (outcome IN ('recovered', 'partially_recovered', 'denied', 'withdrawn', 'written_off')),
  appeal_count          INTEGER NOT NULL DEFAULT 0,
  stage_entered_at      TEXT NOT NULL,
  legacy_stage_inferred INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  CHECK ((stage = 'closed') = (outcome IS NOT NULL))
);

-- Money actually received. "Recovered" is the sum of these rows and nothing else.
CREATE TABLE recoveries (
  id           INTEGER PRIMARY KEY,
  dispute_id   INTEGER NOT NULL REFERENCES disputes(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  received_on  TEXT NOT NULL,
  method       TEXT NOT NULL CHECK (method IN ('check', 'ach', 'credit_memo', 'offset')),
  reference    TEXT,
  recorded_by  INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL
);

CREATE INDEX recoveries_dispute ON recoveries (dispute_id);

-- Append-only audit trail. actor_id NULL means the importer.
CREATE TABLE activity (
  id           INTEGER PRIMARY KEY,
  deduction_id INTEGER NOT NULL REFERENCES deductions(id),
  actor_id     INTEGER REFERENCES users(id),
  kind         TEXT NOT NULL,
  summary      TEXT NOT NULL,
  note         TEXT,
  detail_json  TEXT,
  simulated    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE INDEX activity_deduction ON activity (deduction_id, created_at);

CREATE TABLE import_runs (
  id          INTEGER PRIMARY KEY,
  started_at  TEXT NOT NULL,
  source_file TEXT NOT NULL,
  stats_json  TEXT NOT NULL
);
`;
