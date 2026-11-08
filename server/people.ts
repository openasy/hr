// Employees, departments and positions, the org chart, pay, documents, the history of every change and the access
// log. The personal and pay parts of a record are sealed with the install's key; the rest is what lists and the org
// chart sort by. Editors (HR) change records; people change their own contact details; admins delete.
import { createHash } from "node:crypto";
import { atLeast } from "@openasy/auth";
import type { Checklists } from "./checklists.ts";
import type { Group } from "./config.ts";
import { addDays, addMonths, addYears, isDay } from "./dates.ts";
import type { Bank, Core, EmployeeRow, Personal, Viewer } from "./core.ts";
import { parseCsv } from "./csv.ts";
import { log } from "./log.ts";
import { bad, body, conflict, forbidden, HrError, isObj, notFound, oneOf, optDay, optEmail, optText, text, validIban, validTckn } from "./store.ts";

interface DepartmentRow {
  id: string;
  name: string;
  parent_id: string | null;
  head_id: string | null;
  identity_group: string | null;
  created_at: string;
  updated_at: string;
}
interface PositionRow {
  id: string;
  title: string;
  department_id: string | null;
  created_at: string;
}
interface PayRow {
  id: string;
  employee_id: string;
  from_date: string;
  amount_sealed: string;
  currency: string;
  period: "month" | "hour" | "year";
  created_at: string;
  created_by: string;
}
interface DocumentRow {
  id: string;
  employee_id: string;
  kind: string;
  name: string;
  content_type: string;
  size: number;
  content_sealed: string;
  expires_on: string | null;
  warned_at: string | null;
  uploaded_at: string;
  uploaded_by: string;
}
interface HistoryRow {
  id: number;
  employee_id: string;
  at: string;
  by_id: string;
  by_name: string;
  grp: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  sealed: number;
}

const EMPLOYMENT = ["full_time", "part_time", "intern", "contractor"] as const;
const CONTRACT = ["indefinite", "fixed"] as const;
const GENDER = ["female", "male", "other"] as const;
const MARITAL = ["single", "married", "divorced", "widowed"] as const;
const PERIOD = ["month", "hour", "year"] as const;

/** The fields of a record by part; directory is what everyone signed in reads. */
const FIELDS: Record<"directory" | "work" | "personal" | "bank", string[]> = {
  directory: ["firstName", "lastName", "preferredName", "workEmail", "department", "position", "manager", "location", "startDate"],
  work: ["number", "employmentType", "serviceStart", "probationEnd", "contract", "contractEnd", "endDate", "endReason"],
  personal: ["birthDate", "gender", "maritalStatus", "nationalId", "nationality", "phone", "personalEmail", "address", "emergencyContact"],
  bank: ["iban", "bankName"],
};
const ALL_FIELDS = Object.values(FIELDS).flat();
/** What people change on their own record. */
const SELF_FIELDS = ["phone", "personalEmail", "address", "emergencyContact"];
const groupOf = (field: string): "directory" | Group => {
  if (FIELDS.bank.includes(field)) return "pay";
  for (const g of ["directory", "work", "personal"] as const) if (FIELDS[g].includes(field)) return g;
  return "work";
};
const SEALED_GROUPS = new Set<string>(["personal", "pay"]);

/**
 * A national id as records and their history show it: the first three and last three characters, the rest hidden,
 * such as 104•••••846. The whole number is read on its own (nationalId below), and that read is logged.
 */
export function maskId(id: string | null): string | null {
  if (!id) return id;
  return id.length > 6 ? `${id.slice(0, 3)}${"•".repeat(id.length - 6)}${id.slice(-3)}` : "•".repeat(id.length);
}

const MAX_DOCUMENT = 10 * 1024 * 1024;
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  "application/pdf": (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
};

export function createPeople(c: Core, checklists: Checklists) {
  const isEditor = (v: Viewer) => atLeast(v.actor.role, "editor");
  const requireEditor = (v: Viewer) => {
    if (!isEditor(v)) throw forbidden("This needs the editor role: HR changes records.");
  };

  // ---------------------------------------------------------------- departments and positions

  const department = (id: string | null) => (id ? c.one<DepartmentRow>("SELECT * FROM departments WHERE id = ?", id) : undefined);
  const position = (id: string | null) => (id ? c.one<PositionRow>("SELECT * FROM positions WHERE id = ?", id) : undefined);

  function presentDepartment(d: DepartmentRow) {
    const head = d.head_id ? c.employee(d.head_id) : undefined;
    const day = c.today();
    const people = c.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM employees WHERE department_id = ? AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)",
      d.id,
      day,
      day,
    )!.n;
    return {
      id: d.id,
      name: d.name,
      parentId: d.parent_id,
      head: head ? { id: head.id, name: c.displayName(head) } : null,
      identityGroup: d.identity_group ?? d.name,
      people,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    };
  }

  function listDepartments() {
    return c.q<DepartmentRow>("SELECT * FROM departments ORDER BY name COLLATE NOCASE").map(presentDepartment);
  }

  function departmentInput(raw: unknown, current?: DepartmentRow) {
    const b = body(raw, ["name", "parent", "head", "identityGroup"]);
    const name = current && b.name === undefined ? current.name : text(b.name, "name", 100);
    const parent = b.parent === undefined ? (current?.parent_id ?? null) : b.parent === null ? null : text(b.parent, "parent", 64);
    if (parent && !department(parent)) throw bad("parent is not a department.");
    if (current && parent) {
      // A department cannot be put under itself or one of its own.
      let at: string | null = parent;
      for (let i = 0; at && i < 50; i++) {
        if (at === current.id) throw bad("parent is this department or one under it.");
        at = department(at)?.parent_id ?? null;
      }
    }
    const head = b.head === undefined ? (current?.head_id ?? null) : b.head === null ? null : text(b.head, "head", 64);
    if (head && !c.employee(head)) throw bad("head is not an employee.");
    const group = b.identityGroup === undefined ? (current?.identity_group ?? null) : (optText(b.identityGroup, "identityGroup", 100) ?? null);
    const taken = c.one<{ id: string }>("SELECT id FROM departments WHERE name = ? COLLATE NOCASE", name);
    if (taken && taken.id !== current?.id) throw conflict(`A department named ${name} exists.`);
    return { name, parent, head, group };
  }

  function createDepartment(v: Viewer, raw: unknown) {
    requireEditor(v);
    const d = departmentInput(raw);
    const id = c.newId();
    c.run(
      "INSERT INTO departments (id, name, parent_id, head_id, identity_group, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      d.name,
      d.parent,
      d.head,
      d.group,
      c.iso(),
      c.iso(),
    );
    return presentDepartment(department(id)!);
  }

  function updateDepartment(v: Viewer, id: string, raw: unknown) {
    requireEditor(v);
    const current = department(id);
    if (!current) throw notFound(`Department ${id}`);
    const d = departmentInput(raw, current);
    c.tx(() => {
      c.run(
        "UPDATE departments SET name = ?, parent_id = ?, head_id = ?, identity_group = ?, updated_at = ? WHERE id = ?",
        d.name,
        d.parent,
        d.head,
        d.group,
        c.iso(),
        id,
      );
      // The Identity group follows: its people are moved at the next round.
      if ((d.group ?? d.name) !== (current.identity_group ?? current.name)) c.run("UPDATE employees SET identity_synced = NULL WHERE department_id = ?", id);
    });
    return presentDepartment(department(id)!);
  }

  function removeDepartment(v: Viewer, id: string) {
    requireEditor(v);
    if (!department(id)) throw notFound(`Department ${id}`);
    if (c.one("SELECT 1 FROM employees WHERE department_id = ?", id)) throw conflict("People are in this department; move them first.");
    c.run("DELETE FROM departments WHERE id = ?", id);
  }

  const presentPosition = (p: PositionRow) => ({ id: p.id, title: p.title, departmentId: p.department_id, createdAt: p.created_at });
  const listPositions = () => c.q<PositionRow>("SELECT * FROM positions ORDER BY title COLLATE NOCASE").map(presentPosition);

  function positionInput(raw: unknown, current?: PositionRow) {
    const b = body(raw, ["title", "department"]);
    const title = current && b.title === undefined ? current.title : text(b.title, "title", 100);
    const dep = b.department === undefined ? (current?.department_id ?? null) : b.department === null ? null : text(b.department, "department", 64);
    if (dep && !department(dep)) throw bad("department is not a department.");
    const taken = c.one<{ id: string }>("SELECT id FROM positions WHERE title = ? AND department_id IS ?", title, dep);
    if (taken && taken.id !== current?.id) throw conflict(`${title} exists in this department.`);
    return { title, dep };
  }

  function createPosition(v: Viewer, raw: unknown) {
    requireEditor(v);
    const p = positionInput(raw);
    const id = c.newId();
    c.run("INSERT INTO positions (id, title, department_id, created_at) VALUES (?, ?, ?, ?)", id, p.title, p.dep, c.iso());
    return presentPosition(position(id)!);
  }

  function updatePosition(v: Viewer, id: string, raw: unknown) {
    requireEditor(v);
    const current = position(id);
    if (!current) throw notFound(`Position ${id}`);
    const p = positionInput(raw, current);
    c.run("UPDATE positions SET title = ?, department_id = ? WHERE id = ?", p.title, p.dep, id);
    return presentPosition(position(id)!);
  }

  function removePosition(v: Viewer, id: string) {
    requireEditor(v);
    if (!position(id)) throw notFound(`Position ${id}`);
    if (c.one("SELECT 1 FROM employees WHERE position_id = ?", id)) throw conflict("People hold this position; change theirs first.");
    c.run("DELETE FROM positions WHERE id = ?", id);
  }

  // ---------------------------------------------------------------- employees

  function currentPay(e: EmployeeRow, day = c.today()) {
    const p = c.one<PayRow>("SELECT * FROM pay WHERE employee_id = ? AND from_date <= ? ORDER BY from_date DESC, created_at DESC LIMIT 1", e.id, day);
    return p ? presentPay(p) : null;
  }
  function presentPay(p: PayRow) {
    const minor = Number(c.keyring.open(p.amount_sealed, `pay:${p.employee_id}:${p.id}`).toString("utf8"));
    return { id: p.id, from: p.from_date, amount: minor / 100, currency: p.currency, period: p.period, createdAt: p.created_at, createdBy: p.created_by };
  }

  const masked = (p: Personal): Personal => ({ ...p, nationalId: maskId(p.nationalId) });

  function present(v: Viewer, e: EmployeeRow, line: Map<string, string | null>, detail: boolean) {
    const parts = c.readable(v, e.id, line);
    const dep = department(e.department_id);
    const pos = position(e.position_id);
    const mgr = e.manager_id ? c.employee(e.manager_id) : undefined;
    const loc = e.location ? c.cfg().locations.find((l) => l.id === e.location) : undefined;
    const self = v.employeeId === e.id;
    const reports = c.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM employees WHERE manager_id = ? AND (end_date IS NULL OR end_date >= ?)",
      e.id,
      c.today(),
    )!.n;
    return {
      id: e.id,
      name: c.displayName(e),
      firstName: e.first_name,
      lastName: e.last_name,
      preferredName: e.preferred_name,
      workEmail: e.work_email,
      status: c.statusOf(e),
      startDate: e.start_date,
      department: dep ? { id: dep.id, name: dep.name } : null,
      position: pos ? { id: pos.id, title: pos.title } : null,
      manager: mgr ? { id: mgr.id, name: c.displayName(mgr) } : null,
      location: e.location ? { id: e.location, name: loc?.name ?? e.location } : null,
      reports,
      parts,
      ...(parts.includes("work") && {
        work: {
          number: e.number,
          employmentType: e.employment_type,
          serviceStart: e.service_start ?? e.start_date,
          probationEnd: e.probation_end,
          contract: e.contract,
          contractEnd: e.contract_end,
          endDate: e.end_date,
          endReason: e.end_reason,
        },
      }),
      ...(detail && parts.includes("personal") && { personal: masked(c.personalOf(e)) }),
      ...(detail && parts.includes("pay") && { pay: { ...c.bankOf(e), current: currentPay(e) } }),
      ...(isEditor(v) && {
        identity: {
          linked: !!c.cfg().identity,
          accountId: e.identity_id,
          state: e.identity_state,
          error: e.identity_error,
          at: e.identity_at,
        },
      }),
      can: { edit: isEditor(v), editContact: isEditor(v) || self, delete: atLeast(v.actor.role, "admin") },
      createdAt: e.created_at,
      updatedAt: e.updated_at,
    };
  }

  function listEmployees(v: Viewer, q: URLSearchParams) {
    const status = q.get("status") ?? "current";
    if (!["current", "active", "upcoming", "left", "all"].includes(status)) throw bad("status is current, active, upcoming, left or all.");
    if ((status === "left" || status === "all") && !atLeast(v.actor.role, "viewer")) throw forbidden("People who left are listed for HR only.");
    const day = c.today();
    const line = c.managers();
    let rows = c.q<EmployeeRow>("SELECT * FROM employees ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE");
    rows = rows.filter((e) => {
      const s = c.statusOf(e, day);
      return status === "all" || (status === "current" ? s !== "left" : s === status);
    });
    const dep = q.get("department");
    if (dep) rows = rows.filter((e) => e.department_id === dep);
    const mgr = q.get("manager");
    if (mgr) rows = rows.filter((e) => e.manager_id === mgr);
    const text = q.get("q")?.trim().toLocaleLowerCase("tr");
    if (text)
      rows = rows.filter((e) => `${e.first_name} ${e.last_name} ${e.preferred_name ?? ""} ${e.work_email ?? ""}`.toLocaleLowerCase("tr").includes(text));
    return rows.map((e) => present(v, e, line, false));
  }

  function getEmployee(v: Viewer, id: string) {
    const e = c.requireEmployee(id);
    const line = c.managers();
    const out = present(v, e, line, true);
    c.logAccess(
      v,
      e.id,
      "record",
      out.parts.filter((p) => p === "work" || p === "personal" || p === "pay"),
    );
    return out;
  }

  /** The whole national id, for those who read the personal part. Each read is written to the access log. */
  function nationalId(v: Viewer, id: string) {
    const e = c.requireEmployee(id);
    c.requireRead(v, e.id, "personal");
    c.logAccess(v, e.id, "national-id", ["personal"]);
    return { nationalId: c.personalOf(e).nationalId };
  }

  type Input = { cols: Partial<Record<keyof EmployeeRow, string | null>>; personal: Partial<Personal>; bank: Partial<Bank> };

  /** Reads the fields a body sets. `current` is the record being changed, or undefined for a new one. */
  function readInput(raw: unknown, current?: EmployeeRow): Input {
    const b = body(raw, ALL_FIELDS);
    const cols: Input["cols"] = {};
    const personal: Partial<Personal> = {};
    const bank: Partial<Bank> = {};
    if (!current || b.firstName !== undefined) cols.first_name = text(b.firstName, "firstName", 100);
    if (!current || b.lastName !== undefined) cols.last_name = text(b.lastName, "lastName", 100);
    if (b.preferredName !== undefined) cols.preferred_name = optText(b.preferredName, "preferredName", 100) ?? null;
    if (b.workEmail !== undefined) cols.work_email = optEmail(b.workEmail, "workEmail") ?? null;
    if (b.number !== undefined) cols.number = optText(b.number, "number", 40) ?? null;
    const ref = (v: unknown, field: string) => (v === null || v === "" ? null : text(v, field, 64));
    if (b.department !== undefined) {
      cols.department_id = ref(b.department, "department");
      if (cols.department_id && !department(cols.department_id)) throw bad("department is not a department.");
    }
    if (b.position !== undefined) {
      cols.position_id = ref(b.position, "position");
      if (cols.position_id && !position(cols.position_id)) throw bad("position is not a position.");
    }
    if (b.manager !== undefined) {
      cols.manager_id = ref(b.manager, "manager");
      if (cols.manager_id) {
        if (!c.employee(cols.manager_id)) throw bad("manager is not an employee.");
        if (current && (cols.manager_id === current.id || c.isAbove(current.id, cols.manager_id)))
          throw bad("manager is this person or someone who reports to them.");
      }
    }
    if (b.location !== undefined) {
      cols.location = ref(b.location, "location");
      const known = c.cfg().locations;
      if (cols.location && !known.some((l) => l.id === cols.location))
        throw bad(known.length ? `location is one of ${known.map((l) => l.id).join(", ")}.` : "location: the settings file has no locations.");
    }
    if (!current || b.startDate !== undefined) cols.start_date = optDay(b.startDate, "startDate") ?? null;
    if (!current && !cols.start_date) throw bad("startDate is a day, YYYY-MM-DD.");
    if (b.employmentType !== undefined) cols.employment_type = oneOf(b.employmentType, "employmentType", EMPLOYMENT)!;
    if (b.contract !== undefined) cols.contract = oneOf(b.contract, "contract", CONTRACT)!;
    for (const [k, col] of [
      ["serviceStart", "service_start"],
      ["probationEnd", "probation_end"],
      ["contractEnd", "contract_end"],
      ["endDate", "end_date"],
    ] as const)
      if (b[k] !== undefined) cols[col] = optDay(b[k], k) ?? null;
    if (b.endReason !== undefined) cols.end_reason = optText(b.endReason, "endReason", 200) ?? null;

    if (b.birthDate !== undefined) personal.birthDate = optDay(b.birthDate, "birthDate") ?? null;
    if (b.gender !== undefined) personal.gender = b.gender === null ? null : oneOf(b.gender, "gender", GENDER)!;
    if (b.maritalStatus !== undefined) personal.maritalStatus = b.maritalStatus === null ? null : oneOf(b.maritalStatus, "maritalStatus", MARITAL)!;
    if (b.nationalId !== undefined) {
      const id = optText(b.nationalId, "nationalId", 20) ?? null;
      if (id && /^\d{11}$/.test(id) && !validTckn(id)) throw bad("nationalId: this T.C. kimlik number does not pass its check digits.");
      if (id && !/^[A-Za-z0-9]{5,20}$/.test(id)) throw bad("nationalId is 5 to 20 letters and digits, such as a T.C. kimlik number.");
      personal.nationalId = id;
    }
    if (b.nationality !== undefined) {
      const n = optText(b.nationality, "nationality", 2) ?? null;
      if (n && !/^[A-Za-z]{2}$/.test(n)) throw bad("nationality is a two-letter country code, such as TR.");
      personal.nationality = n?.toUpperCase() ?? null;
    }
    if (b.phone !== undefined) personal.phone = optText(b.phone, "phone", 40) ?? null;
    if (b.personalEmail !== undefined) personal.personalEmail = optEmail(b.personalEmail, "personalEmail") ?? null;
    if (b.address !== undefined) personal.address = optText(b.address, "address", 400) ?? null;
    if (b.emergencyContact !== undefined) {
      if (b.emergencyContact === null) personal.emergencyContact = null;
      else {
        const ec = body(b.emergencyContact, ["name", "relation", "phone"]);
        personal.emergencyContact = {
          name: text(ec.name, "emergencyContact.name", 100),
          relation: optText(ec.relation, "emergencyContact.relation", 60) ?? null,
          phone: text(ec.phone, "emergencyContact.phone", 40),
        };
      }
    }
    if (b.iban !== undefined) {
      const s = optText(b.iban, "iban", 40) ?? null;
      const iban = s ? validIban(s) : null;
      if (s && !iban) throw bad("iban is not a valid IBAN; a Turkish one is TR and 24 digits.");
      bank.iban = iban;
    }
    if (b.bankName !== undefined) bank.bankName = optText(b.bankName, "bankName", 100) ?? null;
    return { cols, personal, bank };
  }

  function checkRecord(next: EmployeeRow, personal: Personal) {
    if (next.end_date && next.end_date < next.start_date) throw bad("endDate is on or after startDate.");
    if (next.service_start && next.service_start > next.start_date) throw bad("serviceStart is on or before startDate: it is when service with you began.");
    if (next.contract === "fixed" && !next.contract_end) throw bad("contractEnd is needed for a fixed-term contract (belirli süreli).");
    if (next.contract_end && next.contract_end < next.start_date) throw bad("contractEnd is on or after startDate.");
    if (next.work_email) {
      const t = c.one<{ id: string }>("SELECT id FROM employees WHERE work_email = ?", next.work_email);
      if (t && t.id !== next.id) throw conflict(`${next.work_email} is someone else's work email.`);
    }
    if (next.number) {
      const t = c.one<{ id: string }>("SELECT id FROM employees WHERE number = ?", next.number);
      if (t && t.id !== next.id) throw conflict(`Employee number ${next.number} is someone else's.`);
    }
    if (personal.nationalId) {
      const t = c.one<{ id: string }>("SELECT id FROM employees WHERE national_id_index = ?", c.keyring.index(personal.nationalId));
      if (t && t.id !== next.id) throw conflict("This national id is someone else's.");
    }
  }

  /** A field as the history keeps it: names rather than ids, JSON for the emergency contact. */
  function shown(field: string, e: EmployeeRow, personal: Personal, bank: Bank): string | null {
    switch (field) {
      case "department":
        return department(e.department_id)?.name ?? null;
      case "position":
        return position(e.position_id)?.title ?? null;
      case "manager": {
        const m = e.manager_id ? c.employee(e.manager_id) : undefined;
        return m ? c.displayName(m) : null;
      }
      case "emergencyContact":
        return personal.emergencyContact ? JSON.stringify(personal.emergencyContact) : null;
    }
    if (field in personal) return (personal[field as keyof Personal] as string | null) ?? null;
    if (field in bank) return bank[field as keyof Bank] ?? null;
    const col = field.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`) as keyof EmployeeRow;
    const v = e[col];
    return v === null || v === undefined ? null : String(v);
  }

  function writeHistory(v: Viewer, before: { e: EmployeeRow; p: Personal; b: Bank } | null, after: { e: EmployeeRow; p: Personal; b: Bank }) {
    for (const field of ALL_FIELDS) {
      const old = before ? shown(field, before.e, before.p, before.b) : null;
      const now = shown(field, after.e, after.p, after.b);
      if (old === now) continue;
      const grp = groupOf(field);
      const sealed = SEALED_GROUPS.has(grp);
      const seal = (x: string | null) => (x === null ? null : sealed ? c.keyring.seal(x, `history:${after.e.id}`) : x);
      c.run(
        "INSERT INTO history (employee_id, at, by_id, by_name, grp, field, old_value, new_value, sealed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        after.e.id,
        c.iso(),
        v.actor.id,
        v.actor.name,
        grp,
        field,
        seal(old),
        seal(now),
        sealed ? 1 : 0,
      );
    }
  }

  function save(e: EmployeeRow, personal: Personal, bank: Bank) {
    const cols = Object.keys(e) as Array<keyof EmployeeRow>;
    const sealedPersonal = Object.values(personal).some((x) => x !== null) ? c.sealJson(personal, `personal:${e.id}`) : null;
    const sealedBank = bank.iban || bank.bankName ? c.sealJson(bank, `bank:${e.id}`) : null;
    const row = {
      ...e,
      personal_sealed: sealedPersonal,
      bank_sealed: sealedBank,
      national_id_index: personal.nationalId ? c.keyring.index(personal.nationalId) : null,
    };
    c.run(
      `INSERT INTO employees (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
       ON CONFLICT (id) DO UPDATE SET ${cols
         .filter((k) => k !== "id")
         .map((k) => `${k} = excluded.${k}`)
         .join(", ")}`,
      ...cols.map((k) => row[k] as string | number | null),
    );
  }

  /** The hash of what Identity is told: when it changes, the next round tells Identity again. */
  const identityFields = (e: EmployeeRow) => [e.first_name, e.last_name, e.preferred_name, e.work_email, e.department_id].join("|");

  function createEmployee(v: Viewer, raw: unknown, quiet = false) {
    requireEditor(v);
    const input = readInput(raw);
    const now = c.iso();
    const id = c.newId();
    const e: EmployeeRow = {
      id,
      number: null,
      first_name: "",
      last_name: "",
      preferred_name: null,
      work_email: null,
      department_id: null,
      position_id: null,
      manager_id: null,
      location: null,
      employment_type: "full_time",
      start_date: "",
      service_start: null,
      probation_end: null,
      contract: "indefinite",
      contract_end: null,
      end_date: null,
      end_reason: null,
      balances_from: c.today(),
      personal_sealed: null,
      bank_sealed: null,
      national_id_index: null,
      identity_id: null,
      identity_state: null,
      identity_synced: null,
      identity_error: null,
      identity_attempts: 0,
      identity_next_at: null,
      identity_at: null,
      created_at: now,
      updated_at: now,
      ...(input.cols as Partial<EmployeeRow>),
    };
    // Probation is two months unless set otherwise (İş Kanunu md. 15).
    if ((raw as Record<string, unknown>).probationEnd === undefined) e.probation_end = addDays(addMonths(e.start_date, 2), -1);
    const personal: Personal = { ...c.personalOf(e), ...input.personal };
    const bank: Bank = { iban: null, bankName: null, ...input.bank };
    checkRecord(e, personal);
    c.tx(() => {
      save(e, personal, bank);
      writeHistory(v, null, { e, p: personal, b: bank });
      checklists.follow(e);
    });
    log("info", "employee added", { employee: id, by: v.actor.id });
    return present(v, c.employee(id)!, c.managers(), !quiet);
  }

  function updateEmployee(v: Viewer, id: string, raw: unknown, quiet = false) {
    const current = c.requireEmployee(id);
    const self = v.employeeId === id;
    if (!isEditor(v)) {
      if (!self) throw forbidden("Only HR changes this record.");
      const asked = Object.keys(isObj(raw) ? raw : {});
      const other = asked.filter((k) => !SELF_FIELDS.includes(k));
      if (other.length) throw forbidden(`You change ${SELF_FIELDS.join(", ")} on your own record; HR changes ${other.join(", ")}.`);
    }
    const input = readInput(raw, current);
    const before = { e: current, p: c.personalOf(current), b: c.bankOf(current) };
    const e: EmployeeRow = { ...current, ...(input.cols as Partial<EmployeeRow>), updated_at: c.iso() };
    const personal: Personal = { ...before.p, ...input.personal };
    const bank: Bank = { ...before.b, ...input.bank };
    checkRecord(e, personal);
    c.tx(() => {
      if (identityFields(e) !== identityFields(current)) e.identity_synced = null;
      // Coming back after the account was turned off, or an end day moved: Identity is told at the next round.
      if (e.end_date !== current.end_date || e.start_date !== current.start_date) ((e.identity_attempts = 0), (e.identity_next_at = null));
      save(e, personal, bank);
      writeHistory(v, before, { e, p: personal, b: bank });
      checklists.follow(e);
    });
    return present(v, c.employee(id)!, c.managers(), !quiet);
  }

  function removeEmployee(v: Viewer, id: string) {
    if (!atLeast(v.actor.role, "admin")) throw forbidden("Deleting a record needs the admin role.");
    const e = c.requireEmployee(id);
    if (e.identity_state === "active") throw conflict("Their Identity account is on. Set an end day so Identity turns it off, then delete the record.");
    purge(e, "deleted by an admin", v.actor.name);
  }

  function purge(e: EmployeeRow, reason: string, by: string) {
    c.tx(() => {
      c.run("UPDATE employees SET manager_id = NULL WHERE manager_id = ?", e.id);
      c.run("UPDATE departments SET head_id = NULL WHERE head_id = ?", e.id);
      c.run("DELETE FROM access_log WHERE employee_id = ?", e.id);
      c.run("DELETE FROM employees WHERE id = ?", e.id);
      c.run("INSERT INTO purges (number, at, reason, by_name) VALUES (?, ?, ?, ?)", e.number, c.iso(), reason, by);
    });
    log("info", "employee record deleted", { employee: e.id, reason });
  }

  /** Records of people who left longer ago than retention.after_leaving are deleted, with everything about them. */
  function purgeExpired() {
    const cutoff = addDays(c.today(), -c.cfg().retention.afterLeavingDays);
    for (const e of c.q<EmployeeRow>("SELECT * FROM employees WHERE end_date IS NOT NULL AND end_date < ?", cutoff))
      if (e.identity_state !== "active") purge(e, "retention ended", "HR");
    c.run("DELETE FROM access_log WHERE at < ?", c.iso(c.clock() - c.cfg().retention.accessLogDays * 86_400_000));
  }

  function history(v: Viewer, id: string) {
    const e = c.requireEmployee(id);
    const parts = new Set<string>(["directory", ...c.readable(v, e.id)]);
    if (!parts.has("work") && !isEditor(v)) throw forbidden("You cannot read this record's history.");
    const rows = c.q<HistoryRow>("SELECT * FROM history WHERE employee_id = ? ORDER BY at DESC, id DESC LIMIT 500", e.id).filter((h) => parts.has(h.grp));
    c.logAccess(
      v,
      e.id,
      "history",
      [...parts].filter((p): p is Group => p !== "directory"),
    );
    const open = (x: string | null, sealed: number) => (x === null ? null : sealed ? c.keyring.open(x, `history:${e.id}`).toString("utf8") : x);
    // The national id is masked here as on the record; its whole value is read on its own, logged.
    const shownAs = (h: HistoryRow, x: string | null) => (h.field === "nationalId" ? maskId(open(x, h.sealed)) : open(x, h.sealed));
    return rows.map((h) => ({ at: h.at, by: h.by_name, part: h.grp, field: h.field, from: shownAs(h, h.old_value), to: shownAs(h, h.new_value) }));
  }

  /** Who looked at a record: for the person themselves (KVKK md. 11) and admins. */
  function accessLog(v: Viewer, id: string) {
    const e = c.requireEmployee(id);
    if (v.employeeId !== e.id && !atLeast(v.actor.role, "admin")) throw forbidden("The access log of a record is for the person and admins.");
    return c
      .q<{ at: string; by_name: string; as_whom: string; what: string; parts: string }>(
        "SELECT at, by_name, as_whom, what, parts FROM access_log WHERE employee_id = ? ORDER BY at DESC, id DESC LIMIT 1000",
        e.id,
      )
      .map((r) => ({ at: r.at, by: r.by_name, as: r.as_whom, what: r.what, parts: r.parts.split(",") }));
  }

  // ---------------------------------------------------------------- pay

  function listPay(v: Viewer, id: string) {
    const e = c.requireEmployee(id);
    c.requireRead(v, e.id, "pay");
    c.logAccess(v, e.id, "pay", ["pay"]);
    return c.q<PayRow>("SELECT * FROM pay WHERE employee_id = ? ORDER BY from_date DESC, created_at DESC", e.id).map(presentPay);
  }

  function addPay(v: Viewer, id: string, raw: unknown) {
    requireEditor(v);
    const e = c.requireEmployee(id);
    const b = body(raw, ["from", "amount", "currency", "period"]);
    const from = optDay(b.from, "from");
    if (!from) throw bad("from is the day the pay starts, YYYY-MM-DD.");
    const n = typeof b.amount === "string" ? Number(b.amount) : b.amount;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 1e10 || Math.abs(Math.round(n * 100) - n * 100) > 1e-6)
      throw bad("amount is more than 0, with at most two decimals.");
    const currency = String(b.currency ?? "TRY").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw bad("currency is a three-letter code, such as TRY.");
    const period = oneOf(b.period ?? "month", "period", PERIOD)!;
    const payId = c.newId();
    c.tx(() => {
      c.run(
        "INSERT INTO pay (id, employee_id, from_date, amount_sealed, currency, period, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        payId,
        e.id,
        from,
        c.keyring.seal(String(Math.round(n * 100)), `pay:${e.id}:${payId}`),
        currency,
        period,
        c.iso(),
        v.actor.name,
      );
      c.run(
        "INSERT INTO history (employee_id, at, by_id, by_name, grp, field, old_value, new_value, sealed) VALUES (?, ?, ?, ?, 'pay', 'salary', NULL, ?, 1)",
        e.id,
        c.iso(),
        v.actor.id,
        v.actor.name,
        c.keyring.seal(`${n} ${currency} per ${period} from ${from}`, `history:${e.id}`),
      );
    });
    return presentPay(c.one<PayRow>("SELECT * FROM pay WHERE id = ?", payId)!);
  }

  // ---------------------------------------------------------------- documents

  function presentDocument(d: DocumentRow) {
    const kind = c.cfg().documents.find((k) => k.id === d.kind);
    const day = c.today();
    return {
      id: d.id,
      employeeId: d.employee_id,
      kind: d.kind,
      kindName: kind?.name ?? { en: d.kind, de: d.kind, tr: d.kind },
      name: d.name,
      contentType: d.content_type,
      size: d.size,
      expiresOn: d.expires_on,
      expired: !!d.expires_on && d.expires_on < day,
      expiresSoon: !!d.expires_on && d.expires_on >= day && d.expires_on <= addDays(day, kind?.warnDays ?? 30),
      uploadedAt: d.uploaded_at,
      uploadedBy: d.uploaded_by,
    };
  }

  function listDocuments(v: Viewer, id: string) {
    const e = c.requireEmployee(id);
    c.requireRead(v, e.id, "documents");
    c.logAccess(v, e.id, "documents", ["documents"]);
    return c.q<DocumentRow>("SELECT * FROM documents WHERE employee_id = ? ORDER BY uploaded_at DESC", e.id).map(presentDocument);
  }

  function addDocument(v: Viewer, id: string, raw: unknown) {
    const e = c.requireEmployee(id);
    if (!isEditor(v) && v.employeeId !== e.id) throw forbidden("HR adds documents to a record; people add their own.");
    const b = body(raw, ["kind", "name", "contentType", "content", "expiresOn"]);
    const kinds = c.cfg().documents;
    const kind = kinds.find((k) => k.id === b.kind);
    if (!kind) throw bad(`kind is one of ${kinds.map((k) => k.id).join(", ")}.`);
    const name = text(b.name, "name", 200);
    const type = oneOf(b.contentType, "contentType", Object.keys(MAGIC));
    if (!type) throw bad(`contentType is ${Object.keys(MAGIC).join(", ")}.`);
    if (typeof b.content !== "string" || !b.content) throw bad("content is the file in base64.");
    const content = Buffer.from(b.content, "base64");
    if (!content.length || content.length > MAX_DOCUMENT) throw bad("content is a file of up to 10 MiB.");
    if (!MAGIC[type]!(content)) throw bad(`content is not a ${type} file.`);
    const expires = optDay(b.expiresOn, "expiresOn") ?? null;
    if (kind.expires && !expires) throw bad(`expiresOn is needed for ${kind.name.en}: it expires.`);
    const docId = c.newId();
    c.run(
      "INSERT INTO documents (id, employee_id, kind, name, content_type, size, content_sealed, expires_on, uploaded_at, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      docId,
      e.id,
      kind.id,
      name,
      type,
      content.length,
      c.keyring.seal(content, `document:${e.id}:${docId}`),
      expires,
      c.iso(),
      v.actor.name,
    );
    c.run(
      "INSERT INTO history (employee_id, at, by_id, by_name, grp, field, old_value, new_value, sealed) VALUES (?, ?, ?, ?, 'documents', 'document', NULL, ?, 0)",
      e.id,
      c.iso(),
      v.actor.id,
      v.actor.name,
      `${kind.name.en}: ${name}`,
    );
    return presentDocument(c.one<DocumentRow>("SELECT * FROM documents WHERE id = ?", docId)!);
  }

  const documentRow = (id: string) => {
    const d = c.one<DocumentRow>("SELECT * FROM documents WHERE id = ?", id);
    if (!d) throw notFound(`Document ${id}`);
    return d;
  };

  function documentFile(v: Viewer, id: string) {
    const d = documentRow(id);
    c.requireRead(v, d.employee_id, "documents");
    c.logAccess(v, d.employee_id, `document:${d.id}`, ["documents"]);
    const ext = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" }[d.content_type] ?? "bin";
    const safe = d.name.replace(/[^\p{L}\p{N} ._-]/gu, "_").replace(/\.(pdf|png|jpe?g)$/i, "");
    return { content: c.keyring.open(d.content_sealed, `document:${d.employee_id}:${d.id}`), type: d.content_type, filename: `${safe}.${ext}` };
  }

  function removeDocument(v: Viewer, id: string) {
    requireEditor(v);
    const d = documentRow(id);
    c.run("DELETE FROM documents WHERE id = ?", id);
    c.run(
      "INSERT INTO history (employee_id, at, by_id, by_name, grp, field, old_value, new_value, sealed) VALUES (?, ?, ?, ?, 'documents', 'document', ?, NULL, 0)",
      d.employee_id,
      c.iso(),
      v.actor.id,
      v.actor.name,
      d.name,
    );
  }

  /**
   * Documents that have expired or expire within their kind's warn_before, of the people the viewer reads; with `all`,
   * every document that has an expiry day.
   */
  function expiring(v: Viewer, all = false) {
    const day = c.today();
    const line = c.managers();
    return c
      .q<DocumentRow>("SELECT * FROM documents WHERE expires_on IS NOT NULL ORDER BY expires_on")
      .filter((d) => {
        const kind = c.cfg().documents.find((k) => k.id === d.kind);
        return (all || d.expires_on! <= addDays(day, kind?.warnDays ?? 30)) && c.canRead(v, d.employee_id, "documents", line);
      })
      .map((d) => {
        const e = c.employee(d.employee_id)!;
        return { ...presentDocument(d), employee: { id: e.id, name: c.displayName(e) } };
      });
  }

  /** HR is emailed once about each document that comes within its kind's warn_before. */
  function warnExpiring() {
    const day = c.today();
    for (const d of c.q<DocumentRow>("SELECT * FROM documents WHERE expires_on IS NOT NULL AND warned_at IS NULL")) {
      const kind = c.cfg().documents.find((k) => k.id === d.kind);
      if (d.expires_on! > addDays(day, kind?.warnDays ?? 30)) continue;
      const e = c.employee(d.employee_id);
      if (!e || c.statusOf(e, day) === "left") {
        c.run("UPDATE documents SET warned_at = ? WHERE id = ?", c.iso(), d.id);
        continue;
      }
      const vars = {
        document: kind?.name[c.lang()] ?? d.kind,
        name: c.displayName(e),
        date: d.expires_on!,
        url: `${c.publicUrl}/people/${e.id}`,
      };
      for (const to of c.cfg().notify.hr) c.queueMail(to, c.t("expiringSubject", vars), c.t("expiringText", vars));
      c.run("UPDATE documents SET warned_at = ? WHERE id = ?", c.iso(), d.id);
    }
  }

  // ---------------------------------------------------------------- the org chart and what is coming

  interface Node {
    id: string;
    name: string;
    position: string | null;
    department: string | null;
    reports: Node[];
  }

  function orgChart() {
    const day = c.today();
    const rows = c
      .q<EmployeeRow>("SELECT * FROM employees ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE")
      .filter((e) => c.statusOf(e, day) === "active");
    const nodes = new Map<string, Node>(
      rows.map((e) => [
        e.id,
        {
          id: e.id,
          name: c.displayName(e),
          position: position(e.position_id)?.title ?? null,
          department: department(e.department_id)?.name ?? null,
          reports: [],
        },
      ]),
    );
    const roots: Node[] = [];
    for (const e of rows) {
      const parent = e.manager_id ? nodes.get(e.manager_id) : undefined;
      (parent ? parent.reports : roots).push(nodes.get(e.id)!);
    }
    return { roots, people: rows.length };
  }

  function upcoming(v: Viewer, q: URLSearchParams) {
    const n = Number(q.get("days") ?? 30);
    if (!Number.isInteger(n) || n < 1 || n > 365) throw bad("days is a whole number from 1 to 365.");
    const day = c.today();
    const until = addDays(day, n);
    const line = c.managers();
    const out: Array<{ date: string; kind: string; employee: { id: string; name: string }; detail: string | null }> = [];
    const within = (d: string | null) => !!d && d >= day && d <= until;
    for (const e of c.q<EmployeeRow>("SELECT * FROM employees")) {
      const who = { id: e.id, name: c.displayName(e) };
      const work = c.canRead(v, e.id, "work", line);
      if (within(e.start_date)) out.push({ date: e.start_date, kind: "start", employee: who, detail: null });
      if (!work || c.statusOf(e, day) === "left") continue;
      if (within(e.end_date)) out.push({ date: e.end_date!, kind: "end", employee: who, detail: e.end_reason });
      if (within(e.probation_end)) out.push({ date: e.probation_end!, kind: "probation-end", employee: who, detail: null });
      if (within(e.contract_end)) out.push({ date: e.contract_end!, kind: "contract-end", employee: who, detail: null });
      const service = e.service_start ?? e.start_date;
      for (let y = 1; y <= 60; y++) {
        const a = addYears(service, y);
        if (a > until) break;
        if (within(a) && (!e.end_date || a <= e.end_date)) out.push({ date: a, kind: "anniversary", employee: who, detail: String(y) });
      }
    }
    for (const d of c.q<DocumentRow>("SELECT * FROM documents WHERE expires_on IS NOT NULL AND expires_on >= ? AND expires_on <= ?", day, until)) {
      if (!c.canRead(v, d.employee_id, "documents", line)) continue;
      const e = c.employee(d.employee_id)!;
      out.push({ date: d.expires_on!, kind: "document-expires", employee: { id: e.id, name: c.displayName(e) }, detail: d.name });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  }

  // ---------------------------------------------------------------- CSV import

  const ALIASES: Record<string, string[]> = {
    number: ["number", "employee_number", "sicil_no", "sicil", "personalnummer"],
    firstName: ["first_name", "firstname", "ad", "adı", "vorname", "given_name"],
    lastName: ["last_name", "lastname", "soyad", "soyadı", "nachname", "family_name"],
    workEmail: ["work_email", "email", "e-posta", "eposta", "e-mail"],
    department: ["department", "departman", "bölüm", "abteilung"],
    position: ["position", "title", "pozisyon", "unvan", "görev", "stelle"],
    manager: ["manager_email", "manager", "yönetici", "yönetici_e-posta", "vorgesetzter"],
    location: ["location", "lokasyon", "şube", "standort"],
    startDate: ["start_date", "işe_giriş", "işe_giriş_tarihi", "eintritt"],
    serviceStart: ["service_start", "kıdem_başlangıcı", "kıdem_tarihi"],
    endDate: ["end_date", "çıkış", "çıkış_tarihi", "austritt"],
    employmentType: ["employment_type", "çalışma_şekli"],
    contract: ["contract", "sözleşme"],
    contractEnd: ["contract_end", "sözleşme_bitişi"],
    birthDate: ["birth_date", "doğum_tarihi", "geburtsdatum"],
    nationalId: ["national_id", "tckn", "tc_kimlik_no", "tc_no"],
    phone: ["phone", "telefon", "mobile"],
    personalEmail: ["personal_email", "kişisel_e-posta"],
    address: ["address", "adres", "adresse"],
    iban: ["iban"],
    salary: ["salary", "maaş", "brüt_maaş", "gehalt"],
    currency: ["currency", "para_birimi"],
    annualLeave: ["annual_leave", "annual_leave_balance", "yıllık_izin", "yıllık_izin_bakiyesi", "resturlaub"],
  };

  function parseDayLoose(s: string): string | null {
    if (isDay(s)) return s;
    const m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
    if (!m) return null;
    const d = `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
    return isDay(d) ? d : null;
  }

  function importCsv(v: Viewer, raw: unknown) {
    requireEditor(v);
    const b = body(raw, ["csv", "dryRun"]);
    if (typeof b.csv !== "string" || !b.csv.trim()) throw bad("csv is the file's text, with a header line.");
    if (b.dryRun !== undefined && typeof b.dryRun !== "boolean") throw bad("dryRun is true or false.");
    const rows = parseCsv(b.csv);
    if (rows.length < 2) throw bad("csv has a header line and at least one row.");
    if (rows.length > 5001) throw bad("csv holds at most 5000 rows; split it.");
    const header = rows[0]!.map((h) => h.trim().toLocaleLowerCase("tr").replace(/\s+/g, "_"));
    const cols = new Map<string, number>();
    header.forEach((h, i) => {
      for (const [key, names] of Object.entries(ALIASES)) if (names.includes(h) && !cols.has(key)) cols.set(key, i);
    });
    for (const need of ["firstName", "lastName", "startDate"]) if (!cols.has(need)) throw bad(`The header has no ${need} column.`);
    const result = {
      rows: rows.length - 1,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [] as Array<{ row: number; message: string }>,
      results: [] as Array<{
        row: number;
        name: string;
        workEmail: string | null;
        result: "created" | "updated" | "skipped";
        employee: string | null;
        message: string | null;
      }>,
      ignoredColumns: header.filter((_h, i) => ![...cols.values()].includes(i)),
      dryRun: b.dryRun === true,
    };
    const annual = c.cfg().leaveTypes.find((t) => t.accrual !== "none");
    const DRY = Symbol("dry run");
    const managersLater: Array<{ id: string; email: string; row: number }> = [];
    try {
      c.tx(() => {
        rows.slice(1).forEach((r, i) => {
          const row = i + 2;
          const get = (k: string) => {
            const at = cols.get(k);
            return at === undefined ? "" : (r[at] ?? "").trim();
          };
          const rowName = [get("firstName"), get("lastName")].filter(Boolean).join(" ");
          const rowEmail = get("workEmail").toLowerCase() || null;
          c.db.exec("SAVEPOINT import_row");
          try {
            const input: Record<string, unknown> = {};
            for (const k of ["number", "firstName", "lastName", "workEmail", "phone", "personalEmail", "address", "nationalId", "iban"])
              if (get(k)) input[k] = get(k);
            for (const k of ["startDate", "serviceStart", "endDate", "contractEnd", "birthDate"])
              if (get(k)) {
                const d = parseDayLoose(get(k));
                if (!d) throw bad(`${k}: ${get(k)} is not a day such as 2026-12-01 or 01.12.2026.`);
                input[k] = d;
              }
            if (get("employmentType")) input.employmentType = get("employmentType");
            if (get("contract")) input.contract = get("contract");
            if (get("location")) input.location = get("location");
            if (get("department")) {
              const name = get("department");
              let dep = c.one<{ id: string }>("SELECT id FROM departments WHERE name = ? COLLATE NOCASE", name);
              if (!dep) dep = createDepartment(v, { name });
              input.department = dep.id;
            }
            if (get("position")) {
              const title = get("position");
              const depId = (input.department as string | undefined) ?? null;
              let pos = c.one<{ id: string }>("SELECT id FROM positions WHERE title = ? AND department_id IS ?", title, depId);
              if (!pos) pos = createPosition(v, { title, department: depId });
              input.position = pos.id;
            }
            const email = get("workEmail").toLowerCase();
            const existing =
              (email && c.one<EmployeeRow>("SELECT * FROM employees WHERE work_email = ?", email)) ||
              (get("number") && c.one<EmployeeRow>("SELECT * FROM employees WHERE number = ?", get("number"))) ||
              undefined;
            const saved = existing ? updateEmployee(v, existing.id, input, true) : createEmployee(v, input, true);
            existing ? result.updated++ : result.created++;
            if (get("manager")) managersLater.push({ id: saved.id, email: get("manager").toLowerCase(), row });
            if (get("salary")) {
              const amount = parseAmount(get("salary"));
              if (amount === null) throw bad(`salary: ${get("salary")} is not an amount.`);
              addPay(v, saved.id, { from: saved.startDate, amount, currency: get("currency") || "TRY", period: "month" });
            }
            if (get("annualLeave") && annual) {
              const n = Number(get("annualLeave").replace(",", "."));
              if (!Number.isFinite(n) || (n * 2) % 1 !== 0 || Math.abs(n) > 366) throw bad("annual_leave is a number of days, in halves.");
              c.run(
                `INSERT INTO leave_ledger (employee_id, type, day, days, kind, period, note, created_at, created_by) VALUES (?, ?, ?, ?, 'adjustment', 'opening', 'Opening balance from the import', ?, ?)
                 ON CONFLICT (employee_id, type, kind, period) WHERE period IS NOT NULL DO UPDATE SET days = excluded.days, day = excluded.day`,
                saved.id,
                annual.id,
                c.today(),
                n,
                c.iso(),
                v.actor.name,
              );
            }
            c.db.exec("RELEASE import_row");
            result.results.push({ row, name: rowName, workEmail: rowEmail, result: existing ? "updated" : "created", employee: saved.id, message: null });
          } catch (err) {
            c.db.exec("ROLLBACK TO import_row");
            c.db.exec("RELEASE import_row");
            if (!(err instanceof HrError)) throw err;
            result.errors.push({ row, message: err.message });
            result.results.push({ row, name: rowName, workEmail: rowEmail, result: "skipped", employee: null, message: err.message });
            result.skipped++;
          }
        });
        for (const m of managersLater) {
          const mgr = c.one<{ id: string }>("SELECT id FROM employees WHERE work_email = ?", m.email);
          if (!mgr) {
            result.errors.push({ row: m.row, message: `manager ${m.email} is nobody's work email; the rest of the row is imported.` });
            continue;
          }
          try {
            updateEmployee(v, m.id, { manager: mgr.id }, true);
          } catch (err) {
            if (!(err instanceof HrError)) throw err;
            result.errors.push({ row: m.row, message: err.message });
          }
        }
        if (result.dryRun) throw DRY;
      });
    } catch (err) {
      if (err !== DRY) throw err;
      // Nothing was kept: the rows name no record.
      for (const r of result.results) r.employee = null;
    }
    return result;
  }

  return {
    department,
    position,
    listDepartments,
    createDepartment,
    updateDepartment,
    removeDepartment,
    listPositions,
    createPosition,
    updatePosition,
    removePosition,
    listEmployees,
    getEmployee,
    createEmployee,
    updateEmployee,
    removeEmployee,
    purgeExpired,
    history,
    nationalId,
    accessLog,
    currentPay,
    listPay,
    addPay,
    listDocuments,
    addDocument,
    documentFile,
    removeDocument,
    expiring,
    warnExpiring,
    orgChart,
    upcoming,
    importCsv,
    identityHash: (e: EmployeeRow, groups: string[]) =>
      createHash("sha256")
        .update([identityFields(e), ...groups.sort()].join("|"))
        .digest("hex"),
  };
}

/** 45000, 45.000,00, 45,000.50 and "45 000 TL": an amount, or null when it is not one. */
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/\s|TL|TRY|₺|EUR|€|USD|\$/gi, "");
  if (!s) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? "." : ",";
    s = s.replace(dec === "." ? /,/g : /\./g, "").replace(dec, ".");
  } else if (lastComma >= 0) s = /,\d{1,2}$/.test(s) && s.split(",").length === 2 ? s.replace(",", ".") : s.replace(/,/g, "");
  else if (lastDot >= 0 && /\.\d{3}$/.test(s)) s = s.replace(/\./g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Number(s);
}
