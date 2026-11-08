// People: the directory with its search and department filter, the CSV import, adding an employee, and the record with
// its parts. The UI shows only the parts the API gives the viewer; each part's tab loads it when opened, and that read
// is logged by the server. The T.C. kimlik number comes masked and is read whole only on "Show", which is logged too.
import {
  Avatar,
  Badge,
  Button,
  Callout,
  DataTable,
  Dialog,
  EmptyState,
  FacetFilter,
  FilterBar,
  IconButton,
  KpiCard,
  KpiGrid,
  PageHeader,
  Panel,
  SearchInput,
  SelectField,
  StatusBadge,
  Tabs,
  TextField,
  useLocalePreference,
  type Column,
  type Locale,
  type Tone,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { ArrowLeft, Download, Eye, EyeOff, FileUp, Pencil, Plus, Trash2, Upload, Wallet } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Balance, Doc, Employee, HistoryEntry, ImportResult, LeaveRequest, Look, Part, PayEntry, Position, Reader } from "./api.ts";
import type { Ctx } from "./App.tsx";
import { country, day, Field, money, Notice, num, readBase64, ReadBy, size, today, useLoad, when, words, yearsSince, type Call } from "./common.tsx";
import { useT, type T } from "./i18n.ts";
import { leaveDates, StateBadge } from "./leave.tsx";

export type RecordPart = Part | "history" | "access";

/** Working, starting on a day, leaving on a day, or left; a status for the lists. */
export function statusOf(e: Employee, t: T, locale: Locale): { label: string; tone: Tone } {
  if (e.status === "upcoming") return { label: t("status.starts", { day: day(e.startDate, locale) }), tone: "info" };
  if (e.status === "left") return { label: t("status.left"), tone: "neutral" };
  if (e.work?.endDate) return { label: t("status.leaves", { day: day(e.work.endDate, locale) }), tone: "warning" };
  return { label: t("status.working"), tone: "success" };
}

/** Who reads a part, from the file's access, as people read it. Admins always do. */
export function readersText(t: T, readers: Reader[] | undefined) {
  if (!readers) return t("readBy.yourRole");
  const names = readers.map((r) => t(`readBy.${r}`));
  return t("readBy.list", { list: names.join(", ") });
}

function useReaders(ctx: Ctx) {
  const t = useT();
  // Only HR reads the settings; for everyone else the file's access is described in general words.
  return (part: Part) => (ctx.settings ? readersText(t, ctx.settings.access[part]) : t("readBy.yourRole"));
}

// ---------------------------------------------------------------- People

export function PeoplePage(ctx: Ctx) {
  const { call, departments, onChanged } = ctx;
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [query, setQuery] = useState("");
  const [depts, setDepts] = useState<string[]>([]);
  const [show, setShow] = useState<"current" | "all">("current");
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [list, reload] = useLoad<{ employees: Employee[] }>(call, `/api/v1/employees?status=${show}`);
  const all = list?.employees ?? [];
  const q = query.trim().toLocaleLowerCase(locale);
  const rows = all.filter(
    (p) =>
      (!depts.length || depts.includes(p.department?.id ?? "-")) &&
      `${p.name} ${p.position?.title ?? ""} ${p.workEmail ?? ""}`.toLocaleLowerCase(locale).includes(q),
  );
  const cols: Column<Employee>[] = [
    {
      id: "name",
      header: t("people.name"),
      width: "28%",
      sortValue: (p) => p.name,
      cell: (p) => (
        <span className="flex items-center gap-2">
          <Avatar name={p.name} size="sm" />
          <span className="flex min-w-0 flex-col">
            <a href={`/people/${p.id}`} className="truncate font-medium text-fg">
              {p.name}
            </a>
            <span className="truncate text-2xs text-fg-muted">{p.position?.title ?? ""}</span>
          </span>
        </span>
      ),
    },
    { id: "dept", header: t("people.department"), sortValue: (p) => p.department?.name ?? "", cell: (p) => p.department?.name ?? "–" },
    {
      id: "manager",
      header: t("people.manager"),
      sortValue: (p) => p.manager?.name ?? "",
      cell: (p) => p.manager?.name ?? <span className="text-xs text-fg-muted">{t("common.nobody")}</span>,
    },
    { id: "location", header: t("people.location"), cell: (p) => p.location?.name ?? "–" },
    { id: "start", header: t("people.started"), sortValue: (p) => p.startDate, cell: (p) => day(p.startDate, locale) },
    {
      id: "status",
      header: t("people.status"),
      cell: (p) => {
        const s = statusOf(p, t, locale);
        return <StatusBadge tone={s.tone}>{s.label}</StatusBadge>;
      },
    },
  ];
  return (
    <>
      <PageHeader
        title={t("people.title")}
        description={t("people.description")}
        actions={
          can("editor") && (
            <>
              <Button icon={<Upload />} onClick={() => setImporting(true)}>
                {t("people.import")}
              </Button>
              <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
                {t("people.add")}
              </Button>
            </>
          )
        }
      />
      {notice && <Notice>{notice}</Notice>}
      <Panel flush>
        <div className="px-3 py-2">
          <FilterBar onClear={depts.length || query ? () => (setDepts([]), setQuery("")) : undefined}>
            <SearchInput
              label={t("people.search")}
              placeholder={t("people.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="hr-search"
            />
            <FacetFilter
              label={t("people.department")}
              options={[
                ...departments.map((d) => ({ value: d.id, label: d.name, count: all.filter((p) => p.department?.id === d.id).length })),
                ...(all.some((p) => !p.department) ? [{ value: "-", label: t("common.noDepartment"), count: all.filter((p) => !p.department).length }] : []),
              ]}
              selected={depts}
              onChange={setDepts}
            />
            {can("viewer") && (
              <SelectField
                label={t("people.show")}
                value={show}
                onChange={(e) => setShow(e.target.value as "current" | "all")}
                options={[
                  { value: "current", label: t("people.showCurrent") },
                  { value: "all", label: t("people.showAll") },
                ]}
              />
            )}
          </FilterBar>
        </div>
        <div className="border-t border-line">
          <DataTable
            label={t("people.title")}
            columns={cols}
            rows={rows}
            getRowId={(p) => p.id}
            minWidth={820}
            loading={list === undefined}
            defaultSort={{ id: "name", direction: "asc" }}
            empty={<p className="px-3 py-3 text-sm text-fg-muted">{list === null ? t("common.failed") : t("people.none")}</p>}
          />
        </div>
      </Panel>
      {importing && (
        <ImportDialog
          call={call}
          onClose={() => setImporting(false)}
          onDone={(text) => {
            setImporting(false);
            setNotice(text);
            reload();
            onChanged();
          }}
        />
      )}
      {adding && (
        <EmployeeDialog
          ctx={ctx}
          people={all}
          onClose={() => setAdding(false)}
          onSaved={(e) => {
            setAdding(false);
            onChanged();
            window.location.assign(`/people/${e.id}`);
          }}
        />
      )}
    </>
  );
}

function ImportDialog({ call, onClose, onDone }: { call: Call; onClose: () => void; onDone: (notice: string) => void }) {
  const t = useT();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [checked, setChecked] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lines = file ? file.text.split(/\r?\n/).filter((l) => l.trim()) : [];
  const sep = lines[0] && (lines[0].split(";").length > lines[0].split(",").length ? ";" : ",");
  const run = (dryRun: boolean) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    void call<ImportResult>("/api/v1/import", { method: "POST", body: JSON.stringify({ csv: file.text, dryRun }) }).then(
      (r) => {
        setBusy(false);
        if (dryRun) setChecked(r);
        else
          onDone(
            r.skipped
              ? t("import.doneSkipped", { count: r.created + r.updated, file: file.name, rows: r.errors.map((e) => e.row).join(", ") })
              : t("import.done", { count: r.created + r.updated, file: file.name }),
          );
      },
      (err: Error) => (setBusy(false), setError(err.message)),
    );
  };
  const ok = checked ? checked.created + checked.updated : 0;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("import.title")}
      description={t("import.description")}
      size="lg"
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {checked ? (
            <Button variant="primary" disabled={!ok || busy} onClick={() => run(false)}>
              {t("import.importRows", { count: ok })}
            </Button>
          ) : (
            <Button variant="primary" disabled={!file || busy} onClick={() => run(true)}>
              {t("import.check")}
            </Button>
          )}
        </>
      }
    >
      <label className="hr-drop flex items-center gap-2 rounded-md border border-dashed border-line-strong px-3 py-3 text-sm text-fg">
        <FileUp aria-hidden className="size-4 text-fg-muted" />
        <span className="grow">{file ? t("import.file", { name: file.name, count: Math.max(0, lines.length - 1), sep: sep ?? "," }) : t("import.pick")}</span>
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label={t("import.pickLabel")}
          className="hr-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            setChecked(null);
            if (f) void f.text().then((text) => setFile({ name: f.name, text }));
          }}
        />
      </label>
      {file && (
        <pre className="hr-code m-0 overflow-x-auto rounded-md bg-canvas px-2.5 py-2 font-mono text-2xs text-fg">
          {lines.slice(0, 6).join("\n")}
          {lines.length > 6 ? "\n…" : ""}
        </pre>
      )}
      {!file && <p className="m-0 text-xs text-fg-muted">{t("import.headers")}</p>}
      {error && <Callout tone="danger" title={error} />}
      {checked && (
        <>
          {!!checked.ignoredColumns.length && (
            <p className="m-0 text-xs text-fg-muted">{t("import.ignored", { columns: checked.ignoredColumns.join(", ") })}</p>
          )}
          <DataTable
            label={t("import.checked")}
            rows={checked.results}
            getRowId={(r) => String(r.row)}
            minWidth={520}
            columns={[
              { id: "row", header: t("import.row"), mono: true, cell: (r) => r.row },
              { id: "name", header: t("people.name"), cell: (r) => r.name || r.workEmail || "–" },
              {
                id: "result",
                header: t("import.result"),
                cell: (r) =>
                  r.result === "skipped" ? (
                    <span className="flex items-center gap-1.5">
                      <StatusBadge tone="danger">{t("import.mistake")}</StatusBadge>
                      {r.message}
                    </span>
                  ) : (
                    t(`import.${r.result}`)
                  ),
              },
            ]}
          />
          {checked.errors
            .filter((e) => !checked.results.some((r) => r.row === e.row && r.result === "skipped"))
            .map((e) => (
              <p key={`${e.row}-${e.message}`} className="m-0 text-xs text-warning-text">
                {t("import.rowNote", { row: e.row, message: e.message })}
              </p>
            ))}
        </>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- Adding and changing a record

const EMPLOYMENT = ["full_time", "part_time", "intern", "contractor"] as const;

/** Directory and work fields; HR only. A department or position typed that does not exist yet is made. */
export function EmployeeDialog({
  ctx,
  people,
  current,
  onClose,
  onSaved,
}: {
  ctx: Ctx;
  people: Employee[];
  current?: Employee;
  onClose: () => void;
  onSaved: (e: Employee) => void;
}) {
  const { call, departments, settings } = ctx;
  const t = useT();
  const [positions] = useLoad<{ positions: Position[] }>(call, "/api/v1/positions");
  const w = current?.work;
  const [f, setF] = useState({
    firstName: current?.firstName ?? "",
    lastName: current?.lastName ?? "",
    preferredName: current?.preferredName ?? "",
    workEmail: current?.workEmail ?? "",
    department: current?.department?.name ?? "",
    position: current?.position?.title ?? "",
    manager: current?.manager?.id ?? "",
    location: current?.location?.id ?? "",
    startDate: current?.startDate ?? today(14),
    number: w?.number ?? "",
    employmentType: w?.employmentType ?? "full_time",
    serviceStart: w?.serviceStart ?? "",
    probationEnd: w?.probationEnd ?? "",
    contract: w?.contract ?? "indefinite",
    contractEnd: w?.contractEnd ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const blank = (s: string) => s.trim() || null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let dep = departments.find((d) => d.name.toLocaleLowerCase() === f.department.trim().toLocaleLowerCase());
      if (f.department.trim() && !dep) dep = await call("/api/v1/departments", { method: "POST", body: JSON.stringify({ name: f.department.trim() }) });
      let pos = positions?.positions.find((p) => p.title === f.position.trim() && p.departmentId === (dep?.id ?? null));
      if (f.position.trim() && !pos)
        pos = await call("/api/v1/positions", { method: "POST", body: JSON.stringify({ title: f.position.trim(), department: dep?.id ?? null }) });
      const body = {
        firstName: f.firstName.trim(),
        lastName: f.lastName.trim(),
        preferredName: blank(f.preferredName),
        workEmail: blank(f.workEmail),
        department: dep?.id ?? null,
        position: pos?.id ?? null,
        manager: f.manager || null,
        location: f.location || null,
        startDate: f.startDate,
        number: blank(f.number),
        employmentType: f.employmentType,
        contract: f.contract,
        contractEnd: f.contract === "fixed" ? blank(f.contractEnd) : null,
        ...(current
          ? { serviceStart: blank(f.serviceStart), probationEnd: blank(f.probationEnd) }
          : blank(f.serviceStart)
            ? { serviceStart: f.serviceStart }
            : {}),
      };
      const saved = await call<Employee>(current ? `/api/v1/employees/${current.id}` : "/api/v1/employees", {
        method: current ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      onSaved(saved);
    } catch (err) {
      setBusy(false);
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={current ? t("edit.title", { name: current.name }) : t("edit.addTitle")}
      description={current ? undefined : t("edit.addDetail")}
      size="lg"
      onSubmit={(e) => void submit(e)}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !f.firstName.trim() || !f.lastName.trim() || !f.startDate}>
            {current ? t("common.save") : t("edit.add")}
          </Button>
        </>
      }
    >
      {error && <Callout tone="danger" title={error} />}
      <div className="hr-form grid gap-3">
        <TextField label={t("edit.firstName")} value={f.firstName} onChange={set("firstName")} required />
        <TextField label={t("edit.lastName")} value={f.lastName} onChange={set("lastName")} required />
        <TextField label={t("edit.preferredName")} value={f.preferredName} onChange={set("preferredName")} />
        <TextField label={t("edit.workEmail")} type="email" value={f.workEmail} onChange={set("workEmail")} hint={t("edit.workEmailHint")} />
        <TextField label={t("people.department")} value={f.department} onChange={set("department")} list="hr-departments" hint={t("edit.newMade")} />
        <TextField label={t("edit.position")} value={f.position} onChange={set("position")} list="hr-positions" />
        <SelectField
          label={t("people.manager")}
          value={f.manager}
          onChange={set("manager")}
          options={[
            { value: "", label: t("common.nobody") },
            ...people.filter((p) => p.id !== current?.id && p.status !== "left").map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
        <SelectField
          label={t("people.location")}
          value={f.location}
          onChange={set("location")}
          options={[{ value: "", label: t("edit.noLocation") }, ...(settings?.locations ?? []).map((l) => ({ value: l.id, label: l.name }))]}
        />
        <TextField label={t("edit.startDate")} type="date" value={f.startDate} onChange={set("startDate")} required />
        <TextField label={t("edit.serviceStart")} type="date" value={f.serviceStart} onChange={set("serviceStart")} hint={t("edit.serviceStartHint")} />
        <TextField label={t("work.number")} value={f.number} onChange={set("number")} mono />
        <SelectField
          label={t("work.employment")}
          value={f.employmentType}
          onChange={set("employmentType")}
          options={EMPLOYMENT.map((x) => ({ value: x, label: t(`employment.${x}`) }))}
        />
        <SelectField
          label={t("work.contract")}
          value={f.contract}
          onChange={set("contract")}
          options={[
            { value: "indefinite", label: t("contract.indefinite") },
            { value: "fixed", label: t("contract.fixed") },
          ]}
        />
        {f.contract === "fixed" && <TextField label={t("edit.contractEnd")} type="date" value={f.contractEnd} onChange={set("contractEnd")} />}
        {current && <TextField label={t("edit.probationEnd")} type="date" value={f.probationEnd} onChange={set("probationEnd")} />}
      </div>
      {!current && <p className="m-0 text-xs text-fg-muted">{t("edit.probationDefault")}</p>}
      <datalist id="hr-departments">
        {departments.map((d) => (
          <option key={d.id} value={d.name} aria-label={d.name} />
        ))}
      </datalist>
      <datalist id="hr-positions">
        {[...new Set((positions?.positions ?? []).map((p) => p.title))].map((p) => (
          <option key={p} value={p} aria-label={p} />
        ))}
      </datalist>
    </Dialog>
  );
}

/** Contact details for the person; every personal field for HR. A blank T.C. kimlik no leaves the number as it is. */
export function PersonalDialog({
  call,
  person,
  full,
  onClose,
  onSaved,
}: {
  call: Call;
  person: Employee;
  full: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const p = person.personal;
  const [f, setF] = useState({
    phone: p?.phone ?? "",
    personalEmail: p?.personalEmail ?? "",
    address: p?.address ?? "",
    ecName: p?.emergencyContact?.name ?? "",
    ecRelation: p?.emergencyContact?.relation ?? "",
    ecPhone: p?.emergencyContact?.phone ?? "",
    birthDate: p?.birthDate ?? "",
    gender: p?.gender ?? "",
    maritalStatus: p?.maritalStatus ?? "",
    nationality: p?.nationality ?? "",
    nationalId: "",
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const blank = (s: string) => s.trim() || null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {
      phone: blank(f.phone),
      personalEmail: blank(f.personalEmail),
      address: blank(f.address),
      emergencyContact: f.ecName.trim() && f.ecPhone.trim() ? { name: f.ecName.trim(), relation: blank(f.ecRelation), phone: f.ecPhone.trim() } : null,
    };
    if (full) {
      Object.assign(body, {
        birthDate: blank(f.birthDate),
        gender: f.gender || null,
        maritalStatus: f.maritalStatus || null,
        nationality: blank(f.nationality),
      });
      if (f.nationalId.trim()) body.nationalId = f.nationalId.trim();
    }
    void call(`/api/v1/employees/${person.id}`, { method: "PATCH", body: JSON.stringify(body) }).then(onSaved, (err: Error) => setError(err.message));
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={full ? t("personal.editTitle", { name: person.name }) : t("me.editContact")}
      size={full ? "lg" : "md"}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary">
            {t("common.save")}
          </Button>
        </>
      }
    >
      {error && <Callout tone="danger" title={error} />}
      <div className={full ? "hr-form grid gap-3" : "flex flex-col gap-3"}>
        <TextField label={t("personal.phone")} value={f.phone} onChange={set("phone")} />
        <TextField label={t("personal.personalEmail")} type="email" value={f.personalEmail} onChange={set("personalEmail")} />
        <TextField label={t("personal.address")} value={f.address} onChange={set("address")} />
        <TextField label={t("personal.ecName")} value={f.ecName} onChange={set("ecName")} />
        <TextField label={t("personal.ecRelation")} value={f.ecRelation} onChange={set("ecRelation")} />
        <TextField label={t("personal.ecPhone")} value={f.ecPhone} onChange={set("ecPhone")} />
        {full && (
          <>
            <TextField label={t("personal.birthDate")} type="date" value={f.birthDate} onChange={set("birthDate")} />
            <TextField
              label={t("personal.nationality")}
              value={f.nationality}
              onChange={(e) => setF({ ...f, nationality: e.target.value.toUpperCase() })}
              maxLength={2}
              hint={t("personal.nationalityHint")}
            />
            <SelectField
              label={t("personal.gender")}
              value={f.gender}
              onChange={set("gender")}
              options={[{ value: "", label: "–" }, ...(["female", "male", "other"] as const).map((g) => ({ value: g, label: t(`gender.${g}`) }))]}
            />
            <SelectField
              label={t("personal.marital")}
              value={f.maritalStatus}
              onChange={set("maritalStatus")}
              options={[
                { value: "", label: "–" },
                ...(["single", "married", "divorced", "widowed"] as const).map((g) => ({ value: g, label: t(`marital.${g}`) })),
              ]}
            />
            <TextField
              label={t("personal.nationalId")}
              value={f.nationalId}
              onChange={set("nationalId")}
              mono
              inputMode="numeric"
              autoComplete="off"
              hint={p?.nationalId ? t("personal.nationalIdKeep", { masked: p.nationalId }) : undefined}
            />
          </>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- The record

export function RecordPage(ctx: Ctx & { id: string; part?: RecordPart }) {
  const { call, id, me, onChanged } = ctx;
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [person, reload] = useLoad<Employee>(call, `/api/v1/employees/${id}`);
  const [people] = useLoad<{ employees: Employee[] }>(call, can("editor") ? "/api/v1/employees" : null);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const self = me.employee?.id === id;
  const parts = person?.parts ?? [];
  const tabs: Array<{ value: RecordPart; label: string }> = [
    ...(["work", "personal", "pay", "documents", "leave"] as const).filter((p) => parts.includes(p)).map((p) => ({ value: p, label: t(`part.${p}`) })),
    ...(parts.includes("work") || can("editor") ? [{ value: "history" as const, label: t("part.history") }] : []),
    ...(self || can("admin") ? [{ value: "access" as const, label: t("part.access") }] : []),
  ];
  const wanted = ctx.part && tabs.some((x) => x.value === ctx.part) ? ctx.part : tabs[0]?.value;
  // Only a tab the person opens is kept: before the record loads, the tabs it allows are not known yet.
  const [part, setPart] = useState<RecordPart | undefined>(undefined);
  const shown = part && tabs.some((x) => x.value === part) ? part : wanted;
  if (person === null) return <EmptyState title={t("record.notFound")}>{t("record.notFoundDetail")}</EmptyState>;
  if (!person) return <PageHeader title={t("loading")} />;
  const s = statusOf(person, t, locale);
  const open = (p: RecordPart) => {
    setPart(p);
    window.history.replaceState(null, "", `/people/${person.id}/${p}`);
  };
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t("people.title"), href: "/people" }, { label: person.name }]}
        title={person.name}
        meta={<StatusBadge tone={s.tone}>{s.label}</StatusBadge>}
        description={[
          [person.position?.title, person.department?.name].filter(Boolean).join(", "),
          person.location?.name,
          person.manager ? t("record.reportsTo", { name: person.manager.name }) : t("record.reportsToNobody"),
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            <Button icon={<ArrowLeft />} onClick={() => window.location.assign("/people")}>
              {t("record.back")}
            </Button>
            {person.can.edit && (
              <Button icon={<Pencil />} onClick={() => setEditing(true)}>
                {t("record.edit")}
              </Button>
            )}
          </>
        }
      />
      {notice && <Notice>{notice}</Notice>}
      <div className="hr-record grid gap-2.5">
        <div className="flex min-w-0 flex-col gap-2.5">
          {tabs.length ? (
            <Tabs label={t("record.parts")} value={shown ?? "work"} onChange={open} items={tabs} />
          ) : (
            <Callout tone="info" title={t("record.directoryOnly")}>
              {t("record.directoryOnlyDetail")}
            </Callout>
          )}
          {shown === "work" && <WorkPart ctx={ctx} person={person} />}
          {shown === "personal" && <PersonalPart ctx={ctx} person={person} onChanged={reload} setNotice={setNotice} />}
          {shown === "pay" && <PayPart ctx={ctx} person={person} onChanged={reload} setNotice={setNotice} />}
          {shown === "documents" && <DocumentsPart ctx={ctx} person={person} setNotice={setNotice} />}
          {shown === "leave" && <LeavePart ctx={ctx} person={person} />}
          {shown === "history" && <HistoryPart call={call} person={person} />}
          {shown === "access" && <AccessPart call={call} person={person} />}
        </div>
        <div className="flex min-w-0 flex-col gap-2.5">
          <Panel title={t("record.directory")} description={t("record.directoryDetail")}>
            <div className="flex flex-col gap-2 text-xs">
              <span className="flex items-center gap-2">
                <Avatar name={person.name} />
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium text-fg">{person.name}</span>
                  <span className="truncate font-mono text-2xs text-fg-muted">{person.workEmail ?? "–"}</span>
                </span>
              </span>
              <dl className="hr-facts grid gap-x-2 gap-y-1">
                <Field label={t("people.department")}>{person.department?.name ?? "–"}</Field>
                <Field label={t("edit.position")}>{person.position?.title ?? "–"}</Field>
                <Field label={t("people.manager")}>
                  {person.manager ? <a href={`/people/${person.manager.id}`}>{person.manager.name}</a> : t("common.nobody")}
                </Field>
                <Field label={t("people.location")}>{person.location?.name ?? "–"}</Field>
                <Field label={t("people.started")}>{day(person.startDate, locale)}</Field>
                {person.reports > 0 && <Field label={t("record.reports")}>{num(person.reports, locale)}</Field>}
              </dl>
            </div>
          </Panel>
          {person.identity?.linked && (
            <Panel title={t("record.identity")}>
              <p className="m-0 flex flex-wrap items-center gap-2 text-xs text-fg">
                {person.identity.error ? (
                  <StatusBadge tone="danger">{t("identity.failing")}</StatusBadge>
                ) : person.identity.state === "active" ? (
                  <StatusBadge tone="success">{t("identity.inStep")}</StatusBadge>
                ) : person.identity.state === "disabled" ? (
                  <StatusBadge tone="neutral">{t("identity.off")}</StatusBadge>
                ) : (
                  <StatusBadge tone="info">{t("identity.scheduled")}</StatusBadge>
                )}
                {person.identity.error ??
                  (person.identity.state === "active"
                    ? t("identity.groups", { groups: identityGroups(ctx, person).join(", ") })
                    : person.identity.state === "disabled"
                      ? t("identity.offDetail")
                      : me.identity
                        ? t("identity.madeOn", { day: day(person.startDate, locale), time: me.identity.createAt })
                        : "")}
              </p>
            </Panel>
          )}
        </div>
      </div>
      {editing && (
        <EmployeeDialog
          ctx={ctx}
          people={people?.employees ?? []}
          current={person}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setNotice(t("record.saved"));
            reload();
            onChanged();
          }}
        />
      )}
    </>
  );
}

function identityGroups(ctx: Ctx, person: Employee) {
  const id = ctx.settings?.identity;
  const dep = ctx.departments.find((d) => d.id === person.department?.id);
  return [...(id?.departmentGroups !== false && dep ? [dep.identityGroup] : []), ...(id?.allGroups ?? [])];
}

const dl = "hr-fields grid gap-x-3 gap-y-1.5 text-sm";

function WorkPart({ ctx, person }: { ctx: Ctx; person: Employee }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const readers = useReaders(ctx);
  const w = person.work!;
  const years = yearsSince(w.serviceStart);
  const loc = ctx.settings?.locations.find((l) => l.id === person.location?.id);
  const week = loc?.workWeek ?? ctx.settings?.workWeek;
  return (
    <Panel title={t("part.work")} aria-label={t("part.work")}>
      <ReadBy>{t("readBy.line", { who: readers("work") })}</ReadBy>
      <dl className={dl}>
        <Field label={t("work.number")} mono>
          {w.number ?? "–"}
        </Field>
        <Field label={t("work.employment")}>{t(`employment.${w.employmentType}`)}</Field>
        <Field label={t("edit.startDate")}>{day(person.startDate, locale)}</Field>
        <Field label={t("edit.serviceStart")}>{t("work.serviceValue", { day: day(w.serviceStart, locale), count: years })}</Field>
        <Field label={t("work.probation")}>
          {!w.probationEnd
            ? t("work.noProbation")
            : w.probationEnd < today()
              ? t("work.probationEnded", { day: day(w.probationEnd, locale) })
              : t("work.probationEnds", { day: day(w.probationEnd, locale) })}
        </Field>
        <Field label={t("work.contract")}>
          {w.contract === "fixed" ? (w.contractEnd ? t("work.fixedEnds", { day: day(w.contractEnd, locale) }) : t("contract.fixed")) : t("contract.indefinite")}
        </Field>
        {week && <Field label={t("work.week")}>{weekText(week, locale)}</Field>}
        {w.endDate && (
          <Field label={t("work.endDate")}>
            {day(w.endDate, locale)}
            {w.endReason ? `, ${reasonText(t, w.endReason)}` : ""}
          </Field>
        )}
      </dl>
    </Panel>
  );
}

const REASONS = ["resignation", "end-of-contract", "dismissal", "retirement", "mutual"] as const;
export const reasonText = (t: T, r: string) => ((REASONS as readonly string[]).includes(r) ? t(`reason.${r as (typeof REASONS)[number]}`) : r);
export { REASONS };

/** [0, 1, 2, 3, 4] (Monday is 0) as "Mon, Tue, Wed, Thu, Fri" in the language. */
export function weekText(week: number[], locale: string) {
  return week.map((d) => new Date(Date.UTC(2026, 10, 2 + d)).toLocaleDateString(locale, { weekday: "short", timeZone: "UTC" })).join(", ");
}

function PersonalPart({ ctx, person, onChanged, setNotice }: { ctx: Ctx; person: Employee; onChanged: () => void; setNotice: (s: string) => void }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const readers = useReaders(ctx);
  const [whole, setWhole] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = person.personal;
  if (!p) return null;
  const reveal = () =>
    void ctx.call<{ nationalId: string | null }>(`/api/v1/employees/${person.id}/national-id`).then(
      (r) => setWhole(r.nationalId),
      (err: Error) => setError(err.message),
    );
  return (
    <Panel
      title={t("part.personal")}
      aria-label={t("part.personal")}
      description={t("personal.description")}
      actions={
        person.can.editContact && (
          <Button size="sm" icon={<Pencil />} onClick={() => setEditing(true)}>
            {person.can.edit ? t("personal.edit") : t("me.editContact")}
          </Button>
        )
      }
    >
      <ReadBy>{t("readBy.line", { who: readers("personal") })}</ReadBy>
      {error && <Callout tone="danger" title={error} className="mb-2" />}
      <dl className={dl}>
        <Field label={t("personal.nationalId")} mono>
          {p.nationalId ? (
            <span className="flex flex-wrap items-center gap-2">
              <span aria-live="polite">{whole ?? p.nationalId}</span>
              <Button size="xs" variant="ghost" icon={whole ? <EyeOff /> : <Eye />} onClick={() => (whole ? setWhole(null) : reveal())}>
                {whole ? t("personal.hide") : t("personal.show")}
              </Button>
              {whole && <span className="font-sans text-2xs text-fg-muted">{t("personal.shownLogged")}</span>}
            </span>
          ) : (
            "–"
          )}
        </Field>
        <Field label={t("personal.birthDate")}>{p.birthDate ? day(p.birthDate, locale) : "–"}</Field>
        <Field label={t("personal.gender")}>{p.gender ? t(`gender.${p.gender}`) : "–"}</Field>
        <Field label={t("personal.nationality")}>{p.nationality ? country(p.nationality, locale) : "–"}</Field>
        <Field label={t("personal.marital")}>{p.maritalStatus ? t(`marital.${p.maritalStatus}`) : "–"}</Field>
        <Field label={t("personal.phone")} mono>
          {p.phone ?? "–"}
        </Field>
        <Field label={t("personal.personalEmail")}>{p.personalEmail ?? "–"}</Field>
        <Field label={t("personal.address")}>{p.address ?? "–"}</Field>
        <Field label={t("personal.emergency")}>
          {p.emergencyContact ? [p.emergencyContact.name, p.emergencyContact.relation, p.emergencyContact.phone].filter(Boolean).join(", ") : "–"}
        </Field>
      </dl>
      {editing && (
        <PersonalDialog
          call={ctx.call}
          person={person}
          full={person.can.edit}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setWhole(null);
            setNotice(t("record.saved"));
            onChanged();
          }}
        />
      )}
    </Panel>
  );
}

function PayPart({ ctx, person, onChanged, setNotice }: { ctx: Ctx; person: Employee; onChanged: () => void; setNotice: (s: string) => void }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const readers = useReaders(ctx);
  const [pay, reload] = useLoad<{ pay: PayEntry[] }>(ctx.call, `/api/v1/employees/${person.id}/pay`);
  const [setting, setSetting] = useState(false);
  const [f, setF] = useState({
    from: today(),
    amount: "",
    currency: "TRY",
    period: "month",
    iban: person.pay?.iban ?? "",
    bankName: person.pay?.bankName ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const bank = person.pay;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (f.amount.trim())
        await ctx.call(`/api/v1/employees/${person.id}/pay`, {
          method: "POST",
          body: JSON.stringify({ from: f.from, amount: Number(f.amount.replace(/\./g, "").replace(",", ".")), currency: f.currency, period: f.period }),
        });
      if ((f.iban.trim() || null) !== (bank?.iban ?? null) || (f.bankName.trim() || null) !== (bank?.bankName ?? null))
        await ctx.call(`/api/v1/employees/${person.id}`, {
          method: "PATCH",
          body: JSON.stringify({ iban: f.iban.trim() || null, bankName: f.bankName.trim() || null }),
        });
      setSetting(false);
      setNotice(t("record.saved"));
      reload();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Panel
      title={t("part.pay")}
      aria-label={t("part.pay")}
      flush
      actions={
        person.can.edit && (
          <Button size="sm" icon={<Wallet />} onClick={() => setSetting(true)}>
            {t("pay.set")}
          </Button>
        )
      }
    >
      <div className="px-3 pt-2">
        <ReadBy>{t("readBy.line", { who: readers("pay") })}</ReadBy>
        <p className="mt-0 pb-2 text-sm">
          {bank?.iban ? (
            <>
              {t("pay.paidTo")} <span className="font-mono">{bank.iban.replace(/(.{4})/g, "$1 ").trim()}</span>
              {bank.bankName ? `, ${bank.bankName}` : ""}. {t("pay.payrollReads")}
            </>
          ) : (
            t("pay.noBank")
          )}
        </p>
      </div>
      <DataTable
        label={t("pay.overTime")}
        rows={pay?.pay ?? []}
        getRowId={(r) => r.id}
        minWidth={480}
        loading={pay === undefined}
        empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("pay.none")}</p>}
        columns={[
          { id: "from", header: t("pay.from"), sortValue: (r) => r.from, cell: (r) => day(r.from, locale) },
          {
            id: "gross",
            header: t("pay.gross"),
            align: "right",
            mono: true,
            cell: (r) => `${money(r.amount, r.currency, locale)}${r.period === "month" ? "" : ` / ${t(`pay.period.${r.period}`)}`}`,
          },
          { id: "by", header: t("pay.by"), cell: (r) => r.createdBy },
        ]}
      />
      {setting && (
        <Dialog
          open
          onOpenChange={(o) => !o && setSetting(false)}
          title={t("pay.setTitle", { name: person.name })}
          description={t("pay.setDetail")}
          onSubmit={(e) => void submit(e)}
          footer={
            <>
              <Button type="button" onClick={() => setSetting(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" variant="primary">
                {t("common.save")}
              </Button>
            </>
          }
        >
          {error && <Callout tone="danger" title={error} />}
          <div className="hr-form grid gap-3">
            <TextField label={t("pay.from")} type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
            <TextField label={t("pay.amount")} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} mono />
            <TextField label={t("pay.currency")} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} maxLength={3} />
            <SelectField
              label={t("pay.periodLabel")}
              value={f.period}
              onChange={(e) => setF({ ...f, period: e.target.value })}
              options={(["month", "hour", "year"] as const).map((x) => ({ value: x, label: t(`pay.period.${x}`) }))}
            />
            <TextField label="IBAN" value={f.iban} onChange={(e) => setF({ ...f, iban: e.target.value })} mono />
            <TextField label={t("pay.bank")} value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} />
          </div>
        </Dialog>
      )}
    </Panel>
  );
}

export function AddDocumentDialog({
  ctx,
  person,
  onClose,
  onAdded,
}: {
  ctx: Ctx;
  person: { id: string; name: string };
  onClose: () => void;
  onAdded: (d: Doc) => void;
}) {
  const t = useT();
  const [locale] = useLocalePreference();
  const kinds = ctx.me.documentKinds;
  const [kind, setKind] = useState(kinds[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [expires, setExpires] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const k = kinds.find((x) => x.id === kind);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || (k?.expires && !expires)) return;
    setBusy(true);
    setError(null);
    try {
      const content = await readBase64(file);
      const d = await ctx.call<Doc>(`/api/v1/employees/${person.id}/documents`, {
        method: "POST",
        body: JSON.stringify({ kind, name: file.name, contentType: file.type, content, expiresOn: k?.expires ? expires : null }),
      });
      onAdded(d);
    } catch (err) {
      setBusy(false);
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("documents.addTitle", { name: person.name })}
      onSubmit={(e) => void submit(e)}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !file || (!!k?.expires && !expires)}>
            {t("documents.add")}
          </Button>
        </>
      }
    >
      {error && <Callout tone="danger" title={error} />}
      <SelectField
        label={t("documents.kind")}
        value={kind}
        onChange={(e) => setKind(e.target.value)}
        options={kinds.map((x) => ({ value: x.id, label: words(x.name, locale) }))}
      />
      <label className="hr-drop flex items-center gap-2 rounded-md border border-dashed border-line-strong px-3 py-3 text-sm text-fg">
        <FileUp aria-hidden className="size-4 text-fg-muted" />
        <span className="grow">{file ? `${file.name}, ${size(file.size, locale)}` : t("documents.pick")}</span>
        <input
          type="file"
          accept="application/pdf,image/png,image/jpeg"
          aria-label={t("documents.pickLabel")}
          className="hr-file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      {k?.expires && (
        <TextField
          label={t("documents.expiresOn")}
          type="date"
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
          hint={t("documents.needsExpiry")}
          required
        />
      )}
    </Dialog>
  );
}

function DocumentsPart({ ctx, person, setNotice }: { ctx: Ctx; person: Employee; setNotice: (s: string) => void }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const readers = useReaders(ctx);
  const [docs, reload] = useLoad<{ documents: Doc[] }>(ctx.call, `/api/v1/employees/${person.id}/documents`);
  const [adding, setAdding] = useState(false);
  const canAdd = can("editor") || ctx.me.employee?.id === person.id;
  return (
    <Panel
      title={t("part.documents")}
      aria-label={t("part.documents")}
      flush
      actions={
        canAdd && (
          <Button size="sm" icon={<Upload />} onClick={() => setAdding(true)}>
            {t("documents.addButton")}
          </Button>
        )
      }
    >
      <div className="px-3 pt-2">
        <ReadBy>{t("readBy.lineDownload", { who: readers("documents") })}</ReadBy>
      </div>
      <DataTable
        label={t("documents.ofRecord")}
        rows={docs?.documents ?? []}
        getRowId={(d) => d.id}
        minWidth={560}
        loading={docs === undefined}
        empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("documents.none")}</p>}
        columns={[
          { id: "kind", header: t("documents.kind"), cell: (d) => words(d.kindName, locale) },
          {
            id: "file",
            header: t("documents.file"),
            cell: (d) => (
              <a href={`/api/v1/documents/${d.id}`} className="inline-flex items-center gap-1 font-mono text-xs" download>
                <Download aria-hidden className="size-3" />
                {d.name}
              </a>
            ),
          },
          { id: "added", header: t("documents.added"), sortValue: (d) => d.uploadedAt, cell: (d) => day(d.uploadedAt.slice(0, 10), locale) },
          {
            id: "expires",
            header: t("documents.expires"),
            cell: (d) =>
              d.expiresOn ? (
                <span className="flex items-center gap-1.5">
                  {day(d.expiresOn, locale)}
                  {d.expired ? (
                    <StatusBadge tone="danger">{t("documents.expired")}</StatusBadge>
                  ) : d.expiresSoon ? (
                    <StatusBadge tone="warning">{t("documents.soon")}</StatusBadge>
                  ) : null}
                </span>
              ) : (
                <span className="text-xs text-fg-muted">{t("documents.noExpiry")}</span>
              ),
          },
          ...(can("editor")
            ? [
                {
                  id: "act",
                  header: <span className="sr-only">{t("common.actions")}</span>,
                  label: t("common.actions"),
                  align: "right" as const,
                  width: "48px",
                  cell: (d: Doc) => (
                    <IconButton
                      size="xs"
                      label={t("documents.remove", { name: d.name })}
                      onClick={() => {
                        if (window.confirm(t("documents.removeConfirm", { name: d.name })))
                          void ctx.call(`/api/v1/documents/${d.id}`, { method: "DELETE" }).then(reload, () => {});
                      }}
                    >
                      <Trash2 />
                    </IconButton>
                  ),
                },
              ]
            : []),
        ]}
      />
      {adding && (
        <AddDocumentDialog
          ctx={ctx}
          person={person}
          onClose={() => setAdding(false)}
          onAdded={(d) => {
            setAdding(false);
            const k = ctx.me.documentKinds.find((x) => x.id === d.kind);
            setNotice(
              d.expiresOn && k
                ? t("documents.addedExpires", { kind: words(d.kindName, locale), days: k.warnDays })
                : t("documents.addedNotice", { kind: words(d.kindName, locale) }),
            );
            reload();
            ctx.onChanged();
          }}
        />
      )}
    </Panel>
  );
}

/** "14 days" with the band it comes from, as hr.yaml writes it. */
export function grantRule(t: T, g: Balance["grant"] | null | undefined) {
  if (!g || g.rule === "none") return t("grant.none");
  if (g.rule === "age") return t("grant.age");
  return g.to === null ? t("grant.from", { from: g.from ?? 0 }) : t("grant.band", { from: g.from ?? 0, to: g.to - 1 });
}

function LeavePart({ ctx, person }: { ctx: Ctx; person: Employee }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const readers = useReaders(ctx);
  const [balances] = useLoad<{ balances: Balance[] }>(ctx.call, `/api/v1/employees/${person.id}/balances`);
  const [requests] = useLoad<{ requests: LeaveRequest[] }>(ctx.call, `/api/v1/leave?scope=all&employee=${person.id}`);
  const annual = balances?.balances.find((b) => b.hasBalance);
  const dayCount = (n: number) => t("common.days", { count: n, n: num(n, locale) });
  return (
    <Panel title={t("part.leave")} aria-label={t("part.leave")} flush>
      <div className="px-3 pt-2">
        <ReadBy>{t("readBy.line", { who: readers("leave") })}</ReadBy>
        {annual && (
          <KpiGrid minWidth={150} className="pb-2">
            <KpiCard label={t("leave.left", { type: words(annual.name, locale) })} value={dayCount(annual.available ?? 0)} />
            <KpiCard label={t("leave.yearly")} value={dayCount(annual.grant?.days ?? 0)} unit={grantRule(t, annual.grant)} />
            <KpiCard
              label={t("leave.next")}
              value={annual.next ? day(annual.next.date, locale) : "–"}
              unit={annual.next ? dayCount(annual.next.days) : undefined}
            />
          </KpiGrid>
        )}
        {balances?.balances
          .filter((b) => !b.hasBalance && b.takenThisYear > 0)
          .map((b) => (
            <p key={b.type} className="mt-0 mb-1 text-xs text-fg-muted">
              {t("leave.takenThisYear", { type: words(b.name, locale), days: dayCount(b.takenThisYear) })}
            </p>
          ))}
      </div>
      <DataTable
        label={t("leave.ofRecord")}
        rows={requests?.requests ?? []}
        getRowId={(r) => r.id}
        minWidth={520}
        loading={requests === undefined}
        empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("leave.noRequests")}</p>}
        columns={[
          { id: "type", header: t("leave.type"), cell: (r) => words(r.typeName, locale) || t("leave.away") },
          { id: "dates", header: t("leave.dates"), sortValue: (r) => r.startDate, cell: (r) => <a href={`/leave/${r.id}`}>{leaveDates(r, locale, t)}</a> },
          { id: "days", header: t("leave.days"), align: "right", mono: true, cell: (r) => num(r.days, locale) },
          { id: "state", header: t("leave.state"), cell: (r) => <StateBadge r={r} me={ctx.me} /> },
        ]}
      />
    </Panel>
  );
}

function HistoryPart({ call, person }: { call: Call; person: Employee }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [h] = useLoad<{ history: HistoryEntry[] }>(call, `/api/v1/employees/${person.id}/history`);
  return (
    <Panel title={t("part.history")} aria-label={t("part.history")} description={t("history.description")} flush>
      <DataTable
        label={t("history.label")}
        rows={(h?.history ?? []).map((x, i) => ({ ...x, key: String(i) }))}
        getRowId={(x) => x.key}
        minWidth={620}
        loading={h === undefined}
        empty={<p className="px-3 py-3 text-sm text-fg-muted">{h === null ? t("common.failed") : t("history.none")}</p>}
        columns={[
          { id: "at", header: t("history.when"), cell: (x) => when(x.at, locale) },
          { id: "who", header: t("history.by"), cell: (x) => x.by },
          { id: "field", header: t("history.field"), cell: (x) => fieldName(t, x.field) },
          { id: "from", header: t("history.was"), cell: (x) => <span className="text-fg-muted">{shownValue(t, x.field, x.from, locale)}</span> },
          { id: "to", header: t("history.now"), cell: (x) => shownValue(t, x.field, x.to, locale) },
        ]}
      />
    </Panel>
  );
}

const FIELDS = [
  "firstName",
  "lastName",
  "preferredName",
  "workEmail",
  "department",
  "position",
  "manager",
  "location",
  "startDate",
  "number",
  "employmentType",
  "serviceStart",
  "probationEnd",
  "contract",
  "contractEnd",
  "endDate",
  "endReason",
  "birthDate",
  "gender",
  "maritalStatus",
  "nationalId",
  "nationality",
  "phone",
  "personalEmail",
  "address",
  "emergencyContact",
  "iban",
  "bankName",
  "salary",
  "document",
] as const;
export const fieldName = (t: T, f: string) => ((FIELDS as readonly string[]).includes(f) ? t(`field.${f as (typeof FIELDS)[number]}`) : f);

function shownValue(t: T, field: string, v: string | null, locale: string) {
  if (v === null || v === "") return "–";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return day(v, locale);
  if (field === "employmentType" && (EMPLOYMENT as readonly string[]).includes(v)) return t(`employment.${v as (typeof EMPLOYMENT)[number]}`);
  if (field === "contract" && (v === "fixed" || v === "indefinite")) return t(`contract.${v}`);
  if (field === "endReason") return reasonText(t, v);
  if (field === "emergencyContact") {
    try {
      const c = JSON.parse(v) as { name: string; relation: string | null; phone: string };
      return [c.name, c.relation, c.phone].filter(Boolean).join(", ");
    } catch {
      return v;
    }
  }
  return v;
}

function AccessPart({ call, person }: { call: Call; person: Employee }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [log] = useLoad<{ entries: Look[] }>(call, `/api/v1/employees/${person.id}/access-log`);
  return (
    <Panel title={t("part.access")} aria-label={t("part.access")} description={t("access.description")} flush>
      <DataTable
        label={t("access.label")}
        rows={(log?.entries ?? []).map((x, i) => ({ ...x, key: String(i) }))}
        getRowId={(x) => x.key}
        minWidth={620}
        loading={log === undefined}
        empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("access.none")}</p>}
        columns={[
          { id: "at", header: t("history.when"), cell: (x) => when(x.at, locale) },
          { id: "who", header: t("access.who"), cell: (x) => x.by },
          { id: "as", header: t("access.as"), cell: (x) => <Badge>{asText(t, x.as)}</Badge> },
          { id: "what", header: t("access.what"), cell: (x) => lookText(t, x, locale) },
        ]}
      />
    </Panel>
  );
}

const AS = ["self", "manager", "viewer", "editor", "admin"] as const;
export const asText = (t: T, as: string) => ((AS as readonly string[]).includes(as) ? t(`as.${as as (typeof AS)[number]}`) : as);

/** "record: work, pay", "Payroll, November", "the whole T.C. kimlik no" and so on, in the language. */
export function lookText(t: T, l: Look, locale: string) {
  const parts = l.parts.map((p) => t(`part.${p as Part}`).toLocaleLowerCase(locale)).join(", ");
  if (l.what === "national-id") return t("access.nationalId");
  if (l.what.startsWith("payroll:")) return t("access.payroll", { month: monthName(l.what.slice(8), locale), parts });
  if (l.what.startsWith("document:")) return t("access.download");
  const what = (["record", "history", "pay", "documents", "leave", "balances"] as const).find((x) => x === l.what);
  return what ? t(`access.kind.${what}`, { parts }) : `${l.what}: ${parts}`;
}
const monthName = (m: string, locale: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
