// The org chart, joining and leaving, documents that expire, my record, integrations and the settings file.
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  PageHeader,
  Panel,
  SearchInput,
  SegmentedControl,
  SelectField,
  StatusBadge,
  TextField,
  useLocalePreference,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { CalendarPlus, Pencil, Upload, UserMinus } from "lucide-react";
import { useState } from "react";
import type { Balance, Checklist, Employee, ExpiringDoc, HistoryEntry, Integrations, Look, OrgNode, Settings } from "./api.ts";
import type { Ctx } from "./App.tsx";
import { Code, day, daysBetween, Field, Notice, num, today, useLoad, weekday, when, words } from "./common.tsx";
import { FileSettingsPage } from "./FileSettings.tsx";
import { useT } from "./i18n.ts";
import { AddDocumentDialog, asText, fieldName, grantRule, lookText, PersonalDialog, readersText, REASONS, reasonText, weekText } from "./people.tsx";

// ---------------------------------------------------------------- Org chart

function PersonCard({ p, lead }: { p: OrgNode; lead?: boolean }) {
  return (
    <a
      href={`/people/${p.id}`}
      className={`hr-card flex w-full items-center gap-2 rounded-md border bg-surface px-2.5 py-2 text-left ${lead ? "border-line-strong" : "border-line"}`}
    >
      <Avatar name={p.name} size="sm" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-fg">{p.name}</span>
        <span className="truncate text-2xs text-fg-muted">{p.position ?? p.department ?? ""}</span>
      </span>
    </a>
  );
}

function Branch({ nodes, matches, query }: { nodes: OrgNode[]; matches: (p: OrgNode) => boolean; query: string }) {
  return (
    <ul className="hr-list hr-branch flex flex-col gap-1.5 border-l border-line">
      {nodes.map((r) => (
        <li key={r.id} className={query && !matches(r) ? "hr-dim" : undefined}>
          <PersonCard p={r} />
          {r.reports.length > 0 && <Branch nodes={r.reports} matches={matches} query={query} />}
        </li>
      ))}
    </ul>
  );
}

const count = (n: OrgNode): number => n.reports.reduce((a, r) => a + 1 + count(r), 0);

export function OrgChartPage({ call }: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [chart] = useLoad<{ roots: OrgNode[]; people: number }>(call, "/api/v1/org-chart");
  const [query, setQuery] = useState("");
  const q = query.trim().toLocaleLowerCase(locale);
  const matches = (p: OrgNode) => !q || p.name.toLocaleLowerCase(locale).includes(q);
  const any = (p: OrgNode): boolean => matches(p) || p.reports.some(any);
  const roots = chart?.roots ?? [];
  // One person at the top: their direct reports are the teams. Several: each is a team of their own.
  const top = roots.length === 1 ? roots[0] : undefined;
  const leads = top ? top.reports : roots;
  return (
    <>
      <PageHeader title={t("org.title")} description={t("org.description")} />
      <div className="mb-2.5">
        <SearchInput
          label={t("org.find")}
          placeholder={t("org.findPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="hr-search"
        />
      </div>
      {chart === undefined && <p className="text-sm text-fg-muted">{t("loading")}</p>}
      {chart && !roots.length && <EmptyState title={t("org.empty")}>{t("org.emptyDetail")}</EmptyState>}
      {top && (
        <div className="hr-top mx-auto mb-2.5 w-full">
          <PersonCard p={top} lead />
          <p className="mt-1 mb-0 text-center text-2xs text-fg-muted">{t("org.direct", { count: top.reports.length })}</p>
        </div>
      )}
      <ul aria-label={t("org.teams")} className="hr-list hr-teams grid gap-2.5">
        {leads.filter(any).map((l) => {
          const n = count(l);
          return (
            <li key={l.id}>
              <section aria-label={t("org.team", { name: l.name })} className="flex flex-col gap-1.5 rounded-lg border border-line bg-canvas p-2">
                <PersonCard p={l} lead />
                {l.reports.length > 0 && <Branch nodes={l.reports} matches={matches} query={q} />}
                <p className="m-0 px-1 text-2xs text-fg-muted">{[l.department, t("org.people", { count: n })].filter(Boolean).join(" · ")}</p>
              </section>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------- Joining and leaving

export function JoiningPage(ctx: Ctx) {
  const { call, me, onChanged } = ctx;
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [lists, reload] = useLoad<{ checklists: Checklist[] }>(call, "/api/v1/checklists");
  const [integrations] = useLoad<Integrations>(call, can("viewer") ? "/api/v1/integrations" : null);
  const [people] = useLoad<{ employees: Employee[] }>(call, "/api/v1/employees");
  const [leaving, setLeaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone?: "danger" } | null>(null);
  const byId = new Map((people?.employees ?? []).map((e) => [e.id, e]));
  const toggle = (taskId: string, done: boolean) =>
    void call(`/api/v1/tasks/${taskId}/${done ? "done" : "undo"}`, { method: "POST" }).then(
      () => (reload(), onChanged()),
      (err: Error) => setNotice({ text: err.message, tone: "danger" }),
    );
  const whoText = (task: Checklist["tasks"][number]) =>
    task.who === "hr"
      ? t("joining.whoHr")
      : task.who === "manager"
        ? t("joining.whoManager", { name: task.assignee?.name ?? t("common.nobody") })
        : (task.assignee?.name ?? "");
  const identityLine = (l: Checklist, e: Employee | undefined) => {
    if (!l.identity || !me.identity) return null;
    const email = e?.workEmail ?? "";
    if (l.identity.status === "failed") return { tone: "danger" as const, state: t("identity.failing"), text: l.identity.error ?? "" };
    if (l.on === "start")
      return l.identity.status === "done"
        ? { tone: "success" as const, state: t("identity.made"), text: t("joining.identityMade", { email }) }
        : {
            tone: "info" as const,
            state: t("identity.scheduled"),
            text: t("joining.identityMakes", { email, day: day(l.anchor, locale), time: me.identity.createAt }),
          };
    return l.identity.status === "done"
      ? { tone: "success" as const, state: t("identity.off"), text: t("joining.identityOff", { email }) }
      : {
          tone: "warning" as const,
          state: t("identity.scheduled"),
          text: t("joining.identityTurnsOff", { email, day: day(l.anchor, locale), time: me.identity.disableAt }),
        };
  };
  return (
    <>
      <PageHeader
        title={t("joining.title")}
        description={t("joining.description")}
        actions={
          can("editor") && (
            <Button icon={<UserMinus />} onClick={() => setLeaving(true)}>
              {t("joining.recordLeaving")}
            </Button>
          )
        }
      />
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {integrations?.identity.failing.map((f) => (
        <Callout key={f.employee.id} tone="warning" title={t("joining.identityFailing", { name: f.employee.name })} className="mb-2.5">
          {f.error} {f.nextTry ? t("joining.tryingAgain", { when: when(f.nextTry, locale) }) : ""}
        </Callout>
      ))}
      {lists?.checklists.length === 0 && <EmptyState title={t("joining.none")}>{t("joining.noneDetail")}</EmptyState>}
      <div className="hr-halves grid gap-2.5">
        {lists?.checklists.map((l) => {
          const e = l.employee ? byId.get(l.employee.id) : undefined;
          const name = l.employee?.name ?? "";
          const id = identityLine(l, e);
          const kind = l.on === "start" ? t("joining.joining") : t("joining.leaving");
          return (
            <Panel
              key={l.id}
              aria-label={`${name}, ${kind.toLocaleLowerCase(locale)}`}
              title={`${words(l.name, locale)}: ${name}`}
              description={[
                l.on === "start" ? t("joining.starts", { day: weekday(l.anchor, locale) }) : t("joining.lastDay", { day: weekday(l.anchor, locale) }),
                e ? [e.position?.title, e.department?.name].filter(Boolean).join(", ") : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              actions={
                <Badge tone={l.done === l.total ? "success" : l.overdue ? "danger" : "neutral"}>{t("joining.doneOf", { done: l.done, total: l.total })}</Badge>
              }
            >
              <ul aria-label={t("joining.tasks")} className="hr-list flex flex-col gap-2">
                {l.tasks.map((x) => (
                  <li key={x.id} className="flex items-start justify-between gap-3 border-b border-subtle pb-2 last:border-0">
                    <Checkbox
                      label={words(x.text, locale)}
                      description={`${whoText(x)} · ${x.doneAt ? t("joining.doneBy", { by: x.doneBy ?? "" }) : t("joining.due", { day: weekday(x.dueDate, locale) })}`}
                      checked={!!x.doneAt}
                      disabled={!x.canDo}
                      onChange={(ev) => toggle(x.id, ev.target.checked)}
                    />
                    {x.overdue && <StatusBadge tone="danger">{t("joining.overdue")}</StatusBadge>}
                  </li>
                ))}
              </ul>
              {id && (
                <p className="mt-2 mb-0 flex flex-wrap items-center gap-2 rounded-md bg-canvas px-2.5 py-1.5 text-xs">
                  <StatusBadge tone={id.tone}>{t("joining.identityState", { state: id.state })}</StatusBadge>
                  {id.text}
                </p>
              )}
            </Panel>
          );
        })}
      </div>
      {leaving && (
        <LeavingDialog
          ctx={ctx}
          people={(people?.employees ?? []).filter((e) => e.status !== "left" && !e.work?.endDate)}
          onClose={() => setLeaving(false)}
          onDone={(name, d) => {
            setLeaving(false);
            setNotice({ text: t("joining.leavingNotice", { name, day: day(d, locale) }) });
            reload();
            onChanged();
          }}
        />
      )}
    </>
  );
}

function LeavingDialog({ ctx, people, onClose, onDone }: { ctx: Ctx; people: Employee[]; onClose: () => void; onDone: (name: string, day: string) => void }) {
  const t = useT();
  const [who, setWho] = useState(people[0]?.id ?? "");
  const [end, setEnd] = useState(today(30));
  const [reason, setReason] = useState<string>("resignation");
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("joining.recordLeaving")}
      description={ctx.me.identity ? t("joining.leavingDetailIdentity", { time: ctx.me.identity.disableAt }) : t("joining.leavingDetail")}
      onSubmit={(e) => {
        e.preventDefault();
        void ctx.call(`/api/v1/employees/${who}`, { method: "PATCH", body: JSON.stringify({ endDate: end, endReason: reason }) }).then(
          () => onDone(people.find((p) => p.id === who)?.name ?? "", end),
          (err: Error) => setError(err.message),
        );
      }}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!who || !end}>
            {t("joining.setEnd")}
          </Button>
        </>
      }
    >
      {error && <Callout tone="danger" title={error} />}
      <SelectField
        label={t("leave.person")}
        value={who}
        onChange={(e) => setWho(e.target.value)}
        options={people.map((p) => ({ value: p.id, label: p.name }))}
      />
      <TextField label={t("joining.lastDayLabel")} type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
      <SelectField
        label={t("joining.reason")}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        options={REASONS.map((r) => ({ value: r, label: reasonText(t, r) }))}
      />
    </Dialog>
  );
}

// ---------------------------------------------------------------- Documents

export function DocumentsPage({ call, me }: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [show, setShow] = useState<"soon" | "all">("soon");
  const [docs] = useLoad<{ documents: ExpiringDoc[] }>(call, `/api/v1/expiring-documents${show === "all" ? "?all=true" : ""}`);
  const now = today();
  const warn = me.documentKinds.filter((k) => k.expires);
  const warnText = [...new Set(warn.map((k) => k.warnDays))]
    .map((d) =>
      t("documents.warnKinds", {
        days: d,
        kinds: warn
          .filter((k) => k.warnDays === d)
          .map((k) => words(k.name, locale))
          .join(", "),
      }),
    )
    .join("; ");
  return (
    <>
      <PageHeader title={t("documents.title")} description={t("documents.description", { warn: warnText })} />
      <div className="mb-2.5">
        <SegmentedControl
          label={t("documents.show")}
          value={show}
          onChange={setShow}
          options={[
            { value: "soon", label: t("documents.soonTab") },
            { value: "all", label: t("documents.allTab") },
          ]}
        />
      </div>
      <Panel flush>
        <DataTable
          label={t("documents.expiringLabel")}
          rows={docs?.documents ?? []}
          getRowId={(d) => d.id}
          defaultSort={{ id: "left", direction: "asc" }}
          minWidth={640}
          loading={docs === undefined}
          empty={<p className="px-3 py-3 text-sm text-fg-muted">{show === "soon" ? t("documents.noneSoon") : t("documents.noneExpire")}</p>}
          columns={[
            {
              id: "who",
              header: t("leave.person"),
              sortValue: (d) => d.employee.name,
              cell: (d) => (
                <a href={`/people/${d.employee.id}/documents`} className="font-medium text-fg">
                  {d.employee.name}
                </a>
              ),
            },
            { id: "kind", header: t("documents.kind"), cell: (d) => words(d.kindName, locale) },
            { id: "file", header: t("documents.file"), cell: (d) => <span className="font-mono text-xs">{d.name}</span> },
            { id: "expires", header: t("documents.expires"), sortValue: (d) => d.expiresOn ?? "", cell: (d) => (d.expiresOn ? day(d.expiresOn, locale) : "–") },
            {
              id: "left",
              header: t("leave.state"),
              sortValue: (d) => (d.expiresOn ? daysBetween(now, d.expiresOn) : 0),
              cell: (d) => {
                const left = d.expiresOn ? daysBetween(now, d.expiresOn) : 0;
                return d.expired ? (
                  <StatusBadge tone="danger">{t("documents.expiredAgo", { count: -left })}</StatusBadge>
                ) : d.expiresSoon ? (
                  <StatusBadge tone="warning">{t("documents.inDays", { count: left })}</StatusBadge>
                ) : (
                  <StatusBadge tone="success">{t("documents.valid")}</StatusBadge>
                );
              },
            },
          ]}
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- My record

export function MyRecordPage(ctx: Ctx) {
  const { call, me } = ctx;
  const t = useT();
  const [locale] = useLocalePreference();
  const id = me.employee?.id;
  const [rec, reload] = useLoad<Employee>(call, id ? `/api/v1/employees/${id}` : null);
  const [history, reloadHistory] = useLoad<{ history: HistoryEntry[] }>(call, id ? `/api/v1/employees/${id}/history` : null);
  const [looks] = useLoad<{ entries: Look[] }>(call, id ? `/api/v1/employees/${id}/access-log` : null);
  const [balances] = useLoad<{ balances: Balance[] }>(call, id ? `/api/v1/employees/${id}/balances` : null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  if (!id) return <EmptyState title={t("me.noRecord")}>{t("me.noRecordDetail", { email: me.member.name })}</EmptyState>;
  if (rec === null) return <EmptyState title={t("common.failed")} />;
  if (!rec) return <PageHeader title={t("loading")} />;
  const p = rec.personal;
  const annual = balances?.balances.find((b) => b.hasBalance);
  const dayCount = (n: number) => t("common.days", { count: n, n: num(n, locale) });
  return (
    <>
      <PageHeader
        title={t("me.title")}
        description={t("me.description")}
        actions={
          <>
            <Button icon={<Upload />} onClick={() => setAdding(true)}>
              {t("documents.addButton")}
            </Button>
            {p && (
              <Button icon={<Pencil />} onClick={() => setEditing(true)}>
                {t("me.editContact")}
              </Button>
            )}
            <Button variant="primary" icon={<CalendarPlus />} onClick={() => window.location.assign("/leave")}>
              {t("leave.ask")}
            </Button>
          </>
        }
      />
      {notice && <Notice>{notice}</Notice>}
      <div className="hr-halves grid gap-2.5">
        {p && (
          <Panel title={t("me.contact")} description={t("me.contactDetail")} aria-label={t("me.contact")}>
            <dl className="hr-fields grid gap-x-3 gap-y-1.5 text-sm">
              <Field label={t("personal.phone")} mono>
                {p.phone ?? "–"}
              </Field>
              <Field label={t("personal.personalEmail")}>{p.personalEmail ?? "–"}</Field>
              <Field label={t("personal.address")}>{p.address ?? "–"}</Field>
              <Field label={t("personal.emergency")}>
                {p.emergencyContact ? [p.emergencyContact.name, p.emergencyContact.relation, p.emergencyContact.phone].filter(Boolean).join(", ") : "–"}
              </Field>
            </dl>
            <p className="mt-2 mb-0 text-xs">
              <a href={`/people/${id}/personal`}>{t("me.allPersonal")}</a>
            </p>
          </Panel>
        )}
        <Panel title={t("part.work")} description={t("me.workDetail")}>
          <dl className="hr-fields grid gap-x-3 gap-y-1.5 text-sm">
            <Field label={t("edit.position")}>{rec.position?.title ?? "–"}</Field>
            <Field label={t("people.department")}>{rec.department?.name ?? "–"}</Field>
            <Field label={t("people.manager")}>{rec.manager?.name ?? t("common.nobody")}</Field>
            <Field label={t("people.started")}>{day(rec.startDate, locale)}</Field>
            {annual && <Field label={t("leave.left", { type: words(annual.name, locale) })}>{dayCount(annual.available ?? 0)}</Field>}
            {annual && (
              <Field label={t("leave.yearly")}>
                {dayCount(annual.grant?.days ?? 0)}, {grantRule(t, annual.grant)}
              </Field>
            )}
            {annual?.next && (
              <Field label={t("leave.next")}>{t("me.nextGrant", { day: day(annual.next.date, locale), days: dayCount(annual.next.days) })}</Field>
            )}
          </dl>
          <p className="mt-2 mb-0 text-xs">
            <a href={`/people/${id}`}>{t("me.wholeRecord")}</a>
          </p>
        </Panel>
        <Panel title={t("me.changes")} description={t("me.changesDetail")}>
          {history?.history.length ? (
            <ul aria-label={t("me.changesLabel")} className="hr-list flex flex-col gap-1 text-xs">
              {history.history.slice(0, 12).map((h, i) => (
                <li key={i}>{t("me.change", { when: when(h.at, locale), field: fieldName(t, h.field), by: h.by })}</li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-xs text-fg-muted">{t("history.none")}</p>
          )}
        </Panel>
        <Panel title={t("me.looked")} description={t("me.lookedDetail")}>
          {looks?.entries.length ? (
            <ul aria-label={t("me.looked")} className="hr-list flex flex-col gap-1 text-xs">
              {looks.entries.slice(0, 12).map((l, i) => (
                <li key={i}>
                  {when(l.at, locale)} · {l.by}, {asText(t, l.as)}: {lookText(t, l, locale)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-xs text-fg-muted">{t("access.none")}</p>
          )}
        </Panel>
      </div>
      {editing && (
        <PersonalDialog
          call={call}
          person={rec}
          full={false}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setNotice(t("me.saved"));
            reload();
            reloadHistory();
          }}
        />
      )}
      {adding && (
        <AddDocumentDialog
          ctx={ctx}
          person={rec}
          onClose={() => setAdding(false)}
          onAdded={(d) => {
            setAdding(false);
            setNotice(t("documents.addedNotice", { kind: words(d.kindName, locale) }));
            reloadHistory();
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- Integrations

export function IntegrationsPage({ call, settings }: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [i] = useLoad<Integrations>(call, "/api/v1/integrations");
  const origin = window.location.origin;
  const id = i?.identity;
  return (
    <>
      <PageHeader title={t("integrations.title")} description={t("integrations.description")} />
      <div className="hr-halves grid gap-2.5">
        <Panel
          title={t("integrations.identity")}
          description={t("integrations.identityDetail")}
          actions={
            id && (
              <StatusBadge tone={!id.configured ? "neutral" : id.failing.length || !id.tokenSet ? "danger" : "success"}>
                {!id.configured ? t("integrations.notLinked") : id.failing.length || !id.tokenSet ? t("integrations.failing") : t("integrations.ok")}
              </StatusBadge>
            )
          }
        >
          {id?.configured ? (
            <div className="flex flex-col gap-1.5 text-xs text-fg-muted">
              <p className="m-0">{t("integrations.identityOn", { url: id.url ?? "", waiting: id.waiting })}</p>
              {!id.tokenSet && <p className="m-0 text-danger-text">{t("integrations.tokenUnset", { name: settings?.identity?.token ?? "" })}</p>}
              {id.failing.map((f) => (
                <p key={f.employee.id} className="m-0 text-danger-text">
                  <a href={`/people/${f.employee.id}`}>{f.employee.name}</a>: {f.error}
                  {f.nextTry ? ` ${t("joining.tryingAgain", { when: when(f.nextTry, locale) })}` : ""}
                </p>
              ))}
            </div>
          ) : (
            <Code label={t("integrations.identity")}>{`identity:
  url: http://identity:8080
  token: HR_IDENTITY_TOKEN
  create_at: "07:00"
  disable_at: "18:00"
  groups: { departments: true, all: [Employees] }`}</Code>
          )}
        </Panel>
        <Panel
          title={t("integrations.mail")}
          description={t("integrations.mailDetail")}
          actions={
            i && (
              <StatusBadge tone={!i.mail.configured ? "neutral" : i.mail.lastError ? "danger" : "success"}>
                {!i.mail.configured ? t("integrations.notLinked") : i.mail.lastError ? t("integrations.failing") : t("integrations.ok")}
              </StatusBadge>
            )
          }
        >
          <p className="m-0 text-xs text-fg-muted">
            {i?.mail.configured ? t("integrations.mailOn", { host: settings?.mail?.host ?? "", waiting: i.mail.waiting }) : t("integrations.mailOff")}
          </p>
          {i?.mail.lastError && <p className="m-0 text-xs text-danger-text">{i.mail.lastError}</p>}
        </Panel>
        <Panel title={t("integrations.payroll")} description={t("integrations.payrollDetail")}>
          <Code label={t("integrations.payroll")}>{`GET ${origin}/api/v1/payroll?month=${today().slice(0, 7)}
Authorization: Bearer <an HR token with the viewer role>

200 { "month", "from", "to", "employees": [{ "number", "name", "startDate",
      "endDate", "pay", "iban", "nationalId", "leave", "annualBalance" }] }`}</Code>
          <p className="mt-2 mb-0 text-xs text-fg-muted">{t("integrations.payrollLogged")}</p>
        </Panel>
        <Panel title={t("integrations.absences")} description={t("integrations.absencesDetail")}>
          <Code label={t("integrations.absences")}>{`GET ${origin}/api/v1/absences?from=${today()}&to=${today(30)}
Authorization: Bearer <an HR token>

200 { "absences": [{ "employee": { "name", "workEmail" }, "startDate", "endDate",
      "startHalf", "endHalf", "status", "type" }] }`}</Code>
        </Panel>
        <Panel title={t("integrations.api")} description={t("integrations.apiDetail")}>
          <Code label={t("integrations.api")}>{`curl -X POST ${origin}/api/v1/import \\
  -H "Authorization: Bearer $HR_TOKEN" -H "content-type: application/json" \\
  -d '{"csv":"Ad;Soyad;E-posta;İşe Giriş Tarihi\\nAyşe;Yılmaz;ayse@example.com;01.12.2026","dryRun":true}'`}</Code>
          <a href="/api/docs/" className="mt-2 block text-xs">
            {t("integrations.reference")}
          </a>
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Settings

export function SettingsFilePage({ settings: s }: Ctx & { settings: Settings }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const f = s.file;
  const applied = f?.appliedAt ? when(f.appliedAt, locale) : t("settings.notYet");
  const annual = s.leaveTypes.find((x) => x.accrual !== "none");
  const days = (n: number) => t("common.days", { count: n, n: num(n, locale) });
  const stepName = (st: Settings["approvals"][number]["steps"][number]) => (st.kind === "member" ? st.email : t(`settings.step.${st.kind}`));
  const added = s.holidays.thisYear.concat(s.holidays.nextYear).filter((h) => !!h.name);
  return (
    <FileSettingsPage
      file="hr.yaml"
      applied={applied}
      yaml={s.text || t("settings.noFile")}
      problems={
        <>
          {f?.error && (
            <Callout tone="danger" title={t("file.notApplied")} className="mb-2.5">
              {f.error}
            </Callout>
          )}
          {!!f?.warnings.length && (
            <Callout tone="warning" title={t("settings.warnings")} className="mb-2.5">
              <ul className="hr-list">
                {f.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Callout>
          )}
        </>
      }
      groups={[
        ...(annual
          ? [
              {
                title: words(annual.name, locale),
                description: t("settings.annualDetail"),
                items: [
                  ...annual.bySeniority.map((b, i) => {
                    const next = annual.bySeniority[i + 1];
                    return {
                      label: next ? t("grant.band", { from: b.years, to: next.years - 1 }) : t("grant.from", { from: b.years }),
                      value: annual.counts === "working_days" ? t("settings.workingDays", { days: days(b.days) }) : days(b.days),
                      path: `leave_types.${annual.id}.by_seniority.${b.years}`,
                    };
                  }),
                  ...(annual.atLeast
                    ? [
                        {
                          label: t("settings.atLeast"),
                          value: t("settings.atLeastValue", {
                            days: days(annual.atLeast.days),
                            young: annual.atLeast.ageUpTo ?? "–",
                            old: annual.atLeast.ageFrom ?? "–",
                          }),
                          path: `leave_types.${annual.id}.at_least`,
                        },
                      ]
                    : []),
                  {
                    label: t("settings.carryOver"),
                    value: annual.carryOver === null ? t("settings.carryAll") : days(annual.carryOver),
                    path: `leave_types.${annual.id}.carry_over`,
                  },
                ],
              },
            ]
          : []),
        {
          title: t("settings.types"),
          items: s.leaveTypes
            .filter((x) => x !== annual)
            .map((x) => ({
              label: words(x.name, locale),
              value: [
                x.perRequest ? t("settings.perRequest", { days: days(x.perRequest) }) : null,
                x.counts === "calendar_days" ? t("settings.calendar") : t("settings.working"),
                x.paid ? t("settings.paid") : t("settings.unpaid"),
                t("settings.approvalRule", { rule: x.approval }),
                x.shownToColleagues ? null : t("settings.hidden"),
              ]
                .filter(Boolean)
                .join(", "),
              path: `leave_types.${x.id}`,
            })),
        },
        {
          title: t("settings.daysOff"),
          items: [
            {
              label: t("work.week"),
              value: [
                weekText(s.workWeek, locale),
                ...s.locations.filter((l) => l.workWeek.join() !== s.workWeek.join()).map((l) => `${l.name}: ${weekText(l.workWeek, locale)}`),
              ].join("; "),
              path: `work_week`,
            },
            {
              label: t("settings.holidays"),
              value: s.holidays.country === "tr" ? t("settings.holidaysTr") : t("settings.holidaysNone"),
              path: "holidays.country",
            },
            {
              label: t("settings.halfDays"),
              value:
                added
                  .filter((h) => h.half)
                  .map((h) => `${day(h.date, locale)}, ${words(h.name, locale)}`)
                  .join("; ") || t("settings.none"),
              path: "holidays.add",
            },
          ],
        },
        {
          title: t("settings.approvals"),
          items: s.approvals.map((a) => ({
            label: a.id,
            value: a.steps.length ? a.steps.map(stepName).join(t("settings.then")) : t("settings.atOnce"),
            path: `approvals.${a.id}`,
          })),
        },
        {
          title: t("settings.access"),
          description: t("settings.accessDetail"),
          items: [
            ...(["work", "personal", "pay", "documents", "leave"] as const).map((g) => ({
              label: t(`part.${g}`),
              value: readersText(t, s.access[g]),
              path: `access.${g}`,
            })),
            {
              label: t("settings.retention"),
              value: t("settings.retentionValue", {
                years: Math.round(s.retention.afterLeavingDays / 365),
                logYears: Math.round(s.retention.accessLogDays / 365),
              }),
              path: "retention",
            },
          ],
        },
        {
          title: t("settings.links"),
          items: [
            {
              label: "Identity",
              value: s.identity
                ? t("settings.identityValue", {
                    url: s.identity.url,
                    create: `${String(Math.floor(s.identity.createAt / 60)).padStart(2, "0")}:${String(s.identity.createAt % 60).padStart(2, "0")}`,
                    disable: `${String(Math.floor(s.identity.disableAt / 60)).padStart(2, "0")}:${String(s.identity.disableAt % 60).padStart(2, "0")}`,
                    groups: [s.identity.departmentGroups ? t("settings.byDepartment") : null, ...s.identity.allGroups].filter(Boolean).join(", "),
                  })
                : t("settings.notLinked"),
              path: "identity",
            },
            { label: t("integrations.mail"), value: s.mail ? `${s.mail.host}:${s.mail.port}, ${s.mail.from}` : t("settings.none"), path: "mail" },
            { label: t("settings.notify"), value: s.notify.hr.join(", ") || t("settings.none"), path: "notify.hr" },
            { label: t("settings.zone"), value: `${s.timeZone}, ${s.language}`, path: "time_zone" },
          ],
        },
      ]}
    />
  );
}
