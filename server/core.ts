// What every part of HR works on: the database, the applied file, today in the file's zone, the install's key, and who
// may read which part of whose record.
//
// Who reads what (the file's `access`): a record has a directory part everyone signed in reads (name, work email,
// department, position, manager, location, start day) and five parts the file gives to readers: work (contract and
// dates), personal (birth date, T.C. kimlik no, contact details), pay (salary and bank account), documents and leave.
// Readers are the person themselves (self), anyone above them in the reporting line (manager), and the viewer and
// editor roles (HR staff and the tokens of other products). Admins and owners read everything. Every read of a part
// beyond the directory is written to the access log.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { atLeast } from "@openasy/auth";
import type { Config, ConfigFileState, Group, Language } from "./config.ts";
import { dayIn } from "./dates.ts";
import { log } from "./log.ts";
import type { Keyring } from "./seal.ts";
import { createStore, forbidden, notFound, type Actor } from "./store.ts";
import { say } from "./words.ts";

export interface EmployeeRow {
  id: string;
  number: string | null;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  work_email: string | null;
  department_id: string | null;
  position_id: string | null;
  manager_id: string | null;
  location: string | null;
  employment_type: "full_time" | "part_time" | "intern" | "contractor";
  start_date: string;
  service_start: string | null;
  probation_end: string | null;
  contract: "indefinite" | "fixed";
  contract_end: string | null;
  end_date: string | null;
  end_reason: string | null;
  balances_from: string;
  personal_sealed: string | null;
  bank_sealed: string | null;
  national_id_index: string | null;
  identity_id: string | null;
  identity_state: "active" | "disabled" | null;
  identity_synced: string | null;
  identity_error: string | null;
  identity_attempts: number;
  identity_next_at: string | null;
  identity_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Personal {
  birthDate: string | null;
  gender: "female" | "male" | "other" | null;
  maritalStatus: "single" | "married" | "divorced" | "widowed" | null;
  nationalId: string | null;
  nationality: string | null;
  phone: string | null;
  personalEmail: string | null;
  address: string | null;
  emergencyContact: { name: string; relation: string | null; phone: string } | null;
}
export const NO_PERSONAL: Personal = {
  birthDate: null,
  gender: null,
  maritalStatus: null,
  nationalId: null,
  nationality: null,
  phone: null,
  personalEmail: null,
  address: null,
  emergencyContact: null,
};
export interface Bank {
  iban: string | null;
  bankName: string | null;
}

/** Who is looking: the member or token, and the employee they are, found by their sign-in email. */
export interface Viewer {
  actor: Actor;
  employeeId: string | null;
}

export type Relation = "self" | "manager" | "viewer" | "editor" | "admin";

export interface CoreOptions {
  publicUrl: string;
  keyring: Keyring;
  clock?: () => number;
  env?: Record<string, string | undefined>;
  fileState?: () => ConfigFileState | null;
}

export function createCore(db: DatabaseSync, o: CoreOptions) {
  const s = createStore(db, o.clock ?? Date.now);
  let config: Config | null = null;
  let configText = "";

  const cfg = () => {
    if (!config) throw new Error("no settings applied");
    return config;
  };
  const today = () => dayIn(s.clock(), cfg().timeZone);

  const sealJson = (v: unknown, context: string) => o.keyring.seal(JSON.stringify(v), context);
  const openJson = <T>(sealed: string | null, context: string, fallback: T): T =>
    sealed ? (JSON.parse(o.keyring.open(sealed, context).toString("utf8")) as T) : fallback;
  const personalOf = (e: EmployeeRow): Personal => ({ ...NO_PERSONAL, ...openJson<Partial<Personal>>(e.personal_sealed, `personal:${e.id}`, {}) });
  const bankOf = (e: EmployeeRow): Bank => openJson<Bank>(e.bank_sealed, `bank:${e.id}`, { iban: null, bankName: null });

  const employee = (id: string) => s.one<EmployeeRow>("SELECT * FROM employees WHERE id = ?", id);
  const requireEmployee = (id: string) => {
    const e = employee(id);
    if (!e) throw notFound(`Employee ${id}`);
    return e;
  };

  function viewer(actor: Actor): Viewer {
    const email = actor.email?.toLowerCase();
    const row = email ? s.one<{ id: string }>("SELECT id FROM employees WHERE work_email = ?", email) : undefined;
    return { actor, employeeId: row?.id ?? null };
  }

  /** Each employee's manager, for walking up the reporting line without a query per step. */
  function managers(): Map<string, string | null> {
    return new Map(s.q<{ id: string; manager_id: string | null }>("SELECT id, manager_id FROM employees").map((r) => [r.id, r.manager_id]));
  }

  /** Whether `above` is somewhere above `id` in the reporting line. */
  function isAbove(above: string | null, id: string, line = managers()): boolean {
    if (!above) return false;
    let at = line.get(id) ?? null;
    for (let i = 0; at && i < 50; i++) {
      if (at === above) return true;
      at = line.get(at) ?? null;
    }
    return false;
  }

  function relations(v: Viewer, employeeId: string, line?: Map<string, string | null>): Set<Relation> {
    const r = new Set<Relation>();
    if (v.employeeId === employeeId) r.add("self");
    if (v.employeeId && isAbove(v.employeeId, employeeId, line)) r.add("manager");
    if (atLeast(v.actor.role, "viewer")) r.add("viewer");
    if (atLeast(v.actor.role, "editor")) r.add("editor");
    if (atLeast(v.actor.role, "admin")) r.add("admin");
    return r;
  }

  function canRead(v: Viewer, employeeId: string, group: Group, line?: Map<string, string | null>): boolean {
    const r = relations(v, employeeId, line);
    return r.has("admin") || cfg().access[group].some((x) => r.has(x));
  }

  /** The parts of a record the viewer reads. */
  function readable(v: Viewer, employeeId: string, line?: Map<string, string | null>): Group[] {
    const r = relations(v, employeeId, line);
    return (Object.keys(cfg().access) as Group[]).filter((g) => r.has("admin") || cfg().access[g].some((x) => r.has(x)));
  }

  function requireRead(v: Viewer, employeeId: string, group: Group) {
    if (!canRead(v, employeeId, group)) throw forbidden(`You cannot read the ${group} part of this record.`);
  }

  /** How the viewer reads the record, for the access log: the closest relation. */
  function asWhom(v: Viewer, employeeId: string): Relation {
    const r = relations(v, employeeId);
    for (const x of ["self", "manager", "admin", "editor", "viewer"] as const) if (r.has(x)) return x;
    return "viewer";
  }

  /** Writes a look at a record to the access log and the JSON log (KVKK md. 12). */
  function logAccess(v: Viewer, employeeId: string, what: string, parts: Group[]) {
    if (!parts.length) return;
    const as = asWhom(v, employeeId);
    s.run(
      "INSERT INTO access_log (employee_id, at, by_id, by_name, as_whom, what, parts) VALUES (?, ?, ?, ?, ?, ?, ?)",
      employeeId,
      s.iso(),
      v.actor.id,
      v.actor.name,
      as,
      what,
      parts.join(","),
    );
    log("info", "record read", { employee: employeeId, by: v.actor.id, as, what, parts });
  }

  function queueMail(to: string, subject: string, text: string) {
    if (!config?.mail) return;
    s.run("INSERT INTO mail_outbox (recipient, subject, body, created_at, next_at) VALUES (?, ?, ?, ?, ?)", to, subject, text, s.iso(), s.iso());
  }

  const lang = (): Language => cfg().language;
  const t = (key: Parameters<typeof say>[1], vars?: Parameters<typeof say>[2]) => say(lang(), key, vars);

  const displayName = (e: Pick<EmployeeRow, "first_name" | "last_name" | "preferred_name">) => `${e.preferred_name || e.first_name} ${e.last_name}`;

  /** upcoming before the start day, left after the end day, active between. */
  const statusOf = (e: Pick<EmployeeRow, "start_date" | "end_date">, day = today()): "upcoming" | "active" | "left" =>
    e.start_date > day ? "upcoming" : e.end_date && e.end_date < day ? "left" : "active";

  return {
    ...s,
    publicUrl: o.publicUrl,
    keyring: o.keyring,
    env: o.env ?? process.env,
    fileState: o.fileState ?? (() => null),
    cfg,
    config: () => config,
    configText: () => configText,
    setConfigRaw(c: Config, text: string) {
      config = c;
      configText = text;
    },
    today,
    newId: () => randomUUID(),
    sealJson,
    openJson,
    personalOf,
    bankOf,
    employee,
    requireEmployee,
    viewer,
    managers,
    isAbove,
    relations,
    canRead,
    readable,
    requireRead,
    asWhom,
    logAccess,
    queueMail,
    lang,
    t,
    displayName,
    statusOf,
  };
}

export type Core = ReturnType<typeof createCore>;
