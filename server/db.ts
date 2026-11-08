import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
// Columns named *_sealed hold values encrypted with the install's key (seal.ts); everything else is in clear because
// it is what lists, the org chart and the leave rules sort and filter by. Days are YYYY-MM-DD, instants ISO 8601.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE departments (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE COLLATE NOCASE,
     parent_id TEXT REFERENCES departments (id) ON DELETE SET NULL,
     head_id TEXT,
     -- The Identity group its people are put in; the department's name when null.
     identity_group TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE positions (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     department_id TEXT REFERENCES departments (id) ON DELETE SET NULL,
     created_at TEXT NOT NULL,
     UNIQUE (title, department_id)
   );
   -- An employee. Status is not kept: it follows from start_date and end_date and today.
   CREATE TABLE employees (
     id TEXT PRIMARY KEY,
     number TEXT UNIQUE,
     first_name TEXT NOT NULL,
     last_name TEXT NOT NULL,
     preferred_name TEXT,
     work_email TEXT UNIQUE,
     department_id TEXT REFERENCES departments (id) ON DELETE SET NULL,
     position_id TEXT REFERENCES positions (id) ON DELETE SET NULL,
     manager_id TEXT REFERENCES employees (id) ON DELETE SET NULL,
     location TEXT,
     employment_type TEXT NOT NULL CHECK (employment_type IN ('full_time', 'part_time', 'intern', 'contractor')),
     start_date TEXT NOT NULL,
     service_start TEXT,
     probation_end TEXT,
     contract TEXT NOT NULL CHECK (contract IN ('indefinite', 'fixed')),
     contract_end TEXT,
     end_date TEXT,
     end_reason TEXT,
     -- Leave is granted for periods from this day on; what was earned before comes in as an opening balance.
     balances_from TEXT NOT NULL,
     -- birth date, gender, marital status, T.C. kimlik no, phone, personal email, address, emergency contact (JSON).
     personal_sealed TEXT,
     -- IBAN and bank (JSON).
     bank_sealed TEXT,
     national_id_index TEXT UNIQUE,
     identity_id TEXT,
     identity_state TEXT CHECK (identity_state IN ('active', 'disabled')),
     identity_synced TEXT,
     identity_error TEXT,
     identity_attempts INTEGER NOT NULL DEFAULT 0,
     identity_next_at TEXT,
     identity_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX employees_manager ON employees (manager_id);
   CREATE INDEX employees_department ON employees (department_id);
   CREATE INDEX employees_dates ON employees (start_date, end_date);
   -- Groups HR put the person in at Identity, so it takes out only what it put in.
   CREATE TABLE identity_groups (
     employee_id TEXT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     group_id TEXT NOT NULL,
     PRIMARY KEY (employee_id, name)
   ) WITHOUT ROWID;
   -- Pay from a day on. The amount is sealed.
   CREATE TABLE pay (
     id TEXT PRIMARY KEY,
     employee_id TEXT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
     from_date TEXT NOT NULL,
     amount_sealed TEXT NOT NULL,
     currency TEXT NOT NULL,
     period TEXT NOT NULL CHECK (period IN ('month', 'hour', 'year')),
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL
   );
   CREATE INDEX pay_employee ON pay (employee_id, from_date);
   -- Every change to a record, field by field. Values of the personal and pay parts are sealed.
   CREATE TABLE history (
     id INTEGER PRIMARY KEY,
     employee_id TEXT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
     at TEXT NOT NULL,
     by_id TEXT NOT NULL,
     by_name TEXT NOT NULL,
     grp TEXT NOT NULL,
     field TEXT NOT NULL,
     old_value TEXT,
     new_value TEXT,
     sealed INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX history_employee ON history (employee_id, at);
   -- Every look at a record, a document, its history or its pay (KVKK): who, when, what, and as whom.
   CREATE TABLE access_log (
     id INTEGER PRIMARY KEY,
     employee_id TEXT NOT NULL,
     at TEXT NOT NULL,
     by_id TEXT NOT NULL,
     by_name TEXT NOT NULL,
     as_whom TEXT NOT NULL,
     what TEXT NOT NULL,
     parts TEXT NOT NULL
   );
   CREATE INDEX access_log_employee ON access_log (employee_id, at);
   CREATE INDEX access_log_at ON access_log (at);
   CREATE TABLE documents (
     id TEXT PRIMARY KEY,
     employee_id TEXT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     name TEXT NOT NULL,
     content_type TEXT NOT NULL,
     size INTEGER NOT NULL,
     content_sealed TEXT NOT NULL,
     expires_on TEXT,
     warned_at TEXT,
     uploaded_at TEXT NOT NULL,
     uploaded_by TEXT NOT NULL
   );
   CREATE INDEX documents_employee ON documents (employee_id);
   CREATE INDEX documents_expiry ON documents (expires_on) WHERE expires_on IS NOT NULL;
   CREATE TABLE leave_requests (
     id TEXT PRIMARY KEY,
     employee_id TEXT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
     type TEXT NOT NULL,
     start_date TEXT NOT NULL,
     end_date TEXT NOT NULL,
     -- The first day starts at noon; the last day ends at noon.
     start_half INTEGER NOT NULL DEFAULT 0,
     end_half INTEGER NOT NULL DEFAULT 0,
     days REAL NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
     note_sealed TEXT,
     document_id TEXT REFERENCES documents (id) ON DELETE SET NULL,
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL,
     decided_at TEXT
   );
   CREATE INDEX leave_employee ON leave_requests (employee_id, start_date);
   CREATE INDEX leave_dates ON leave_requests (start_date, end_date) WHERE status IN ('pending', 'approved');
   -- The steps a request goes through, as the rule in the file was when it was made.
   CREATE TABLE leave_steps (
     request_id TEXT NOT NULL REFERENCES leave_requests (id) ON DELETE CASCADE,
     pos INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('manager', 'second_manager', 'hr', 'member')),
     approver_id TEXT,
     approver_email TEXT,
     decision TEXT CHECK (decision IN ('approved', 'rejected')),
     by_id TEXT,
     by_name TEXT,
     at TEXT,
     note TEXT,
     PRIMARY KEY (request_id, pos)
   ) WITHOUT ROWID;
   CREATE INDEX leave_steps_approver ON leave_steps (approver_id) WHERE decision IS NULL;
   -- Days granted (+), carried over and expired (-), adjusted by HR. A request's days are not here: they are counted
   -- from the requests, so cancelling one gives them back.
   CREATE TABLE leave_ledger (
     id INTEGER PRIMARY KEY,
     employee_id TEXT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
     type TEXT NOT NULL,
     day TEXT NOT NULL,
     days REAL NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('accrual', 'expiry', 'adjustment')),
     period TEXT,
     note TEXT,
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL
   );
   CREATE UNIQUE INDEX leave_ledger_period ON leave_ledger (employee_id, type, kind, period) WHERE period IS NOT NULL;
   CREATE INDEX leave_ledger_employee ON leave_ledger (employee_id, type, day);
   CREATE TABLE checklist_runs (
     id TEXT PRIMARY KEY,
     employee_id TEXT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
     checklist TEXT NOT NULL,
     name TEXT NOT NULL,
     on_kind TEXT NOT NULL CHECK (on_kind IN ('start', 'end')),
     anchor TEXT NOT NULL,
     created_at TEXT NOT NULL,
     cancelled_at TEXT
   );
   CREATE INDEX checklist_runs_employee ON checklist_runs (employee_id);
   CREATE TABLE checklist_tasks (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL REFERENCES checklist_runs (id) ON DELETE CASCADE,
     task TEXT NOT NULL,
     pos INTEGER NOT NULL,
     text TEXT NOT NULL,
     who TEXT NOT NULL CHECK (who IN ('hr', 'manager', 'employee', 'member')),
     assignee_id TEXT,
     assignee_email TEXT,
     offset_days INTEGER NOT NULL,
     due_date TEXT NOT NULL,
     done_at TEXT,
     done_by TEXT
   );
   CREATE INDEX checklist_tasks_run ON checklist_tasks (run_id, pos);
   CREATE INDEX checklist_tasks_open ON checklist_tasks (due_date) WHERE done_at IS NULL;
   -- Emails waiting to be sent, tried again until they are taken or three days old.
   CREATE TABLE mail_outbox (
     id INTEGER PRIMARY KEY,
     recipient TEXT NOT NULL,
     subject TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at TEXT NOT NULL,
     next_at TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     error TEXT
   );
   -- Records deleted when their retention ran out, or by an admin: only the number and when, nothing personal.
   CREATE TABLE purges (id INTEGER PRIMARY KEY, number TEXT, at TEXT NOT NULL, reason TEXT NOT NULL, by_name TEXT NOT NULL);`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
