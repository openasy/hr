// HR: employee records, departments and positions, the org chart, documents with expiry, leave with its balances and
// approvals, joining and leaving checklists, the history of every change and the access log, and what other products
// read (Payroll's month, Time's and Calendar's absences) and are told (Identity). The HTTP layer (app.ts) is outside;
// everything here works on the database and the applied settings.
import type { DatabaseSync } from "node:sqlite";
import { atLeast } from "@openasy/auth";
import { createChecklists } from "./checklists.ts";
import { configWarnings, DEFAULT_ACCESS, GROUPS, type Config } from "./config.ts";
import { createCore, type CoreOptions, type EmployeeRow, type Viewer } from "./core.ts";
import { addDays, addMonths } from "./dates.ts";
import { identityLink, type IdentityLink } from "./identity.ts";
import { createLeave } from "./leave.ts";
import { log } from "./log.ts";
import { smtpMailer, type Mailer } from "./mail.ts";
import { createPeople } from "./people.ts";
import { holidaysOf } from "./rules.ts";
import { bad, forbidden, type Actor } from "./store.ts";
import { createSync } from "./sync.ts";

export { HrError, type Actor, type ProblemCode } from "./store.ts";

export interface HrOptions extends CoreOptions {
  /** The mail server's client; tests pass one that keeps what it is given. */
  mailer?: (c: Config) => Mailer | null;
  /** The Identity client; tests point it at a fake. */
  identity?: (c: Config) => IdentityLink | null;
}

export function createHr(db: DatabaseSync, o: HrOptions) {
  const c = createCore(db, o);
  const checklists = createChecklists(c);
  const people = createPeople(c, checklists);
  const leave = createLeave(c);

  let mailer: { key: string; m: Mailer } | null = null;
  let link: { key: string; l: IdentityLink } | null = null;
  const sync = createSync(c, {
    identityHash: people.identityHash,
    mailer: () => {
      const m = c.cfg().mail;
      if (!m) return null;
      const key = JSON.stringify(m);
      if (mailer?.key !== key) {
        mailer?.m.close();
        mailer = { key, m: o.mailer ? o.mailer(c.cfg())! : smtpMailer(m, c.env[m.password]) };
      }
      return mailer.m;
    },
    identity: () => {
      const id = c.cfg().identity;
      if (!id) return null;
      const key = JSON.stringify(id);
      if (link?.key !== key) link = { key, l: o.identity ? o.identity(c.cfg())! : identityLink({ url: id.url, token: c.env[id.token] }) };
      return link.l;
    },
  });

  const members = () => c.q<{ email: string }>("SELECT email FROM auth_users WHERE status != 'disabled'").map((m) => m.email.toLowerCase());

  function setConfig(config: Config, text: string): string[] {
    c.setConfigRaw(config, text);
    return configWarnings(config, c.env, members(), c.today());
  }

  /** The signed-in person: who they are in HR, and what they may do. */
  const viewer = (actor: Actor): Viewer => {
    if (actor.email === undefined && !actor.id.startsWith("token:") && actor.id !== "admin-token")
      actor = { ...actor, email: c.one<{ email: string }>("SELECT email FROM auth_users WHERE id = ?", actor.id)?.email ?? null };
    return c.viewer(actor);
  };

  function me(actor: Actor) {
    const v = viewer(actor);
    const e = v.employeeId ? c.employee(v.employeeId) : undefined;
    const reports = v.employeeId ? c.one<{ n: number }>("SELECT COUNT(*) AS n FROM employees WHERE manager_id = ?", v.employeeId)!.n : 0;
    return {
      member: { id: actor.id, name: actor.name, role: actor.role },
      employee: e ? { id: e.id, name: c.displayName(e) } : null,
      manages: reports,
      hr: atLeast(actor.role, "viewer"),
      waitingForMe: leave.list(v, new URLSearchParams({ scope: "approvals" })).length,
      tasks: checklists.mine(v, false).length,
    };
  }

  function settings() {
    const cfg = c.cfg();
    const year = Number(c.today().slice(0, 4));
    return {
      timeZone: cfg.timeZone,
      language: cfg.language,
      workWeek: cfg.workWeek,
      locations: cfg.locations,
      holidays: { country: cfg.holidays.country, thisYear: holidaysOf(cfg, year), nextYear: holidaysOf(cfg, year + 1) },
      leaveTypes: cfg.leaveTypes.map((t) => ({
        ...t,
        bySeniority: t.bySeniority.map(([years, days]) => ({ years, days })),
      })),
      approvals: cfg.approvals,
      documents: cfg.documents,
      checklists: cfg.checklists.map((l) => ({ ...l, tasks: l.tasks.map((t) => ({ ...t, who: typeof t.who === "object" ? t.who.email : t.who })) })),
      access: Object.fromEntries(GROUPS.map((g) => [g, cfg.access[g] ?? DEFAULT_ACCESS[g]])),
      retention: cfg.retention,
      notify: cfg.notify,
      mail: cfg.mail ? { host: cfg.mail.host, port: cfg.mail.port, security: cfg.mail.security, from: cfg.mail.from } : null,
      identity: cfg.identity,
      file: c.fileState(),
      text: c.configText(),
    };
  }

  /**
   * What Payroll needs for a month: everyone who worked a day of it, their dates, current pay, bank account, leave days
   * by type and whether each is paid, and their annual balance. It needs the pay part of every record (the viewer role
   * by default) and each person's look is logged.
   */
  function payroll(actor: Actor, q: URLSearchParams) {
    const v = viewer(actor);
    if (!atLeast(v.actor.role, "viewer")) throw forbidden("The month's records are for HR and Payroll.");
    const month = q.get("month") ?? c.today().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad("month is YYYY-MM.");
    const first = `${month}-01`;
    const last = addDays(addMonths(first, 1), -1);
    const line = c.managers();
    const rows = c.q<EmployeeRow>(
      "SELECT * FROM employees WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?) ORDER BY number, last_name",
      last,
      first,
    );
    const out = rows.map((e) => {
      const pay = c.canRead(v, e.id, "pay", line);
      const work = c.canRead(v, e.id, "work", line);
      const leaveOk = c.canRead(v, e.id, "leave", line);
      c.logAccess(v, e.id, `payroll:${month}`, [...(work ? ["work" as const] : []), ...(pay ? ["pay" as const] : []), ...(leaveOk ? ["leave" as const] : [])]);
      const annual = c.cfg().leaveTypes.find((t) => t.accrual !== "none");
      let balance: number | null = null;
      if (leaveOk && annual) {
        leave.accrue(e, last < c.today() ? last : c.today());
        const ledger = c.one<{ n: number | null }>("SELECT SUM(days) AS n FROM leave_ledger WHERE employee_id = ? AND type = ?", e.id, annual.id)!.n ?? 0;
        const taken =
          c.one<{ n: number | null }>("SELECT SUM(days) AS n FROM leave_requests WHERE employee_id = ? AND type = ? AND status = 'approved'", e.id, annual.id)!
            .n ?? 0;
        balance = Math.round((ledger - taken) * 100) / 100;
      }
      return {
        id: e.id,
        number: work ? e.number : null,
        name: c.displayName(e),
        workEmail: e.work_email,
        startDate: e.start_date,
        endDate: work ? e.end_date : null,
        employmentType: work ? e.employment_type : null,
        departmentId: e.department_id,
        nationalId: c.canRead(v, e.id, "personal", line) ? c.personalOf(e).nationalId : null,
        pay: pay ? people.currentPay(e, last) : null,
        iban: pay ? c.bankOf(e).iban : null,
        leave: leaveOk ? leave.daysInMonth(e, month) : null,
        annualBalance: balance,
      };
    });
    return { month, from: first, to: last, employees: out };
  }

  function gauges() {
    const day = c.today();
    const all = c.q<EmployeeRow>("SELECT start_date, end_date FROM employees");
    const status: Record<string, number> = { upcoming: 0, active: 0, left: 0 };
    for (const e of all) status[c.statusOf(e, day)]!++;
    return {
      employees: status,
      pendingLeave: leave.pendingCount(),
      identityFailing: c.one<{ n: number }>("SELECT COUNT(*) AS n FROM employees WHERE identity_error IS NOT NULL")!.n,
      mailWaiting: c.one<{ n: number }>("SELECT COUNT(*) AS n FROM mail_outbox")!.n,
      documentsExpiring: c.one<{ n: number }>("SELECT COUNT(*) AS n FROM documents WHERE expires_on IS NOT NULL AND expires_on <= ?", addDays(day, 30))!.n,
      counters: sync.counters,
    };
  }

  /** The background round: grants, expiry warnings, retention, Identity and the outbox. */
  async function tick() {
    if (!c.config()) return;
    try {
      leave.accrueAll();
      people.warnExpiring();
      people.purgeExpired();
    } catch (err) {
      log("error", "background round failed", { error: String(err) });
    }
    await sync.identityRound();
    await sync.flushMail();
  }

  const as =
    <A extends unknown[], R>(fn: (v: Viewer, ...a: A) => R) =>
    (actor: Actor, ...a: A) =>
      fn(viewer(actor), ...a);

  return {
    db,
    config: c.config,
    setConfig,
    settings,
    today: c.today,
    me,
    viewer,
    // people
    listDepartments: people.listDepartments,
    createDepartment: as(people.createDepartment),
    updateDepartment: as(people.updateDepartment),
    removeDepartment: as(people.removeDepartment),
    listPositions: people.listPositions,
    createPosition: as(people.createPosition),
    updatePosition: as(people.updatePosition),
    removePosition: as(people.removePosition),
    listEmployees: as(people.listEmployees),
    getEmployee: as(people.getEmployee),
    createEmployee: as((v, raw: unknown) => people.createEmployee(v, raw)),
    updateEmployee: as((v, id: string, raw: unknown) => people.updateEmployee(v, id, raw)),
    removeEmployee: as(people.removeEmployee),
    history: as(people.history),
    accessLog: as(people.accessLog),
    listPay: as(people.listPay),
    addPay: as(people.addPay),
    listDocuments: as(people.listDocuments),
    addDocument: as(people.addDocument),
    documentFile: as(people.documentFile),
    removeDocument: as(people.removeDocument),
    expiring: as(people.expiring),
    orgChart: people.orgChart,
    upcoming: as(people.upcoming),
    importCsv: as(people.importCsv),
    // checklists
    checklists: as((v, id: string) => {
      const e = c.requireEmployee(id);
      if (!c.canRead(v, e.id, "work") && !atLeast(v.actor.role, "editor")) throw forbidden("You cannot read this person's checklists.");
      return checklists.forEmployee(v, e);
    }),
    tasks: as((v, all: boolean) => checklists.mine(v, all)),
    setTask: as(checklists.setDone),
    // leave
    balances: as(leave.balances),
    adjust: as(leave.adjust),
    quoteLeave: as(leave.quote),
    createLeave: as(leave.createRequest),
    getLeave: as(leave.get),
    listLeave: as(leave.list),
    decideLeave: as(leave.decide),
    cancelLeave: as(leave.cancel),
    absences: as(leave.absences),
    holidays: leave.holidays,
    // other products
    payroll,
    integrations: sync.state,
    // background
    tick,
    identityRound: sync.identityRound,
    flushMail: sync.flushMail,
    gauges,
  };
}

export type Hr = ReturnType<typeof createHr>;
