import {
  AppShell,
  Avatar,
  Badge,
  BarList,
  BrandProvider,
  Button,
  Callout,
  EmptyState,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  StatusBadge,
  toLocale,
  usePath,
  useLocalePreference,
  useThemePreference,
  type ProductId,
  type Tone,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import {
  CalendarDays,
  FileText,
  House,
  IdCard,
  KeyRound,
  ListChecks,
  LogIn,
  LogOut,
  Network,
  Plug,
  Settings as SettingsIcon,
  UserRound,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Absence, Department, Employee, ExpiringDoc, LeaveRequest, Me, ProductLink, Settings, Task, Upcoming } from "./api.ts";
import { day, num, today, useApi, useLoad, weekday, words, type Call } from "./common.tsx";
import { useT } from "./i18n.ts";
import { LeavePage, leaveDates, type LeaveTab } from "./leave.tsx";
import { DocumentsPage, IntegrationsPage, JoiningPage, MyRecordPage, OrgChartPage, SettingsFilePage } from "./pages.tsx";
import { PeoplePage, RecordPage, type RecordPart } from "./people.tsx";

const PAGES = ["people", "org", "leave", "joining", "documents", "me", "integrations", "settings", "account", "members", "signin", "tokens"] as const;
type Page = (typeof PAGES)[number];
type Route =
  { page: "home" | Exclude<Page, "leave"> } | { page: "record"; id: string; part?: RecordPart } | { page: "leave"; tab?: LeaveTab; request?: string };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["home", ...PAGES];
const LEAVE_TABS = ["approve", "requests", "away", "balances"] as const;
const PARTS = ["work", "personal", "pay", "documents", "leave", "history", "access"] as const;

function parseRoute(path: string): Route {
  const [page, id, part] = path.replace(/^\//, "").split("/").map(decodeURIComponent);
  if (page === "people" && id) return { page: "record", id, part: (PARTS as readonly string[]).includes(part ?? "") ? (part as RecordPart) : undefined };
  if (page === "leave")
    return id ? ((LEAVE_TABS as readonly string[]).includes(id) ? { page: "leave", tab: id as LeaveTab } : { page: "leave", request: id }) : { page: "leave" };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as Exclude<Page, "leave"> };
  return { page: "home" };
}

export interface Ctx {
  call: Call;
  me: Me;
  /** The settings file as applied: for HR (viewer and above) only. */
  settings: Settings | null;
  departments: Department[];
  /** Counts in the menu and the record lists may have changed. */
  onChanged: () => void;
}

// ---------------------------------------------------------------- Home

const KIND_TONE: Record<Upcoming["kind"], Tone> = {
  start: "info",
  end: "warning",
  "probation-end": "info",
  "contract-end": "warning",
  anniversary: "neutral",
  "document-expires": "warning",
};

function HomePage({ call, me }: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const now = today();
  const [people] = useLoad<{ employees: Employee[] }>(call, "/api/v1/employees");
  const [upcoming] = useLoad<{ events: Upcoming[] }>(call, "/api/v1/upcoming?days=60");
  const [approvals] = useLoad<{ requests: LeaveRequest[] }>(call, "/api/v1/leave?scope=approvals");
  const [tasks] = useLoad<{ tasks: Task[] }>(call, "/api/v1/tasks");
  const [away] = useLoad<{ absences: Absence[] }>(call, `/api/v1/absences?from=${now}&to=${now}`);
  const [expiring] = useLoad<{ documents: ExpiringDoc[] }>(call, "/api/v1/expiring-documents");
  const all = people?.employees ?? [];
  const working = all.filter((e) => e.status === "active");
  const joining = all.filter((e) => e.status === "upcoming").sort((a, b) => a.startDate.localeCompare(b.startDate));
  const leaving = (upcoming?.events ?? []).filter((u) => u.kind === "end");
  const locations = new Set(working.map((e) => e.location?.id).filter(Boolean)).size;
  const expired = (expiring?.documents ?? []).filter((d) => d.expired).length;
  const byDept = new Map<string, { label: string; value: number }>();
  for (const e of working) {
    const key = e.department?.id ?? "-";
    const d = byDept.get(key) ?? { label: e.department?.name ?? t("common.noDepartment"), value: 0 };
    d.value++;
    byDept.set(key, d);
  }
  const upcomingText = (u: Upcoming) => {
    const n = u.employee.name;
    switch (u.kind) {
      case "start":
        return me.identity ? t("home.event.startIdentity", { name: n, time: me.identity.createAt }) : t("home.event.start", { name: n });
      case "end":
        return me.identity ? t("home.event.endIdentity", { name: n, time: me.identity.disableAt }) : t("home.event.end", { name: n });
      case "probation-end":
        return t("home.event.probation", { name: n });
      case "contract-end":
        return t("home.event.contract", { name: n });
      case "anniversary":
        return t("home.event.anniversary", { name: n, years: Number(u.detail ?? 0) });
      case "document-expires":
        return t("home.event.document", { name: n, document: u.detail ?? "" });
    }
  };
  const waiting = [...(approvals?.requests ?? [])];
  return (
    <>
      <PageHeader title={t("home.title")} description={t("home.description", { name: me.member.name })} />
      <KpiGrid minWidth={160} className="mb-2.5">
        <KpiCard
          label={t("home.working")}
          value={people ? String(working.length) : "–"}
          delta={{ label: t("home.locations", { count: locations }), intent: "neutral" }}
        />
        <KpiCard
          label={t("home.joining")}
          value={people ? String(joining.length) : "–"}
          delta={joining[0] ? { label: `${joining[0].name}, ${weekday(joining[0].startDate, locale)}`, intent: "neutral" } : undefined}
        />
        <KpiCard
          label={t("home.leaving")}
          value={upcoming ? String(leaving.length) : "–"}
          delta={leaving[0] ? { label: `${leaving[0].employee.name}, ${weekday(leaving[0].date, locale)}`, intent: "neutral" } : undefined}
        />
        <KpiCard
          label={t("home.toApprove")}
          value={String(me.waitingForMe)}
          tone={me.waitingForMe ? "warning" : undefined}
          delta={{ label: t("home.toApproveDetail"), intent: "neutral" }}
          href="/leave/approve"
        />
        <KpiCard
          label={t("home.expiring")}
          value={expiring ? String(expiring.documents.length) : "–"}
          tone={expiring?.documents.length ? "warning" : undefined}
          delta={expired ? { label: t("home.expired", { count: expired }), intent: "bad" } : undefined}
          href="/documents"
        />
      </KpiGrid>
      <div className="hr-side grid gap-2.5">
        <div className="flex min-w-0 flex-col gap-2.5">
          <Panel title={t("home.waiting")} aria-label={t("home.waiting")}>
            {!waiting.length && !tasks?.tasks.length ? (
              <p className="m-0 text-sm text-fg-muted">{t("home.nothingWaits")}</p>
            ) : (
              <ul aria-label={t("home.yourTasks")} className="hr-list flex flex-col gap-2 text-sm">
                {waiting.map((r) => {
                  const step = r.steps.findIndex((s) => !s.decision) + 1;
                  return (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                      <a href={`/leave/${r.id}`}>
                        {t("home.asksFor", {
                          name: r.employee.name,
                          type: words(r.typeName, locale),
                          dates: leaveDates(r, locale, t),
                          days: t("common.days", { count: r.days, n: num(r.days, locale) }),
                        })}
                      </a>
                      <StatusBadge tone="warning">{t("home.step", { n: step, of: r.steps.length })}</StatusBadge>
                    </li>
                  );
                })}
                {tasks?.tasks.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center justify-between gap-2">
                    <a href="/joining">
                      {x.employee ? `${x.employee.name}: ` : ""}
                      {words(x.text, locale)}
                    </a>
                    <StatusBadge tone={x.overdue ? "danger" : "neutral"}>{t("home.due", { day: weekday(x.dueDate, locale) })}</StatusBadge>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title={t("home.comingUp")} description={t("home.comingUpDetail")} flush>
            {upcoming?.events.length ? (
              <ul aria-label={t("home.comingUp")} className="hr-list flex flex-col">
                {upcoming.events.map((u, i) => (
                  <li
                    key={`${u.kind}-${u.employee.id}-${u.date}-${i}`}
                    className="flex items-center gap-3 border-b border-subtle px-3 py-2 text-sm last:border-0"
                  >
                    <span className="hr-when shrink-0 text-xs text-fg-muted">{weekday(u.date, locale)}</span>
                    <a href={`/people/${u.employee.id}`} className="min-w-0 grow text-fg">
                      {upcomingText(u)}
                    </a>
                    <Badge tone={KIND_TONE[u.kind]}>{t(`home.kind.${u.kind}`)}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 px-3 py-3 text-sm text-fg-muted">{upcoming === undefined ? t("loading") : t("home.nothingComing")}</p>
            )}
          </Panel>
        </div>
        <div className="flex min-w-0 flex-col gap-2.5">
          <Panel title={t("home.awayToday")} description={weekday(now, locale)}>
            {away?.absences.length ? (
              <ul aria-label={t("home.awayToday")} className="hr-list flex flex-col gap-2 text-sm">
                {away.absences.map((a) => (
                  <li key={a.id} className="flex items-center gap-2">
                    <Avatar name={a.employee.name} size="sm" />
                    <span className="flex min-w-0 flex-col">
                      <a href={`/people/${a.employee.id}`} className="truncate text-fg">
                        {a.employee.name}
                      </a>
                      <span className="text-2xs text-fg-muted">
                        {a.typeName
                          ? t("home.awayType", { type: words(a.typeName, locale), until: day(a.endDate, locale) })
                          : t("home.awayUntil", { until: day(a.endDate, locale) })}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-sm text-fg-muted">{t("home.nobodyAway")}</p>
            )}
          </Panel>
          <Panel title={t("home.byDepartment")}>
            {byDept.size ? (
              <BarList
                label={t("home.byDepartment")}
                items={[...byDept].map(([id, d]) => ({ id, label: d.label, value: d.value })).sort((a, b) => b.value - a.value)}
              />
            ) : (
              <p className="m-0 text-sm text-fg-muted">{t("home.nobodyYet")}</p>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function AuthSettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("auth.adminsOnly")}>{t("auth.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`auth.${page}`)}
        description={t(`auth.${page}Detail`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("auth.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me: auth, can } = useAuth();
  const account = useAccountMenu();
  const route = parseRoute(usePath());
  const [me, setMe] = useState<Me>();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [expiring, setExpiring] = useState(0);
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();
  const hr = can("viewer");

  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) => setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "hr" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => {
    void call<Me>("/api/v1/me").then(setMe, () => {});
    void call<{ departments: Department[] }>("/api/v1/departments").then(
      (r) => setDepartments(r.departments),
      () => {},
    );
    void call<{ documents: ExpiringDoc[] }>("/api/v1/expiring-documents").then(
      (r) => setExpiring(r.documents.length),
      () => {},
    );
    if (hr) void call<Settings>("/api/v1/settings").then(setSettings, () => {});
  }, [call, hr]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 60_000);
    return () => clearInterval(timer);
  }, [reload]);

  // The search window (Cmd+K) finds people by name or work email.
  const onSearch = useMemo(
    () => async (q: string, signal: AbortSignal) => {
      const r = await call<{ employees: Employee[] }>(`/api/v1/employees?${new URLSearchParams({ q })}`, { signal });
      return r.employees.slice(0, 8).map((e) => ({
        id: e.id,
        label: e.name,
        detail: [e.position?.title, e.department?.name].filter(Boolean).join(", "),
        kind: msg("search.person"),
        icon: UserRound,
        href: `/people/${e.id}`,
      }));
    },
    [call, msg],
  );

  const nav = [
    { id: "home", label: msg("nav.home"), icon: House },
    { id: "people", label: msg("nav.people"), icon: Users },
    { id: "org", label: msg("nav.org"), icon: Network },
    { id: "leave", label: msg("nav.leave"), icon: CalendarDays, count: me?.waitingForMe || undefined },
    { id: "joining", label: msg("nav.joining"), icon: ListChecks, count: me?.tasks || undefined },
    { id: "documents", label: msg("nav.documents"), icon: FileText, count: expiring || undefined },
    ...(me?.employee ? [{ id: "me", label: msg("nav.me"), icon: IdCard }] : []),
  ];
  const footerNav = [
    ...(hr
      ? [
          { id: "integrations", label: msg("nav.integrations"), icon: Plug },
          { id: "settings", label: msg("nav.settings"), icon: SettingsIcon },
        ]
      : []),
    ...(can("admin")
      ? [
          { id: "members", label: msg("nav.members"), icon: Users },
          { id: "signin", label: msg("nav.signIn"), icon: LogIn },
          { id: "tokens", label: msg("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("nav.account"), icon: UserRound },
  ];
  const active = route.page === "record" ? (me?.employee?.id === route.id ? "me" : "people") : route.page;
  const roleName = msg(`roles.${(["owner", "admin", "editor", "viewer", "user"].includes(auth.user.role) ? auth.user.role : "user") as "user"}`);
  const ctx = me && { call, me, settings, departments, onChanged: reload };

  return (
    <AppShell
      product="hr"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      user={{ name: auth.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {settings?.file?.error && route.page !== "settings" && (
        <Callout tone="danger" title={msg("file.notApplied")} className="mb-2.5">
          {settings.file.error}
        </Callout>
      )}
      {route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
        <AuthSettingsPage page={route.page} />
      ) : !ctx ? (
        <PageHeader title={msg("loading")} />
      ) : route.page === "people" ? (
        <PeoplePage {...ctx} />
      ) : route.page === "record" ? (
        <RecordPage key={route.id} {...ctx} id={route.id} part={route.part} />
      ) : route.page === "org" ? (
        <OrgChartPage {...ctx} />
      ) : route.page === "leave" ? (
        <LeavePage key={route.request ?? route.tab ?? "leave"} {...ctx} tab={route.tab} request={route.request} />
      ) : route.page === "joining" ? (
        <JoiningPage {...ctx} />
      ) : route.page === "documents" ? (
        <DocumentsPage {...ctx} />
      ) : route.page === "me" ? (
        <MyRecordPage {...ctx} />
      ) : route.page === "integrations" ? (
        hr ? (
          <IntegrationsPage {...ctx} />
        ) : (
          <EmptyState title={msg("auth.hrOnly")} />
        )
      ) : route.page === "settings" ? (
        ctx.settings ? (
          <SettingsFilePage {...ctx} settings={ctx.settings} />
        ) : (
          <EmptyState title={hr ? msg("loading") : msg("auth.hrOnly")} />
        )
      ) : (
        <HomePage {...ctx} />
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy HR">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
