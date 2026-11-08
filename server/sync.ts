// What HR does in the background: telling Identity who joins, moves and leaves, and sending the emails waiting in the
// outbox.
//
// Identity follows each record rather than a queue of events: every round, each person's account should be on from
// `create_at` on the day `create_days_before` their start day, until `disable_at` on their end day, and off after. A
// person whose account is not as it should be, or whose name, email or department changed since Identity was last
// told, is sent to Identity again. A failure is tried again after 1, 2, 4 minutes and so on up to an hour, and is
// shown on the record and under Integrations until it goes through; turning an account off is never given up.
import type { Core, EmployeeRow } from "./core.ts";
import { addDays, instantOf } from "./dates.ts";
import { IdentityError, type IdentityLink } from "./identity.ts";
import { log } from "./log.ts";
import type { Mailer } from "./mail.ts";

export interface SyncOptions {
  identity: () => IdentityLink | null;
  mailer: () => Mailer | null;
  identityHash: (e: EmployeeRow, groups: string[]) => string;
}

export function createSync(c: Core, o: SyncOptions) {
  const counters = { identity: new Map<string, number>(), mail: new Map<string, number>() };
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  /** What the account should be now: none before it is made, on while they work, off after the end day's hour. */
  function wanted(e: EmployeeRow, now: number): "none" | "active" | "disabled" {
    const id = c.cfg().identity!;
    const tz = c.cfg().timeZone;
    if (e.end_date && now >= instantOf(e.end_date, id.disableAt, tz)) return "disabled";
    if (now < instantOf(addDays(e.start_date, -id.createDaysBefore), id.createAt, tz)) return "none";
    return "active";
  }

  function groupsOf(e: EmployeeRow): string[] {
    const id = c.cfg().identity!;
    const out = [...id.allGroups];
    if (id.departmentGroups && e.department_id) {
      const d = c.one<{ name: string; identity_group: string | null }>("SELECT name, identity_group FROM departments WHERE id = ?", e.department_id);
      if (d) out.push(d.identity_group ?? d.name);
    }
    return [...new Set(out)];
  }

  /** The people whose account is not as it should be, and who are not waiting to be tried again. */
  function due(now: number) {
    if (!c.cfg().identity) return [];
    return c
      .q<EmployeeRow>(
        "SELECT * FROM employees WHERE work_email IS NOT NULL AND (identity_next_at IS NULL OR identity_next_at <= ?) ORDER BY start_date",
        c.iso(now),
      )
      .filter((e) => {
        const w = wanted(e, now);
        if (w === "disabled") return e.identity_state === "active";
        if (w === "active") return e.identity_state !== "active" || e.identity_synced !== o.identityHash(e, groupsOf(e));
        return false;
      });
  }

  async function toIdentity(link: IdentityLink, e: EmployeeRow, now: number) {
    const w = wanted(e, now);
    if (w === "disabled") {
      if (e.identity_id) await link.disable(e.identity_id);
      c.run(
        "UPDATE employees SET identity_state = 'disabled', identity_error = NULL, identity_attempts = 0, identity_next_at = NULL, identity_at = ? WHERE id = ?",
        c.iso(),
        e.id,
      );
      log("info", "identity account turned off", { employee: e.id, account: e.identity_id });
      bump(counters.identity, "disabled");
      return;
    }
    const accountId = await link.provision(
      {
        id: e.id,
        email: e.work_email!,
        firstName: e.preferred_name || e.first_name,
        lastName: e.last_name,
        displayName: c.displayName(e),
      },
      e.identity_id,
    );
    const want = groupsOf(e);
    const have = c.q<{ name: string; group_id: string }>("SELECT name, group_id FROM identity_groups WHERE employee_id = ?", e.id);
    for (const g of have.filter((h) => !want.includes(h.name))) {
      await link.removeMember(g.group_id, accountId);
      c.run("DELETE FROM identity_groups WHERE employee_id = ? AND name = ?", e.id, g.name);
    }
    for (const name of want.filter((w) => !have.some((h) => h.name === w))) {
      const groupId = await link.group(name, `hr:group:${name}`);
      await link.addMember(groupId, accountId);
      c.run("INSERT OR REPLACE INTO identity_groups (employee_id, name, group_id) VALUES (?, ?, ?)", e.id, name, groupId);
    }
    const first = e.identity_state !== "active";
    c.run(
      "UPDATE employees SET identity_id = ?, identity_state = 'active', identity_synced = ?, identity_error = NULL, identity_attempts = 0, identity_next_at = NULL, identity_at = ? WHERE id = ?",
      accountId,
      o.identityHash(e, want),
      c.iso(),
      e.id,
    );
    log("info", first ? "identity account on" : "identity account changed", { employee: e.id, account: accountId, groups: want });
    bump(counters.identity, first ? "provisioned" : "updated");
  }

  let running = false;
  async function identityRound() {
    const link = c.config()?.identity ? o.identity() : null;
    if (!link || running) return;
    running = true;
    try {
      const now = c.clock();
      for (const e of due(now)) {
        try {
          await toIdentity(link, e, now);
        } catch (err) {
          if (!(err instanceof IdentityError)) throw err;
          const attempts = e.identity_attempts + 1;
          const wait = Math.min(60, 2 ** (attempts - 1)) * 60_000;
          c.run(
            "UPDATE employees SET identity_error = ?, identity_attempts = ?, identity_next_at = ? WHERE id = ?",
            err.message,
            attempts,
            c.iso(now + wait),
            e.id,
          );
          log("warn", "identity not told", { employee: e.id, error: err.message, attempts });
          bump(counters.identity, "failed");
        }
      }
    } finally {
      running = false;
    }
  }

  let sending = false;
  async function flushMail() {
    const mailer = c.config()?.mail ? o.mailer() : null;
    if (!mailer || sending) return;
    sending = true;
    try {
      const now = c.clock();
      for (const m of c.q<{ id: number; recipient: string; subject: string; body: string; created_at: string; attempts: number }>(
        "SELECT * FROM mail_outbox WHERE next_at <= ? ORDER BY id LIMIT 50",
        c.iso(now),
      )) {
        try {
          await mailer.send({ to: m.recipient, subject: m.subject, text: m.body });
          c.run("DELETE FROM mail_outbox WHERE id = ?", m.id);
          bump(counters.mail, "sent");
        } catch (err) {
          if (now - Date.parse(m.created_at) > 3 * 86_400_000) {
            c.run("DELETE FROM mail_outbox WHERE id = ?", m.id);
            log("warn", "email dropped after three days", { to: m.recipient, error: (err as Error).message });
            bump(counters.mail, "dropped");
            continue;
          }
          const wait = Math.min(360, 2 ** m.attempts) * 60_000;
          c.run("UPDATE mail_outbox SET attempts = attempts + 1, next_at = ?, error = ? WHERE id = ?", c.iso(now + wait), (err as Error).message, m.id);
          bump(counters.mail, "failed");
        }
      }
    } finally {
      sending = false;
    }
  }

  function state() {
    const now = c.clock();
    const configured = !!c.config()?.identity;
    return {
      identity: {
        configured,
        tokenSet: configured ? !!c.env[c.cfg().identity!.token] : false,
        url: c.config()?.identity?.url ?? null,
        waiting: configured ? due(now).length : 0,
        failing: c
          .q<{ id: string; first_name: string; last_name: string; preferred_name: string | null; identity_error: string; identity_next_at: string | null }>(
            "SELECT id, first_name, last_name, preferred_name, identity_error, identity_next_at FROM employees WHERE identity_error IS NOT NULL ORDER BY identity_next_at",
          )
          .map((e) => ({ employee: { id: e.id, name: c.displayName(e) }, error: e.identity_error, nextTry: e.identity_next_at })),
      },
      mail: {
        configured: !!c.config()?.mail,
        waiting: c.one<{ n: number }>("SELECT COUNT(*) AS n FROM mail_outbox")!.n,
        lastError: c.one<{ error: string | null }>("SELECT error FROM mail_outbox WHERE error IS NOT NULL ORDER BY id DESC LIMIT 1")?.error ?? null,
      },
    };
  }

  return { identityRound, flushMail, state, counters, groupsOf, wanted };
}

export type Sync = ReturnType<typeof createSync>;
