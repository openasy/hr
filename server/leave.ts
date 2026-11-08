// Leave: requests, their approvals, balances and who is away.
//
// A request names a type from the file and its days; the days it takes are counted by the type's rule (rules.ts) on
// the person's working week and the public holidays. It goes through the steps of the type's approval rule as they
// were when it was made: the manager, the manager's manager, HR, or a named member. A step with nobody to take it,
// such as a manager for someone who has none, or the person themselves, is left out; a rule whose steps are all left
// out goes to HR. An empty rule approves at once.
//
// Balances: what a type grants (on each anniversary, or each 1 January) and HR's adjustments are in the ledger;
// approved requests are counted from the requests, so a cancelled one gives its days back. When a new period starts,
// what is left above carry_over expires. A request may take the balance down to minus `advance`.
import { atLeast } from "@openasy/auth";
import type { Step } from "./config.ts";
import type { Core, EmployeeRow, Viewer } from "./core.ts";
import { addDays, addMonths, daysBetween, isDay } from "./dates.ts";
import { countDays, currentGrant, grants, halfUnits, holidaysOf, nextGrant } from "./rules.ts";
import { bad, body, conflict, forbidden, notFound, optText } from "./store.ts";

interface RequestRow {
  id: string;
  employee_id: string;
  type: string;
  start_date: string;
  end_date: string;
  start_half: number;
  end_half: number;
  days: number;
  status: "pending" | "approved" | "rejected" | "cancelled";
  note_sealed: string | null;
  document_id: string | null;
  created_at: string;
  created_by: string;
  decided_at: string | null;
}
interface StepRow {
  request_id: string;
  pos: number;
  kind: Step["kind"];
  approver_id: string | null;
  approver_email: string | null;
  decision: "approved" | "rejected" | null;
  by_id: string | null;
  by_name: string | null;
  at: string | null;
  note: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function createLeave(c: Core) {
  const typeOf = (id: string) => c.cfg().leaveTypes.find((t) => t.id === id);
  const person = (e: EmployeeRow) => ({
    startDate: e.start_date,
    serviceStart: e.service_start ?? e.start_date,
    endDate: e.end_date,
    birthDate: c.personalOf(e).birthDate,
  });

  // ---------------------------------------------------------------- balances

  const ledgerSum = (id: string, type: string, before?: string) =>
    c.one<{ n: number | null }>(
      `SELECT SUM(days) AS n FROM leave_ledger WHERE employee_id = ? AND type = ?${before ? " AND day < ?" : ""}`,
      ...(before ? [id, type, before] : [id, type]),
    )!.n ?? 0;
  const requested = (id: string, type: string, status: "approved" | "pending", before?: string) =>
    c.one<{ n: number | null }>(
      `SELECT SUM(days) AS n FROM leave_requests WHERE employee_id = ? AND type = ? AND status = ?${before ? " AND start_date < ?" : ""}`,
      ...(before ? [id, type, status, before] : [id, type, status]),
    )!.n ?? 0;

  /** Writes what the types granted the person up to today, once per period, with what expired before each grant. */
  function accrue(e: EmployeeRow, today = c.today()) {
    for (const t of c.cfg().leaveTypes) {
      if (t.accrual === "none") continue;
      for (const g of grants(t, person(e), e.balances_from, today)) {
        if (c.one("SELECT 1 FROM leave_ledger WHERE employee_id = ? AND type = ? AND kind = 'accrual' AND period = ?", e.id, t.id, g.period)) continue;
        c.tx(() => {
          if (t.carryOver !== null) {
            const left = ledgerSum(e.id, t.id, g.date) - requested(e.id, t.id, "approved", g.date);
            if (left > t.carryOver)
              c.run(
                "INSERT OR IGNORE INTO leave_ledger (employee_id, type, day, days, kind, period, note, created_at, created_by) VALUES (?, ?, ?, ?, 'expiry', ?, ?, ?, 'HR')",
                e.id,
                t.id,
                g.date,
                -r2(left - t.carryOver),
                g.period,
                `Above the ${t.carryOver} days carried over`,
                c.iso(),
              );
          }
          c.run(
            "INSERT OR IGNORE INTO leave_ledger (employee_id, type, day, days, kind, period, note, created_at, created_by) VALUES (?, ?, ?, ?, 'accrual', ?, ?, ?, 'HR')",
            e.id,
            t.id,
            g.date,
            g.days,
            g.period,
            t.accrual === "anniversary" ? `${g.years} year(s) of service` : `For ${g.period}`,
            c.iso(),
          );
        });
      }
    }
  }

  function accrueAll() {
    const day = c.today();
    for (const e of c.q<EmployeeRow>("SELECT * FROM employees WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)", day, addDays(day, -400)))
      accrue(e, day);
  }

  function balances(v: Viewer, id: string) {
    const e = c.requireEmployee(id);
    c.requireRead(v, e.id, "leave");
    c.logAccess(v, e.id, "leave", ["leave"]);
    return balancesOf(e);
  }

  /**
   * One type's balance for everyone working whose leave part the viewer reads, such as HR's table of annual leave. Each
   * person's look is written to their access log.
   */
  function balanceList(v: Viewer, q: URLSearchParams) {
    const types = c.cfg().leaveTypes.filter((t) => t.accrual !== "none");
    const type = q.get("type") ?? types[0]?.id;
    if (!type || !types.some((t) => t.id === type)) throw bad(`type is one with a balance: ${types.map((t) => t.id).join(", ")}.`);
    const day = c.today();
    const line = c.managers();
    return c
      .q<EmployeeRow>("SELECT * FROM employees ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE")
      .filter((e) => c.statusOf(e, day) === "active" && c.canRead(v, e.id, "leave", line))
      .map((e) => {
        c.logAccess(v, e.id, "balances", ["leave"]);
        const b = balancesOf(e).find((x) => x.type === type)!;
        return {
          employee: { id: e.id, name: c.displayName(e) },
          type,
          grant: b.grant ?? null,
          balance: b.balance ?? 0,
          available: b.available ?? 0,
          pending: b.pending,
          next: b.next ?? null,
        };
      });
  }

  function balancesOf(e: EmployeeRow) {
    accrue(e);
    const year = c.today().slice(0, 4);
    return c.cfg().leaveTypes.map((t) => {
      const taken = requested(e.id, t.id, "approved");
      const pending = requested(e.id, t.id, "pending");
      const thisYear =
        c.one<{ n: number | null }>(
          "SELECT SUM(days) AS n FROM leave_requests WHERE employee_id = ? AND type = ? AND status = 'approved' AND start_date >= ? AND start_date <= ?",
          e.id,
          t.id,
          `${year}-01-01`,
          `${year}-12-31`,
        )!.n ?? 0;
      if (t.accrual === "none")
        return { type: t.id, name: t.name, paid: t.paid, hasBalance: false, perRequest: t.perRequest, takenThisYear: r2(thisYear), pending: r2(pending) };
      const ledger = c.q<{ day: string; days: number; kind: string; note: string | null }>(
        "SELECT day, days, kind, note FROM leave_ledger WHERE employee_id = ? AND type = ? ORDER BY day, id",
        e.id,
        t.id,
      );
      const sum = (k: string) => r2(ledger.filter((l) => l.kind === k).reduce((a, l) => a + l.days, 0));
      const balance = r2(ledger.reduce((a, l) => a + l.days, 0) - taken);
      const next = nextGrant(t, person(e), c.today());
      return {
        type: t.id,
        name: t.name,
        paid: t.paid,
        hasBalance: true,
        granted: sum("accrual"),
        adjusted: sum("adjustment"),
        expired: sum("expiry"),
        taken: r2(taken),
        pending: r2(pending),
        balance,
        available: r2(balance - pending),
        advance: t.advance,
        takenThisYear: r2(thisYear),
        grant: currentGrant(t, person(e), c.today()),
        next: next ? { date: next.date, days: next.days } : null,
        ledger: ledger.map((l) => ({ day: l.day, days: l.days, kind: l.kind, note: l.note })),
      };
    });
  }

  function adjust(v: Viewer, id: string, raw: unknown) {
    if (!atLeast(v.actor.role, "editor")) throw forbidden("HR adjusts balances: this needs the editor role.");
    const e = c.requireEmployee(id);
    const b = body(raw, ["type", "days", "note", "day"]);
    const t = typeOf(String(b.type));
    if (!t || t.accrual === "none")
      throw bad(
        `type is one with a balance: ${c
          .cfg()
          .leaveTypes.filter((x) => x.accrual !== "none")
          .map((x) => x.id)
          .join(", ")}.`,
      );
    const n = Number(b.days);
    if (typeof b.days !== "number" || !Number.isFinite(n) || n === 0 || Math.abs(n) > 366 || (n * 2) % 1 !== 0)
      throw bad("days is a number of days other than 0, in halves; below 0 takes days away.");
    const note = optText(b.note, "note", 200);
    if (!note) throw bad("note says why, such as Opening balance from the old system.");
    const day = b.day === undefined ? c.today() : String(b.day);
    if (!isDay(day)) throw bad("day is a day, YYYY-MM-DD.");
    c.run(
      "INSERT INTO leave_ledger (employee_id, type, day, days, kind, note, created_at, created_by) VALUES (?, ?, ?, ?, 'adjustment', ?, ?, ?)",
      e.id,
      t.id,
      day,
      n,
      note,
      c.iso(),
      v.actor.name,
    );
    return balances(v, id).find((x) => x.type === t.id)!;
  }

  // ---------------------------------------------------------------- requests

  const steps = (id: string) => c.q<StepRow>("SELECT * FROM leave_steps WHERE request_id = ? ORDER BY pos", id);
  const current = (id: string) => steps(id).find((s) => !s.decision) ?? null;
  const requestRow = (id: string) => {
    const r = c.one<RequestRow>("SELECT * FROM leave_requests WHERE id = ?", id);
    if (!r) throw notFound(`Leave request ${id}`);
    return r;
  };

  function canDecide(v: Viewer, r: RequestRow, s: StepRow | null): boolean {
    if (!s || r.status !== "pending") return false;
    const admin = atLeast(v.actor.role, "admin");
    if (v.employeeId === r.employee_id && !admin) return false;
    if (admin) return true;
    if (s.kind === "manager" || s.kind === "second_manager") return (!!s.approver_id && s.approver_id === v.employeeId) || atLeast(v.actor.role, "editor");
    if (s.kind === "hr") return atLeast(v.actor.role, "editor");
    return !!v.actor.email && s.approver_email === v.actor.email.toLowerCase();
  }

  function present(v: Viewer, r: RequestRow) {
    const e = c.employee(r.employee_id)!;
    const t = typeOf(r.type);
    const st = steps(r.id);
    const now = st.find((s) => !s.decision) ?? null;
    const seesType = c.canRead(v, e.id, "leave") || !!t?.shownToColleagues;
    const day = c.today();
    const mine = v.employeeId === e.id;
    const note =
      r.note_sealed && (mine || atLeast(v.actor.role, "editor") || c.isAbove(v.employeeId, e.id))
        ? c.keyring.open(r.note_sealed, `leave:${r.id}`).toString("utf8")
        : null;
    const approver = (s: StepRow) => {
      if (s.approver_id) {
        const a = c.employee(s.approver_id);
        return a ? { id: a.id, name: c.displayName(a) } : null;
      }
      return s.approver_email ? { id: null, name: s.approver_email } : null;
    };
    return {
      id: r.id,
      employee: { id: e.id, name: c.displayName(e) },
      type: seesType ? r.type : null,
      typeName: seesType ? (t?.name ?? { en: r.type, de: r.type, tr: r.type }) : null,
      paid: seesType ? (t?.paid ?? null) : null,
      startDate: r.start_date,
      endDate: r.end_date,
      startHalf: !!r.start_half,
      endHalf: !!r.end_half,
      days: r.days,
      status: r.status,
      note,
      documentId: c.canRead(v, e.id, "documents") ? r.document_id : null,
      needsDocument: !!t?.document && !r.document_id,
      steps: st.map((s) => ({ kind: s.kind, approver: approver(s), decision: s.decision, by: s.by_name, at: s.at, note: s.note })),
      waitingFor: now ? { kind: now.kind, approver: approver(now) } : null,
      canDecide: canDecide(v, r, now),
      canCancel: canCancel(v, r, day),
      createdAt: r.created_at,
      createdBy: r.created_by,
      decidedAt: r.decided_at,
    };
  }

  function canCancel(v: Viewer, r: RequestRow, day: string) {
    if (r.status !== "pending" && r.status !== "approved") return false;
    if (atLeast(v.actor.role, "editor")) return true;
    return v.employeeId === r.employee_id && (r.status === "pending" || r.start_date > day);
  }

  function resolveSteps(e: EmployeeRow, rule: Step[]): Array<{ kind: Step["kind"]; approverId: string | null; email: string | null }> {
    const out: Array<{ kind: Step["kind"]; approverId: string | null; email: string | null }> = [];
    for (const s of rule) {
      if (s.kind === "manager" || s.kind === "second_manager") {
        let at = e.manager_id ? c.employee(e.manager_id) : undefined;
        if (s.kind === "second_manager") at = at?.manager_id ? c.employee(at.manager_id) : undefined;
        if (at && at.id !== e.id && c.statusOf(at) !== "left") out.push({ kind: s.kind, approverId: at.id, email: null });
      } else if (s.kind === "hr") out.push({ kind: "hr", approverId: null, email: null });
      else if (s.email !== e.work_email) out.push({ kind: "member", approverId: null, email: s.email });
    }
    // A step twice in a row for the same person is one step.
    const deduped = out.filter((s, i) => i === 0 || !(s.kind === out[i - 1]!.kind && s.approverId === out[i - 1]!.approverId && s.email === out[i - 1]!.email));
    if (rule.length && !deduped.length) deduped.push({ kind: "hr", approverId: null, email: null });
    return deduped;
  }

  /** Tells whoever the request waits for, by email when the file has a mail server. */
  function notifyStep(r: RequestRow) {
    const s = current(r.id);
    if (!s) return;
    const e = c.employee(r.employee_id)!;
    const to = s.approver_id
      ? [c.employee(s.approver_id)?.work_email].filter((x): x is string => !!x)
      : s.approver_email
        ? [s.approver_email]
        : c.cfg().notify.hr;
    const t = typeOf(r.type);
    const vars = {
      name: c.displayName(e),
      type: (t?.name[c.lang()] ?? r.type).toLocaleLowerCase(c.lang()),
      from: r.start_date,
      to: r.end_date,
      days: r.days,
      url: `${c.publicUrl}/leave/${r.id}`,
    };
    for (const addr of to) c.queueMail(addr, c.t("toApproveSubject", vars), c.t("toApproveText", vars));
  }

  function notifyDecision(r: RequestRow, by: string, note: string | null) {
    const e = c.employee(r.employee_id);
    if (!e?.work_email) return;
    const t = typeOf(r.type);
    const vars = {
      type: (t?.name[c.lang()] ?? r.type).toLocaleLowerCase(c.lang()),
      from: r.start_date,
      to: r.end_date,
      days: r.days,
      by,
      note: note ? c.t("note", { note }) : "",
      url: `${c.publicUrl}/leave/${r.id}`,
    };
    if (r.status === "approved") c.queueMail(e.work_email, c.t("approvedSubject", vars), c.t("approvedText", vars));
    if (r.status === "rejected") c.queueMail(e.work_email, c.t("rejectedSubject", vars), c.t("rejectedText", vars));
  }

  /** What a request would take, without making it: for the form, before it is sent. */
  function quote(v: Viewer, raw: unknown) {
    const p = readRequest(v, raw);
    return { days: p.count.days, perDay: p.count.perDay, balance: p.balance };
  }

  function readRequest(v: Viewer, raw: unknown) {
    const b = body(raw, ["employee", "type", "startDate", "endDate", "startHalf", "endHalf", "note", "document", "approved"]);
    const employeeId = b.employee === undefined ? v.employeeId : String(b.employee);
    if (!employeeId) throw bad("employee is needed: you are not an employee in HR.");
    const e = c.requireEmployee(employeeId);
    const editor = atLeast(v.actor.role, "editor");
    if (e.id !== v.employeeId && !editor) throw forbidden("You ask for your own leave; HR records leave for others.");
    const t = typeOf(String(b.type));
    if (!t)
      throw bad(
        `type is one of ${c
          .cfg()
          .leaveTypes.map((x) => x.id)
          .join(", ")}.`,
      );
    const start = String(b.startDate ?? "");
    const end = String(b.endDate ?? b.startDate ?? "");
    if (!isDay(start)) throw bad("startDate is a day, YYYY-MM-DD.");
    if (!isDay(end) || end < start) throw bad("endDate is a day on or after startDate.");
    if (daysBetween(start, end) > 400) throw bad("A request is at most 400 days long; split it.");
    const startHalf = b.startHalf === true;
    const endHalf = b.endHalf === true;
    if ((startHalf || endHalf) && !t.halfDays) throw bad(`${t.name.en} is taken in whole days.`);
    if (start === end && startHalf && endHalf) throw bad("A one-day request starts at noon or ends at noon, not both.");
    if (start < e.start_date || (e.end_date && end > e.end_date)) throw bad("The leave is outside their employment.");
    const count = countDays(c.cfg(), t, e.location, start, end, startHalf, endHalf);
    if (count.days <= 0) throw bad("These days are all days off or public holidays: the leave takes none.");
    if (t.perRequest !== null && count.days > t.perRequest) throw bad(`${t.name.en} is at most ${t.perRequest} days at a time; this takes ${count.days}.`);
    let balance: { available: number; after: number } | null = null;
    if (t.accrual !== "none") {
      accrue(e);
      const available = r2(ledgerSum(e.id, t.id) - requested(e.id, t.id, "approved") - requested(e.id, t.id, "pending"));
      balance = { available, after: r2(available - count.days) };
    }
    return { b, e, t, start, end, startHalf, endHalf, count, balance, editor };
  }

  function createRequest(v: Viewer, raw: unknown) {
    const { b, e, t, start, end, startHalf, endHalf, count, balance, editor } = readRequest(v, raw);
    if (balance && balance.after < -t.advance)
      throw bad(
        `Not enough ${t.name.en}: ${balance.available} day(s) are free${t.advance ? `, and ${t.advance} may be taken in advance` : ""}; this takes ${count.days}.`,
      );
    const note = optText(b.note, "note", 1000) ?? null;
    let documentId: string | null = null;
    if (b.document !== undefined && b.document !== null) {
      documentId = String(b.document);
      if (!c.one("SELECT 1 FROM documents WHERE id = ? AND employee_id = ?", documentId, e.id)) throw bad("document is not one of this person's documents.");
    }
    if (b.approved !== undefined && (typeof b.approved !== "boolean" || (b.approved && !editor)))
      throw bad("approved is true only for HR recording leave already agreed.");
    const [s1, e1] = halfUnits(start, end, startHalf, endHalf);
    const id = c.newId();
    c.tx(() => {
      for (const o of c.q<RequestRow>(
        "SELECT * FROM leave_requests WHERE employee_id = ? AND status IN ('pending', 'approved') AND start_date <= ? AND end_date >= ?",
        e.id,
        end,
        start,
      )) {
        const [s2, e2] = halfUnits(o.start_date, o.end_date, !!o.start_half, !!o.end_half);
        if (s1 < e2 && s2 < e1) throw conflict(`This overlaps their leave from ${o.start_date} to ${o.end_date}.`);
      }
      const rule = c.cfg().approvals.find((a) => a.id === t.approval)!;
      const resolved = b.approved ? [] : resolveSteps(e, rule.steps);
      const approved = resolved.length === 0;
      c.run(
        `INSERT INTO leave_requests (id, employee_id, type, start_date, end_date, start_half, end_half, days, status, note_sealed, document_id, created_at, created_by, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        e.id,
        t.id,
        start,
        end,
        startHalf ? 1 : 0,
        endHalf ? 1 : 0,
        count.days,
        approved ? "approved" : "pending",
        note ? c.keyring.seal(note, `leave:${id}`) : null,
        documentId,
        c.iso(),
        v.actor.name,
        approved ? c.iso() : null,
      );
      if (b.approved)
        c.run(
          "INSERT INTO leave_steps (request_id, pos, kind, decision, by_id, by_name, at, note) VALUES (?, 0, 'hr', 'approved', ?, ?, ?, 'Recorded by HR')",
          id,
          v.actor.id,
          v.actor.name,
          c.iso(),
        );
      resolved.forEach((s, pos) =>
        c.run("INSERT INTO leave_steps (request_id, pos, kind, approver_id, approver_email) VALUES (?, ?, ?, ?, ?)", id, pos, s.kind, s.approverId, s.email),
      );
      const r = requestRow(id);
      if (approved) notifyDecision(r, v.actor.name, null);
      else notifyStep(r);
    });
    return present(v, requestRow(id));
  }

  function decide(v: Viewer, id: string, raw: unknown, decision: "approved" | "rejected") {
    requestRow(id);
    const b = body(raw, ["note"]);
    const note = optText(b.note, "note", 500) ?? null;
    c.tx(() => {
      const r = requestRow(id);
      const s = current(id);
      if (r.status !== "pending" || !s) throw conflict(`This request is ${r.status}.`);
      if (!canDecide(v, r, s)) throw forbidden(v.employeeId === r.employee_id ? "Nobody approves their own leave." : "This request does not wait for you.");
      c.run(
        "UPDATE leave_steps SET decision = ?, by_id = ?, by_name = ?, at = ?, note = ? WHERE request_id = ? AND pos = ?",
        decision,
        v.actor.id,
        v.actor.name,
        c.iso(),
        note,
        id,
        s.pos,
      );
      const done = decision === "rejected" || !current(id);
      if (done) c.run("UPDATE leave_requests SET status = ?, decided_at = ? WHERE id = ?", decision, c.iso(), id);
      const after = requestRow(id);
      if (done) notifyDecision(after, v.actor.name, note);
      else notifyStep(after);
    });
    return present(v, requestRow(id));
  }

  function cancel(v: Viewer, id: string) {
    const r = requestRow(id);
    if (!canCancel(v, r, c.today()))
      throw r.status === "pending" || r.status === "approved"
        ? forbidden("Leave that has started is cancelled by HR.")
        : conflict(`This request is ${r.status}.`);
    c.run("UPDATE leave_requests SET status = 'cancelled', decided_at = ? WHERE id = ?", c.iso(), id);
    return present(v, requestRow(id));
  }

  function get(v: Viewer, id: string) {
    const r = requestRow(id);
    const may = v.employeeId === r.employee_id || c.canRead(v, r.employee_id, "leave") || canDecide(v, r, current(id));
    if (!may) throw forbidden("You cannot read this request.");
    return present(v, r);
  }

  /**
   * Requests: `mine` (the default), `approvals` (waiting for the viewer), `team` (the people they manage) or `all`
   * (for those who read everyone's leave); `employee` narrows to one person, `status` to one status.
   */
  function list(v: Viewer, q: URLSearchParams) {
    const scope = q.get("scope") ?? "mine";
    if (!["mine", "approvals", "team", "all"].includes(scope)) throw bad("scope is mine, approvals, team or all.");
    const status = q.get("status");
    if (status && !["pending", "approved", "rejected", "cancelled"].includes(status)) throw bad("status is pending, approved, rejected or cancelled.");
    const line = c.managers();
    let rows = c.q<RequestRow>(
      `SELECT * FROM leave_requests${status ? " WHERE status = ?" : ""} ORDER BY start_date DESC, created_at DESC LIMIT 2000`,
      ...(status ? [status] : []),
    );
    const emp = q.get("employee");
    if (emp) rows = rows.filter((r) => r.employee_id === emp);
    if (scope === "mine") rows = rows.filter((r) => r.employee_id === v.employeeId);
    else if (scope === "approvals") rows = rows.filter((r) => r.status === "pending" && canDecide(v, r, current(r.id)));
    else if (scope === "team") rows = rows.filter((r) => c.isAbove(v.employeeId, r.employee_id, line));
    else rows = rows.filter((r) => c.canRead(v, r.employee_id, "leave", line));
    return rows.map((r) => present(v, r));
  }

  /**
   * Who is away from `from` to `to`: approved leave, and pending leave when asked. Everyone signed in sees who is away;
   * the type only for those who read the person's leave, or for types the file shows to colleagues.
   */
  function absences(v: Viewer, q: URLSearchParams) {
    const from = q.get("from") ?? c.today();
    const to = q.get("to") ?? addDays(from, 30);
    if (!isDay(from) || !isDay(to) || to < from || daysBetween(from, to) > 366) throw bad("from and to are days, YYYY-MM-DD, at most a year apart.");
    const pending = q.get("pending") === "true";
    const dep = q.get("department");
    const line = c.managers();
    return c
      .q<RequestRow>(
        `SELECT * FROM leave_requests WHERE status IN (${pending ? "'approved', 'pending'" : "'approved'"}) AND start_date <= ? AND end_date >= ? ORDER BY start_date`,
        to,
        from,
      )
      .filter((r) => !dep || c.employee(r.employee_id)?.department_id === dep)
      .map((r) => {
        const e = c.employee(r.employee_id)!;
        const t = typeOf(r.type);
        const shown = c.canRead(v, e.id, "leave", line) || !!t?.shownToColleagues;
        return {
          id: r.id,
          employee: { id: e.id, name: c.displayName(e), workEmail: e.work_email, departmentId: e.department_id },
          startDate: r.start_date,
          endDate: r.end_date,
          startHalf: !!r.start_half,
          endHalf: !!r.end_half,
          status: r.status,
          type: shown ? r.type : null,
          typeName: shown ? (t?.name ?? null) : null,
        };
      });
  }

  /** The approved leave days of a person in a month, by type, as Payroll needs them. */
  function daysInMonth(e: EmployeeRow, month: string) {
    const first = `${month}-01`;
    const end = addDays(addMonths(first, 1), -1);
    const out = new Map<string, number>();
    for (const r of c.q<RequestRow>(
      "SELECT * FROM leave_requests WHERE employee_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?",
      e.id,
      end,
      first,
    )) {
      const t = typeOf(r.type);
      if (!t) continue;
      const n = countDays(c.cfg(), t, e.location, r.start_date, r.end_date, !!r.start_half, !!r.end_half)
        .perDay.filter((d) => d.date >= first && d.date <= end)
        .reduce((a, d) => a + d.takes, 0);
      out.set(r.type, r2((out.get(r.type) ?? 0) + n));
    }
    return [...out].map(([type, days]) => ({ type, paid: typeOf(type)?.paid ?? true, days }));
  }

  function holidays(q: URLSearchParams) {
    const year = Number(q.get("year") ?? c.today().slice(0, 4));
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw bad("year is a year, such as 2026.");
    return holidaysOf(c.cfg(), year);
  }

  return {
    typeOf,
    accrue,
    accrueAll,
    balances,
    balanceList,
    adjust,
    quote,
    createRequest,
    decide,
    cancel,
    get,
    list,
    absences,
    daysInMonth,
    holidays,
    pendingCount: () => c.one<{ n: number }>("SELECT COUNT(*) AS n FROM leave_requests WHERE status = 'pending'")!.n,
  };
}

export type Leave = ReturnType<typeof createLeave>;
