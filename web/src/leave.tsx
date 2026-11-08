// Leave: what waits for the viewer's approval, every request they read, who is away, balances, and asking for leave
// with the days counted live by the server (POST /api/v1/leave/quote), day by day, as the request would take them.
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Checkbox,
  DataTable,
  Dialog,
  PageHeader,
  Panel,
  SelectField,
  StatusBadge,
  Tabs,
  TextField,
  useLocalePreference,
  type Column,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { CalendarPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Absence, Balance, BalanceRow, Doc, Employee, Holiday, LeaveRequest, Me, Quote } from "./api.ts";
import type { Ctx } from "./App.tsx";
import { addDays, dayShort, Notice, num, today, useLoad, weekday, words, type Call } from "./common.tsx";
import { useT, type T } from "./i18n.ts";
import { grantRule } from "./people.tsx";

export type LeaveTab = "approve" | "requests" | "away" | "balances";

/** "Mon 14 Dec to Fri 18 Dec", "Fri 13 Nov, afternoon". */
export function leaveDates(r: Pick<LeaveRequest, "startDate" | "endDate" | "startHalf" | "endHalf">, locale: string, t: T) {
  if (r.startDate === r.endDate)
    return r.startHalf
      ? t("leave.afternoon", { day: weekday(r.startDate, locale) })
      : r.endHalf
        ? t("leave.morning", { day: weekday(r.startDate, locale) })
        : weekday(r.startDate, locale);
  const from = r.startHalf ? t("leave.fromNoon", { day: weekday(r.startDate, locale) }) : weekday(r.startDate, locale);
  const to = r.endHalf ? t("leave.toNoon", { day: weekday(r.endDate, locale) }) : weekday(r.endDate, locale);
  return t("leave.range", { from, to });
}

function stepWho(t: T, s: { kind: string; approver: { name: string } | null }) {
  const kind = s.kind === "hr" ? t("leave.stepHr") : s.kind === "second_manager" ? t("leave.stepSecond") : s.kind === "manager" ? t("leave.stepManager") : "";
  return s.approver ? (kind ? `${kind}: ${s.approver.name}` : s.approver.name) : kind || t("leave.stepHr");
}

export function StateBadge({ r, me }: { r: LeaveRequest; me: Me }) {
  const t = useT();
  if (r.status === "approved") return <StatusBadge tone="success">{t("leave.status.approved")}</StatusBadge>;
  if (r.status === "rejected") return <StatusBadge tone="danger">{t("leave.status.rejected")}</StatusBadge>;
  if (r.status === "cancelled") return <StatusBadge tone="neutral">{t("leave.status.cancelled")}</StatusBadge>;
  if (r.canDecide && r.employee.id !== me.employee?.id) return <StatusBadge tone="warning">{t("leave.waitingForYou")}</StatusBadge>;
  const w = r.waitingFor;
  const who = !w
    ? t("leave.stepHr")
    : w.kind === "hr"
      ? t("leave.stepHr")
      : w.kind === "member"
        ? (w.approver?.name ?? "")
        : (w.approver?.name ?? t("leave.stepManager"));
  return <StatusBadge tone="warning">{t("leave.waitingFor", { who })}</StatusBadge>;
}

/** The Monday of this week, and the working days of two weeks from it. */
function twoWeeks(): string[] {
  const now = today();
  const dow = (new Date(`${now}T12:00:00Z`).getUTCDay() + 6) % 7;
  const monday = addDays(now, -dow);
  const out: string[] = [];
  for (let i = 0; i < 14; i++) if (i % 7 < 5) out.push(addDays(monday, i));
  return out;
}

export function LeavePage(ctx: Ctx & { tab?: LeaveTab; request?: string }) {
  const { call, me, onChanged } = ctx;
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const showBalances = can("viewer") || me.manages > 0;
  const [tab, setTab] = useState<LeaveTab>(ctx.tab ?? (me.waitingForMe || !ctx.request ? "approve" : "requests"));
  const [n, setN] = useState(0);
  const [notice, setNotice] = useState<{ text: string; tone?: "danger" } | null>(null);
  const [asking, setAsking] = useState(false);
  const [rejecting, setRejecting] = useState<LeaveRequest | null>(null);
  const [approvals, reloadApprovals] = useLoad<{ requests: LeaveRequest[] }>(call, `/api/v1/leave?scope=approvals&n=${n}`);
  const [one] = useLoad<LeaveRequest>(call, ctx.request ? `/api/v1/leave/${ctx.request}?n=${n}` : null);
  const changed = (text: string, tone?: "danger") => {
    setNotice({ text, tone });
    setN((x) => x + 1);
    reloadApprovals();
    onChanged();
  };
  const decide = (r: LeaveRequest, approve: boolean, note?: string) =>
    void call<LeaveRequest>(`/api/v1/leave/${r.id}/${approve ? "approve" : "reject"}`, { method: "POST", body: JSON.stringify(note ? { note } : {}) }).then(
      (after) => {
        const name = r.employee.name;
        if (!approve) return changed(note ? t("leave.rejectedNoticeWhy", { name, why: note }) : t("leave.rejectedNotice", { name }));
        if (after.status === "approved") return changed(t("leave.approvedNotice", { name }));
        changed(t("leave.approvedStep", { name, next: after.waitingFor ? stepWho(t, after.waitingFor) : t("leave.stepHr") }));
      },
      (err: Error) => setNotice({ text: err.message, tone: "danger" }),
    );
  const cancel = (r: LeaveRequest) =>
    void call(`/api/v1/leave/${r.id}/cancel`, { method: "POST" }).then(
      () => changed(t("leave.cancelledNotice")),
      (err: Error) => setNotice({ text: err.message, tone: "danger" }),
    );
  const actions = { decide, reject: setRejecting, cancel };
  return (
    <>
      <PageHeader
        title={t("leave.title")}
        description={t("leave.description")}
        actions={
          (me.employee || can("editor")) && (
            <Button variant="primary" icon={<CalendarPlus />} onClick={() => setAsking(true)}>
              {t("leave.ask")}
            </Button>
          )
        }
      />
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {ctx.request && one === null && <Callout tone="warning" title={t("leave.requestGone")} className="mb-2.5" />}
      {one && <RequestPanel key={`${one.id}-${n}`} ctx={ctx} r={one} actions={actions} />}
      <Tabs
        label={t("leave.title")}
        value={tab}
        onChange={setTab}
        className="mb-2.5"
        items={[
          { value: "approve", label: t("leave.toApprove"), count: approvals?.requests.length ?? me.waitingForMe },
          { value: "requests", label: t("leave.allRequests") },
          { value: "away", label: t("leave.whoIsAway") },
          ...(showBalances ? [{ value: "balances" as const, label: t("leave.balances") }] : []),
        ]}
      />
      {tab === "approve" && (
        <div className="flex flex-col gap-2.5">
          {approvals?.requests.length === 0 && <Callout tone="success" title={t("leave.nothingWaits")} />}
          {approvals?.requests.map((r) => (
            <RequestPanel key={`${r.id}-${n}`} ctx={ctx} r={r} actions={actions} />
          ))}
        </div>
      )}
      {tab === "requests" && <RequestsTable ctx={ctx} n={n} cancel={cancel} />}
      {tab === "away" && <AwayTable call={call} />}
      {tab === "balances" && showBalances && <BalancesTable call={call} />}
      {rejecting && (
        <RejectDialog
          r={rejecting}
          onClose={() => setRejecting(null)}
          onReject={(why) => {
            decide(rejecting, false, why);
            setRejecting(null);
          }}
        />
      )}
      {asking && (
        <AskDialog
          ctx={ctx}
          onClose={() => setAsking(false)}
          onAsked={(r) => {
            setAsking(false);
            changed(
              r.status === "approved"
                ? t("leave.recordedNotice", { days: t("common.days", { count: r.days, n: num(r.days, locale) }) })
                : t("leave.askedNotice", {
                    days: t("common.days", { count: r.days, n: num(r.days, locale) }),
                    who: r.waitingFor ? stepWho(t, r.waitingFor) : t("leave.stepHr"),
                  }),
            );
          }}
        />
      )}
    </>
  );
}

type Actions = { decide: (r: LeaveRequest, approve: boolean) => void; reject: (r: LeaveRequest) => void; cancel: (r: LeaveRequest) => void };

function RequestPanel({ ctx, r, actions }: { ctx: Ctx; r: LeaveRequest; actions: Actions }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const type = ctx.me.leaveTypes.find((x) => x.id === r.type);
  const [balances] = useLoad<{ balances: Balance[] }>(
    ctx.call,
    r.status === "pending" && type?.hasBalance ? `/api/v1/employees/${r.employee.id}/balances` : null,
  );
  const [away] = useLoad<{ absences: Absence[] }>(ctx.call, `/api/v1/absences?from=${r.startDate}&to=${r.endDate}`);
  const [person] = useLoad<{ employees: Employee[] }>(ctx.call, `/api/v1/employees?q=${encodeURIComponent(r.employee.name)}`);
  const dept = person?.employees.find((e) => e.id === r.employee.id)?.department ?? null;
  const left = balances?.balances.find((b) => b.type === r.type)?.available;
  const others = (away?.absences ?? []).filter((a) => a.employee.id !== r.employee.id && (!dept || a.employee.departmentId === dept.id));
  const days = t("common.days", { count: r.days, n: num(r.days, locale) });
  const title = `${r.employee.name}: ${words(r.typeName, locale) || t("leave.away")}, ${leaveDates(r, locale, t)}`;
  return (
    <Panel
      aria-label={`${r.employee.name}, ${words(r.typeName, locale)}`}
      title={title}
      description={[
        days,
        left !== undefined ? t("leave.leftBefore", { days: t("common.days", { count: left + r.days, n: num(left + r.days, locale) }) }) : null,
        r.note ? `"${r.note}"` : null,
        r.needsDocument && !r.documentId ? t("leave.needsDocument") : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      actions={
        <span className="flex flex-wrap items-center gap-1.5">
          {r.canDecide && r.status === "pending" ? (
            <>
              <Button size="sm" onClick={() => actions.reject(r)}>
                {t("leave.reject")}
              </Button>
              <Button size="sm" variant="primary" onClick={() => actions.decide(r, true)}>
                {t("leave.approve")}
              </Button>
            </>
          ) : (
            <StateBadge r={r} me={ctx.me} />
          )}
          {r.canCancel && r.status !== "cancelled" && r.status !== "rejected" && (
            <Button size="sm" variant="ghost" onClick={() => actions.cancel(r)}>
              {t("leave.cancel")}
            </Button>
          )}
        </span>
      }
    >
      <ol aria-label={t("leave.steps")} className="hr-list flex flex-wrap gap-1.5 text-xs">
        {r.steps.map((s, i) => (
          <li
            key={`${s.kind}-${i}`}
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 ${
              s.decision === "approved" ? "border-success bg-success-soft" : s.decision === "rejected" ? "border-danger bg-danger-soft" : "border-line"
            }`}
          >
            <span className="font-medium">{t("leave.stepN", { n: i + 1 })}</span> {stepWho(t, s)}:{" "}
            {s.decision === "approved"
              ? t("leave.stepApproved", { by: s.by ?? "" })
              : s.decision === "rejected"
                ? t("leave.stepRejected", { by: s.by ?? "" })
                : t("leave.stepWaiting")}
            {s.note ? ` ("${s.note}")` : ""}
          </li>
        ))}
        {!r.steps.length && <li className="text-fg-muted">{t("leave.noSteps")}</li>}
      </ol>
      {away && (
        <p className="mt-2 mb-0 text-xs text-fg-muted">
          {others.length
            ? t("leave.alsoAway", { names: others.map((a) => a.employee.name).join(", ") })
            : dept
              ? t("leave.alsoAwayNobodyIn", { dept: dept.name })
              : t("leave.alsoAwayNobody")}
        </p>
      )}
    </Panel>
  );
}

function RequestsTable({ ctx, n, cancel }: { ctx: Ctx; n: number; cancel: (r: LeaveRequest) => void }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [status, setStatus] = useState("");
  const [list] = useLoad<{ requests: LeaveRequest[] }>(ctx.call, `/api/v1/leave?scope=all${status ? `&status=${status}` : ""}&n=${n}`);
  const cols: Column<LeaveRequest>[] = [
    {
      id: "who",
      header: t("leave.person"),
      sortValue: (r) => r.employee.name,
      cell: (r) => (
        <span className="flex items-center gap-2">
          <Avatar name={r.employee.name} size="sm" />
          <a href={`/people/${r.employee.id}`}>{r.employee.name}</a>
        </span>
      ),
    },
    { id: "type", header: t("leave.type"), cell: (r) => words(r.typeName, locale) || t("leave.away") },
    { id: "dates", header: t("leave.dates"), sortValue: (r) => r.startDate, cell: (r) => <a href={`/leave/${r.id}`}>{leaveDates(r, locale, t)}</a> },
    { id: "days", header: t("leave.days"), align: "right", mono: true, sortValue: (r) => r.days, cell: (r) => num(r.days, locale) },
    { id: "state", header: t("leave.state"), cell: (r) => <StateBadge r={r} me={ctx.me} /> },
    {
      id: "act",
      header: <span className="sr-only">{t("common.actions")}</span>,
      label: t("common.actions"),
      align: "right",
      cell: (r) =>
        r.canCancel && (r.status === "pending" || r.status === "approved") ? (
          <Button size="xs" variant="ghost" onClick={() => cancel(r)}>
            {t("leave.cancel")}
          </Button>
        ) : null,
    },
  ];
  return (
    <Panel flush>
      <div className="px-3 py-2">
        <SelectField
          label={t("leave.state")}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[
            { value: "", label: t("leave.anyState") },
            ...(["pending", "approved", "rejected", "cancelled"] as const).map((s) => ({ value: s, label: t(`leave.status.${s}`) })),
          ]}
        />
      </div>
      <div className="border-t border-line">
        <DataTable
          label={t("leave.requestsLabel")}
          rows={list?.requests ?? []}
          getRowId={(r) => r.id}
          columns={cols}
          minWidth={760}
          loading={list === undefined}
          defaultSort={{ id: "dates", direction: "desc" }}
          empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("leave.noRequests")}</p>}
        />
      </div>
    </Panel>
  );
}

function AwayTable({ call }: { call: Call }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const days = useMemo(() => twoWeeks(), []);
  const [away] = useLoad<{ absences: Absence[] }>(call, `/api/v1/absences?from=${days[0]}&to=${days.at(-1)}&pending=true`);
  const rows = new Map<string, { id: string; name: string; cells: Record<string, { text: string; tone: "info" | "neutral" | "warning" }> }>();
  for (const a of away?.absences ?? []) {
    const row = rows.get(a.employee.id) ?? { id: a.employee.id, name: a.employee.name, cells: {} };
    for (const d of days) {
      if (d < a.startDate || d > a.endDate) continue;
      const half = (d === a.startDate && a.startHalf) || (d === a.endDate && a.endHalf);
      const label = a.typeName ? words(a.typeName, locale) : t("leave.away");
      row.cells[d] =
        a.status === "pending"
          ? { text: half ? t("leave.halfPending") : t("leave.pendingShort"), tone: "warning" }
          : { text: half ? `½ ${label}` : label, tone: a.typeName ? "info" : "neutral" };
    }
    rows.set(a.employee.id, row);
  }
  const caption = t("leave.awayCaption", { from: weekday(days[0]!, locale), to: weekday(days.at(-1)!, locale) });
  return (
    <Panel title={t("leave.whoIsAway")} description={t("leave.awayDetail")} flush>
      {rows.size ? (
        <div className="overflow-x-auto">
          <table className="hr-away w-full text-left text-xs">
            <caption className="sr-only">{caption}</caption>
            <thead className="bg-canvas text-fg-muted">
              <tr>
                <th scope="col" className="px-3 py-1.5 font-semibold">
                  {t("leave.person")}
                </th>
                {days.map((d) => (
                  <th key={d} scope="col" className={`px-1 py-1.5 text-center font-semibold ${d === today() ? "text-fg" : ""}`}>
                    {dayShort(d, locale)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...rows.values()].map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <th scope="row" className="px-3 py-1.5 font-medium whitespace-nowrap text-fg">
                    <a href={`/people/${r.id}`}>{r.name}</a>
                  </th>
                  {days.map((d) => (
                    <td key={d} className="px-1 py-1.5 text-center">
                      {r.cells[d] ? <Badge tone={r.cells[d].tone}>{r.cells[d].text}</Badge> : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="m-0 px-3 py-3 text-sm text-fg-muted">{away === undefined ? t("loading") : t("leave.nobodyAway", { caption })}</p>
      )}
    </Panel>
  );
}

function BalancesTable({ call }: { call: Call }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [list] = useLoad<{ balances: BalanceRow[] }>(call, "/api/v1/balances");
  return (
    <Panel title={t("leave.annual")} description={t("leave.annualDetail")} flush>
      <DataTable
        label={t("leave.balancesLabel")}
        rows={list?.balances ?? []}
        getRowId={(b) => b.employee.id}
        minWidth={720}
        loading={list === undefined}
        defaultSort={{ id: "who", direction: "asc" }}
        empty={<p className="px-3 py-3 text-sm text-fg-muted">{list === null ? t("common.failed") : t("leave.noBalances")}</p>}
        columns={[
          {
            id: "who",
            header: t("leave.person"),
            sortValue: (b) => b.employee.name,
            cell: (b) => <a href={`/people/${b.employee.id}/leave`}>{b.employee.name}</a>,
          },
          {
            id: "service",
            header: t("leave.service"),
            align: "right",
            mono: true,
            sortValue: (b) => b.grant?.years ?? 0,
            cell: (b) => t("leave.years", { n: b.grant?.years ?? 0 }),
          },
          {
            id: "grant",
            header: t("leave.yearly"),
            align: "right",
            mono: true,
            sortValue: (b) => b.grant?.days ?? 0,
            cell: (b) => num(b.grant?.days ?? 0, locale),
          },
          { id: "rule", header: t("leave.rule"), cell: (b) => <span className="text-fg-muted">{grantRule(t, b.grant)}</span> },
          { id: "pending", header: t("leave.pendingCol"), align: "right", mono: true, cell: (b) => (b.pending ? num(b.pending, locale) : "") },
          { id: "left", header: t("leave.leftCol"), align: "right", mono: true, sortValue: (b) => b.available, cell: (b) => num(b.available, locale) },
        ]}
      />
    </Panel>
  );
}

function RejectDialog({ r, onClose, onReject }: { r: LeaveRequest; onClose: () => void; onReject: (why: string) => void }) {
  const t = useT();
  const [why, setWhy] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("leave.rejectTitle", { name: r.employee.name })}
      onSubmit={(e) => {
        e.preventDefault();
        onReject(why.trim());
      }}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="danger">
            {t("leave.reject")}
          </Button>
        </>
      }
    >
      <TextField label={t("leave.reason")} value={why} onChange={(e) => setWhy(e.target.value)} placeholder={t("leave.reasonPlaceholder")} />
    </Dialog>
  );
}

/** Public holidays of the years a range touches, by day, for naming them in the day list. */
function useHolidays(call: Call, from: string, to: string) {
  const years = [...new Set([from.slice(0, 4), to.slice(0, 4)])].filter((y) => /^\d{4}$/.test(y));
  const [a] = useLoad<{ holidays: Holiday[] }>(call, years[0] ? `/api/v1/holidays?year=${years[0]}` : null);
  const [b] = useLoad<{ holidays: Holiday[] }>(call, years[1] ? `/api/v1/holidays?year=${years[1]}` : null);
  return new Map([...(a?.holidays ?? []), ...(years[1] ? (b?.holidays ?? []) : [])].map((h) => [h.date, h]));
}

function AskDialog({ ctx, onClose, onAsked }: { ctx: Ctx; onClose: () => void; onAsked: (r: LeaveRequest) => void }) {
  const { call, me } = ctx;
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const editor = can("editor");
  const [people] = useLoad<{ employees: Employee[] }>(call, editor ? "/api/v1/employees" : null);
  const [who, setWho] = useState(me.employee?.id ?? "");
  const [type, setType] = useState(me.leaveTypes[0]?.id ?? "");
  const [from, setFrom] = useState(today(14));
  const [to, setTo] = useState(today(18));
  const [startHalf, setStartHalf] = useState(false);
  const [endHalf, setEndHalf] = useState(false);
  const [note, setNote] = useState("");
  const [document, setDocument] = useState("");
  const [approved, setApproved] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lt = me.leaveTypes.find((x) => x.id === type);
  const holidays = useHolidays(call, from, to);
  const [docs] = useLoad<{ documents: Doc[] }>(call, lt?.document && who ? `/api/v1/employees/${who}/documents` : null);
  const kindDocs = (docs?.documents ?? []).filter((d) => d.kind === lt?.document);
  const body = {
    ...(who && who !== me.employee?.id ? { employee: who } : {}),
    type,
    startDate: from,
    endDate: to,
    startHalf: !!lt?.halfDays && startHalf,
    endHalf: !!lt?.halfDays && endHalf,
  };
  const key = JSON.stringify(body);
  // The server counts the days as the request would take them: the person's work week, public holidays and half days.
  useEffect(() => {
    if (!who || !type || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return;
    let live = true;
    const timer = setTimeout(() => {
      void call<Quote>("/api/v1/leave/quote", { method: "POST", body: key }).then(
        (q) => live && (setQuote(q), setProblem(null)),
        (err: Error) => live && (setQuote(null), setProblem(err.message)),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [call, key, who, type, from, to]);
  const why = (d: Quote["perDay"][number]) => {
    const h = holidays.get(d.date);
    if (d.why === "holiday" || d.why === "half-holiday")
      return h ? (h.half ? t("ask.halfHoliday", { name: words(h.name, locale) }) : words(h.name, locale)) : t(`ask.why.${d.why}`);
    if (d.why === "day-off") return t("ask.why.day-off");
    if (d.takes === 0.5) return t("ask.halfDay");
    return lt?.counts === "calendar_days" ? t("ask.calendarDay") : t("ask.workingDay");
  };
  const dayCount = (n: number) => t("common.days", { count: n, n: num(n, locale) });
  const self = me.employee?.id === who;
  const balanceText = quote?.balance ? t("ask.leftAfter", { n: num(quote.balance.after, locale) }) : "";
  const submit = () => {
    setBusy(true);
    void call<LeaveRequest>("/api/v1/leave", {
      method: "POST",
      body: JSON.stringify({
        ...body,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(document ? { document } : {}),
        ...(editor && approved ? { approved: true } : {}),
      }),
    }).then(onAsked, (err: Error) => (setBusy(false), setProblem(err.message)));
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("leave.ask")}
      description={
        quote?.balance && lt
          ? t("ask.description", {
              name: people?.employees.find((e) => e.id === who)?.name ?? me.employee?.name ?? "",
              type: words(lt.name, locale),
              days: dayCount(quote.balance.available),
            })
          : undefined
      }
      size="lg"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !quote || quote.days <= 0 || !!problem}>
            {self ? t("ask.askFor", { days: quote ? dayCount(quote.days) : "" }) : t("ask.recordFor", { days: quote ? dayCount(quote.days) : "" })}
          </Button>
        </>
      }
    >
      {editor && (
        <SelectField
          label={t("leave.person")}
          value={who}
          onChange={(e) => setWho(e.target.value)}
          options={[
            ...(me.employee ? [] : [{ value: "", label: t("ask.pickPerson") }]),
            ...(people?.employees ?? (me.employee ? [{ id: me.employee.id, name: me.employee.name, status: "active" }] : []))
              .filter((e) => e.status !== "left")
              .map((e) => ({ value: e.id, label: e.id === me.employee?.id ? t("ask.you", { name: e.name }) : e.name })),
          ]}
        />
      )}
      <SelectField
        label={t("leave.type")}
        value={type}
        onChange={(e) => setType(e.target.value)}
        options={me.leaveTypes.map((x) => ({
          value: x.id,
          label: x.perRequest ? t("ask.typePer", { type: words(x.name, locale), days: dayCount(x.perRequest) }) : words(x.name, locale),
        }))}
      />
      <div className="hr-halves grid gap-3">
        <TextField label={t("ask.from")} type="date" value={from} onChange={(e) => (setFrom(e.target.value), e.target.value > to && setTo(e.target.value))} />
        <TextField label={t("ask.to")} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
      </div>
      {lt?.halfDays && (
        <div className="flex flex-wrap gap-4">
          <Checkbox label={t("ask.startNoon")} checked={startHalf} onChange={(e) => setStartHalf(e.target.checked)} />
          <Checkbox label={t("ask.endNoon")} checked={endHalf} onChange={(e) => setEndHalf(e.target.checked)} />
        </div>
      )}
      {lt?.document && (
        <SelectField
          label={t("ask.document", { kind: words(me.documentKinds.find((k) => k.id === lt.document)?.name, locale) || lt.document })}
          value={document}
          onChange={(e) => setDocument(e.target.value)}
          options={[
            { value: "", label: kindDocs.length ? t("ask.noDocument") : t("ask.noDocumentYet") },
            ...kindDocs.map((d) => ({ value: d.id, label: d.name })),
          ]}
        />
      )}
      <TextField label={t("ask.note")} value={note} onChange={(e) => setNote(e.target.value)} hint={t("ask.noteHint")} />
      {editor && !self && (
        <Checkbox label={t("ask.approved")} description={t("ask.approvedDetail")} checked={approved} onChange={(e) => setApproved(e.target.checked)} />
      )}
      {problem && <Callout tone="warning" title={problem} />}
      {quote && (
        <section aria-label={t("ask.daysItTakes")} className="rounded-md border border-line">
          <ul className="hr-list flex flex-col text-xs">
            {quote.perDay.map((d) => (
              <li key={d.date} className="flex items-center justify-between gap-2 border-b border-subtle px-2.5 py-1 last:border-0">
                <span className="hr-when text-fg">{weekday(d.date, locale)}</span>
                <span className="grow text-fg-muted">{why(d)}</span>
                <span className="font-mono tabular-nums">{num(d.takes, locale)}</span>
              </li>
            ))}
          </ul>
          <p className="m-0 border-t border-line bg-canvas px-2.5 py-1.5 text-xs font-semibold">
            {lt?.counts === "calendar_days" ? t("ask.calendarDays") : t("ask.workingDays")}: {num(quote.days, locale)}
            {balanceText && ` · ${balanceText}`}
          </p>
        </section>
      )}
    </Dialog>
  );
}
