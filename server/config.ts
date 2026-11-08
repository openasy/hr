// HR's settings, from one YAML file (HR_CONFIG): the time zone and working week, locations, public holidays, leave
// types and their rules, approval rules, document kinds, the joining and leaving checklists, who reads which part of a
// record, how long records are kept, the mail server and the link to Identity. As in the other products, the file is
// the only way in: no screen or API route changes these. It is applied whole or not at all, read again within a minute
// of a change, and a file with a mistake leaves the last good version in place. People and everything about them are
// kept in the database.
//
// Without a file, HR runs on Türkiye's defaults: a Monday to Friday week, the national and religious holidays, annual
// leave by seniority as İş Kanunu md. 53 sets it, and the excuse, maternity, sick and unpaid leave the law knows.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";
import { DAY_NAMES, isDay, validTimeZone } from "./dates.ts";
import { BUILT_IN_YEARS, hasBayram, type Holiday, type Words3 } from "./holidays.ts";

export const LANGUAGES = ["en", "de", "tr"] as const;
export type Language = (typeof LANGUAGES)[number];

export interface LeaveType {
  id: string;
  name: Words3;
  paid: boolean;
  /** working_days leaves out the week's days off and public holidays; calendar_days counts every day. */
  counts: "working_days" | "calendar_days";
  /** How days are granted: on each anniversary of service, each 1 January, or not at all (no balance). */
  accrual: "anniversary" | "yearly" | "none";
  /** Days granted, by completed years of service: [[1, 14], [6, 20], [15, 26]]. One entry [0, n] for a flat n. */
  bySeniority: Array<[number, number]>;
  /** At least this many days for the young and the old (İş Kanunu md. 53: 20 days at 18 or younger, 50 or older). */
  atLeast: { days: number; ageUpTo: number | null; ageFrom: number | null } | null;
  /** In a yearly accrual, the first year's days in proportion to the months worked. */
  prorate: boolean;
  /** Days kept into the next period: null for all of them. */
  carryOver: number | null;
  /** How far below zero a balance may go, in days. */
  advance: number;
  /** The most days one request may take, or null. */
  perRequest: number | null;
  halfDays: boolean;
  /** A document kind the request should carry, such as a health report. */
  document: string | null;
  approval: string;
  /** Colleagues see this type by name; otherwise only that the person is away (sick leave is health data). */
  shownToColleagues: boolean;
}

export type Step = { kind: "manager" } | { kind: "second_manager" } | { kind: "hr" } | { kind: "member"; email: string };
export interface ApprovalRule {
  id: string;
  steps: Step[];
}

export interface DocumentKind {
  id: string;
  name: Words3;
  expires: boolean;
  /** Days before expiry that HR is told. */
  warnDays: number;
}

export type Who = "hr" | "manager" | "employee" | { email: string };
export interface ChecklistTask {
  id: string;
  text: Words3;
  who: Who;
  /** Days from the start or end date: -5 is five days before. */
  due: number;
}
export interface Checklist {
  id: string;
  name: Words3;
  on: "start" | "end";
  tasks: ChecklistTask[];
}

export const GROUPS = ["work", "personal", "pay", "documents", "leave"] as const;
export type Group = (typeof GROUPS)[number];
export type Reader = "self" | "manager" | "viewer" | "editor";

export interface Location {
  id: string;
  name: string;
  /** Monday is 0. */
  workWeek: number[];
}

export interface Config {
  timeZone: string;
  language: Language;
  workWeek: number[];
  locations: Location[];
  holidays: { country: "tr" | "none"; add: Holiday[]; remove: string[] };
  leaveTypes: LeaveType[];
  approvals: ApprovalRule[];
  documents: DocumentKind[];
  checklists: Checklist[];
  /** Who reads each part of a record, besides admins and owners, who read all of it. */
  access: Record<Group, Reader[]>;
  retention: { afterLeavingDays: number; accessLogDays: number };
  notify: { hr: string[] };
  mail: { host: string; port: number; security: "starttls" | "tls" | "none"; user: string | null; password: string; from: string } | null;
  identity: {
    url: string;
    token: string;
    /** Minutes after midnight, in time_zone, on the day the account is made: createDaysBefore days before the start. */
    createAt: number;
    createDaysBefore: number;
    /** Minutes after midnight on the end date when the account is turned off. */
    disableAt: number;
    departmentGroups: boolean;
    /** Groups everyone working is in, such as Employees. */
    allGroups: string[];
  } | null;
}

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const TOP = [
  "time_zone",
  "language",
  "work_week",
  "locations",
  "holidays",
  "leave_types",
  "approvals",
  "documents",
  "checklists",
  "access",
  "retention",
  "notify",
  "mail",
  "identity",
];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function keys(v: Record<string, unknown>, at: string, allowed: string[]) {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${at}: unknown ${extra.join(", ")}; it takes ${allowed.join(", ")}.`);
}

function text(v: unknown, at: string, max = 80): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${at} is a text of 1 to ${max} characters.`);
  return v.trim();
}

/** A text the same in every language, or { en, de, tr }; a language left out takes the English. */
function words(v: unknown, at: string, max = 120): Words3 {
  if (isObj(v)) {
    keys(v, at, [...LANGUAGES]);
    const en = text(v.en ?? v.tr ?? v.de, `${at}.en`, max);
    return { en, de: v.de === undefined ? en : text(v.de, `${at}.de`, max), tr: v.tr === undefined ? en : text(v.tr, `${at}.tr`, max) };
  }
  const s = text(v, at, max);
  return { en: s, de: s, tr: s };
}

function env(v: unknown, at: string): string {
  if (typeof v !== "string" || !ENV.test(v))
    throw new Error(`${at} is the name of an environment variable, such as HR_IDENTITY_TOKEN, never the secret itself.`);
  return v;
}

function bool(v: unknown, at: string, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") throw new Error(`${at} is true or false.`);
  return v;
}

function count(v: unknown, at: string, max: number, half = false): number {
  const n = typeof v === "string" ? Number(v.replace(/d$/, "")) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > max || (half ? (n * 2) % 1 !== 0 : n % 1 !== 0))
    throw new Error(`${at} is a number of days from 0 to ${max}${half ? ", in halves" : ""}.`);
  return n;
}

/** 30d, 8w, 10y: a span in days. */
function span(v: unknown, at: string, allowNegative = false): number {
  const m = /^(-?\d{1,4})\s*([dwy])$/.exec(String(v ?? "").trim());
  if (!m || (!allowNegative && m[1]!.startsWith("-"))) throw new Error(`${at} is a span such as ${allowNegative ? "-5d, 0d or 2w" : "30d, 8w or 10y"}.`);
  return Number(m[1]) * { d: 1, w: 7, y: 365 }[m[2] as "d" | "w" | "y"];
}

function time(v: unknown, at: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(v ?? ""));
  if (!m) throw new Error(`${at} is a time such as 07:00.`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function email(v: unknown, at: string): string {
  if (typeof v !== "string" || !EMAIL.test(v.trim()) || v.length > 254) throw new Error(`${at} is an email address.`);
  return v.trim().toLowerCase();
}

function baseUrl(raw: unknown, at: string): string {
  const url = typeof raw === "string" ? URL.parse(raw.trim()) : null;
  const inside = url && (/^(localhost|127\.0\.0\.1)$/.test(url.hostname) || !url.hostname.includes("."));
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && inside)) || url.search || url.hash)
    throw new Error(`${at} is an https:// address, such as https://identity.example.com (http:// only for a host without dots, such as http://identity:8080).`);
  return url.origin + url.pathname.replace(/\/$/, "");
}

function week(v: unknown, at: string): number[] {
  if (!Array.isArray(v) || !v.length) throw new Error(`${at} is a list of days, such as [mon, tue, wed, thu, fri].`);
  const out = new Set<number>();
  for (const d of v) {
    const i = DAY_NAMES.indexOf(String(d).toLowerCase() as (typeof DAY_NAMES)[number]);
    if (i < 0) throw new Error(`${at}: ${String(d)} is not a day; write mon to sun.`);
    out.add(i);
  }
  return [...out].sort();
}

const tr = (en: string, de: string, t: string): Words3 => ({ en, de, tr: t });

/** Türkiye's leave, as the law sets it; what the file gives replaces this list. */
export const DEFAULT_LEAVE: LeaveType[] = [
  {
    id: "annual",
    name: tr("Annual leave", "Jahresurlaub", "Yıllık izin"),
    paid: true,
    counts: "working_days",
    accrual: "anniversary",
    // İş Kanunu md. 53: 14 days up to five years, 20 days over five and under fifteen, 26 days from fifteen.
    bySeniority: [
      [1, 14],
      [6, 20],
      [15, 26],
    ],
    atLeast: { days: 20, ageUpTo: 18, ageFrom: 50 },
    prorate: false,
    carryOver: null,
    advance: 0,
    perRequest: null,
    halfDays: true,
    document: null,
    approval: "standard",
    shownToColleagues: true,
  },
  ...(
    [
      ["marriage", tr("Marriage leave", "Sonderurlaub: Heirat", "Evlilik izni"), 3],
      ["bereavement", tr("Bereavement leave", "Sonderurlaub: Trauerfall", "Ölüm izni"), 3],
      ["paternity", tr("Paternity leave", "Vaterschaftsurlaub", "Babalık izni"), 5],
      ["adoption", tr("Adoption leave", "Sonderurlaub: Adoption", "Evlat edinme izni"), 3],
    ] as const
  ).map(([id, name, days]): LeaveType => ({
    id,
    name,
    paid: true,
    counts: "working_days",
    accrual: "none",
    bySeniority: [],
    atLeast: null,
    prorate: false,
    carryOver: null,
    advance: 0,
    perRequest: days,
    halfDays: false,
    document: null,
    approval: "standard",
    shownToColleagues: true,
  })),
  {
    id: "maternity",
    name: tr("Maternity leave", "Mutterschutz", "Doğum izni"),
    paid: false,
    counts: "calendar_days",
    accrual: "none",
    bySeniority: [],
    atLeast: null,
    prorate: false,
    carryOver: null,
    advance: 0,
    // İş Kanunu md. 74: sixteen weeks, eighteen for more than one child.
    perRequest: 126,
    halfDays: false,
    document: "health-report",
    approval: "hr",
    shownToColleagues: false,
  },
  {
    id: "sick",
    name: tr("Sick leave", "Krankheit", "Hastalık izni (rapor)"),
    paid: false,
    counts: "calendar_days",
    accrual: "none",
    bySeniority: [],
    atLeast: null,
    prorate: false,
    carryOver: null,
    advance: 0,
    perRequest: null,
    halfDays: false,
    document: "health-report",
    approval: "hr",
    shownToColleagues: false,
  },
  {
    id: "unpaid",
    name: tr("Unpaid leave", "Unbezahlter Urlaub", "Ücretsiz izin"),
    paid: false,
    counts: "working_days",
    accrual: "none",
    bySeniority: [],
    atLeast: null,
    prorate: false,
    carryOver: null,
    advance: 0,
    perRequest: null,
    halfDays: true,
    document: null,
    approval: "standard",
    shownToColleagues: true,
  },
];

const DEFAULT_APPROVALS: ApprovalRule[] = [
  { id: "standard", steps: [{ kind: "manager" }, { kind: "hr" }] },
  { id: "manager", steps: [{ kind: "manager" }] },
  { id: "hr", steps: [{ kind: "hr" }] },
  { id: "none", steps: [] },
];

const DEFAULT_DOCUMENTS: DocumentKind[] = [
  { id: "contract", name: tr("Employment contract", "Arbeitsvertrag", "İş sözleşmesi"), expires: false, warnDays: 30 },
  { id: "id-copy", name: tr("ID copy", "Ausweiskopie", "Kimlik fotokopisi"), expires: true, warnDays: 30 },
  { id: "health-report", name: tr("Health report", "Ärztliches Attest", "Sağlık raporu"), expires: false, warnDays: 30 },
  { id: "work-permit", name: tr("Work permit", "Arbeitserlaubnis", "Çalışma izni"), expires: true, warnDays: 60 },
  { id: "certificate", name: tr("Certificate", "Zertifikat", "Sertifika"), expires: true, warnDays: 30 },
  { id: "other", name: tr("Other", "Sonstiges", "Diğer"), expires: false, warnDays: 30 },
];

const DEFAULT_CHECKLISTS: Checklist[] = [
  {
    id: "onboarding",
    name: tr("Joining", "Eintritt", "İşe giriş"),
    on: "start",
    tasks: [
      {
        id: "sgk",
        text: tr("Register with SGK before the first day", "Vor dem ersten Tag bei der SGK anmelden", "İlk günden önce SGK işe giriş bildirgesini ver"),
        who: "hr",
        due: -1,
      },
      { id: "contract", text: tr("Sign the contract", "Vertrag unterschreiben", "Sözleşmeyi imzala"), who: "hr", due: 0 },
      {
        id: "welcome",
        text: tr("Welcome them and plan the first week", "Begrüßen und die erste Woche planen", "Karşıla, ilk haftayı planla"),
        who: "manager",
        due: 0,
      },
      {
        id: "details",
        text: tr(
          "Check your personal details and bank account",
          "Persönliche Angaben und Bankkonto prüfen",
          "Kişisel bilgilerini ve banka hesabını kontrol et",
        ),
        who: "employee",
        due: 3,
      },
    ],
  },
  {
    id: "offboarding",
    name: tr("Leaving", "Austritt", "İşten çıkış"),
    on: "end",
    tasks: [
      {
        id: "handover",
        text: tr("Hand over open work", "Offene Arbeit übergeben", "Açık işleri devret"),
        who: "manager",
        due: -3,
      },
      {
        id: "equipment",
        text: tr("Collect the laptop, badge and keys", "Laptop, Ausweis und Schlüssel einsammeln", "Bilgisayarı, kartı ve anahtarları teslim al"),
        who: "manager",
        due: 0,
      },
      {
        id: "sgk",
        text: tr(
          "Report the leaving to SGK within 10 days",
          "Austritt innerhalb von 10 Tagen der SGK melden",
          "SGK işten ayrılış bildirgesini 10 gün içinde ver",
        ),
        who: "hr",
        due: 10,
      },
      {
        id: "final-pay",
        text: tr(
          "Pay the final salary and unused annual leave",
          "Letztes Gehalt und offenen Jahresurlaub auszahlen",
          "Son maaşı ve kullanılmayan yıllık izin ücretini öde",
        ),
        who: "hr",
        due: 0,
      },
    ],
  },
];

export const DEFAULT_ACCESS: Record<Group, Reader[]> = {
  work: ["self", "manager", "viewer"],
  personal: ["self", "editor"],
  pay: ["self", "viewer"],
  documents: ["self", "editor"],
  leave: ["self", "manager", "viewer"],
};

function readStep(v: unknown, at: string): Step {
  const s = String(v ?? "").trim();
  if (s === "manager" || s === "second_manager" || s === "hr") return { kind: s };
  if (EMAIL.test(s)) return { kind: "member", email: s.toLowerCase() };
  throw new Error(`${at} is manager, second_manager, hr or a member's email.`);
}

function readWho(v: unknown, at: string): Who {
  const s = String(v ?? "").trim();
  if (s === "hr" || s === "manager" || s === "employee") return s;
  if (EMAIL.test(s)) return { email: s.toLowerCase() };
  throw new Error(`${at} is hr, manager, employee or a member's email.`);
}

function leaveType(id: string, v: unknown, at: string): LeaveType {
  if (!ID.test(id)) throw new Error(`${at}: a leave type id is up to 32 lowercase letters, digits and -.`);
  if (!isObj(v)) throw new Error(`${at} is a map with name, paid, counts, accrual, days or by_seniority, and the rest.`);
  keys(v, at, [
    "name",
    "paid",
    "counts",
    "accrual",
    "days",
    "by_seniority",
    "at_least",
    "prorate",
    "carry_over",
    "advance",
    "per_request",
    "half_days",
    "document",
    "approval",
    "shown_to_colleagues",
  ]);
  const counts = (v.counts ?? "working_days") as LeaveType["counts"];
  if (counts !== "working_days" && counts !== "calendar_days") throw new Error(`${at}.counts is working_days or calendar_days.`);
  const accrual = (v.accrual ?? (v.days !== undefined || v.by_seniority !== undefined ? "yearly" : "none")) as LeaveType["accrual"];
  if (!["anniversary", "yearly", "none"].includes(accrual)) throw new Error(`${at}.accrual is anniversary, yearly or none.`);
  let bySeniority: Array<[number, number]> = [];
  if (v.days !== undefined && v.by_seniority !== undefined) throw new Error(`${at}: give days or by_seniority, not both.`);
  if (v.days !== undefined) bySeniority = [[accrual === "anniversary" ? 1 : 0, count(v.days, `${at}.days`, 366, true)]];
  if (v.by_seniority !== undefined) {
    if (!isObj(v.by_seniority) || !Object.keys(v.by_seniority).length)
      throw new Error(`${at}.by_seniority maps completed years of service to days, such as { 1: 14, 6: 20, 15: 26 }.`);
    bySeniority = Object.entries(v.by_seniority)
      .map(([y, d]): [number, number] => [count(y, `${at}.by_seniority key`, 60), count(d, `${at}.by_seniority.${y}`, 366, true)])
      .sort((a, b) => a[0] - b[0]);
  }
  if (accrual !== "none" && !bySeniority.length) throw new Error(`${at}: accrual ${accrual} needs days or by_seniority.`);
  if (accrual === "none" && bySeniority.length) throw new Error(`${at}: days and by_seniority need accrual anniversary or yearly.`);
  let atLeast: LeaveType["atLeast"] = null;
  if (v.at_least !== undefined && v.at_least !== null) {
    const a = v.at_least;
    if (!isObj(a)) throw new Error(`${at}.at_least is a map with days, age_up_to and age_from.`);
    keys(a, `${at}.at_least`, ["days", "age_up_to", "age_from"]);
    atLeast = {
      days: count(a.days, `${at}.at_least.days`, 366, true),
      ageUpTo: a.age_up_to === undefined ? null : count(a.age_up_to, `${at}.at_least.age_up_to`, 120),
      ageFrom: a.age_from === undefined ? null : count(a.age_from, `${at}.at_least.age_from`, 120),
    };
  }
  const carry = v.carry_over === undefined || v.carry_over === "all" ? null : count(v.carry_over, `${at}.carry_over`, 366, true);
  return {
    id,
    name: v.name === undefined ? { en: id, de: id, tr: id } : words(v.name, `${at}.name`),
    paid: bool(v.paid, `${at}.paid`, true),
    counts,
    accrual,
    bySeniority,
    atLeast,
    prorate: bool(v.prorate, `${at}.prorate`, false),
    carryOver: carry,
    advance: v.advance === undefined ? 0 : count(v.advance, `${at}.advance`, 60, true),
    perRequest: v.per_request === undefined || v.per_request === null ? null : count(v.per_request, `${at}.per_request`, 366, true),
    halfDays: bool(v.half_days, `${at}.half_days`, counts === "working_days"),
    document: v.document === undefined || v.document === null ? null : text(v.document, `${at}.document`, 32),
    approval: v.approval === undefined ? "standard" : text(v.approval, `${at}.approval`, 32),
    shownToColleagues: bool(v.shown_to_colleagues, `${at}.shown_to_colleagues`, true),
  };
}

/** Reads the file's text. Throws with the field at fault, so one message says what to fix. */
export function parseConfig(raw: string): Config {
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (doc === null || doc === undefined) doc = {};
  if (!isObj(doc)) throw new Error(`The file is a map of ${TOP.join(", ")}.`);
  keys(doc, "The file", TOP);

  const timeZone = doc.time_zone === undefined ? "Europe/Istanbul" : text(doc.time_zone, "time_zone", 64);
  if (!validTimeZone(timeZone)) throw new Error(`time_zone: ${timeZone} is not a time zone, such as Europe/Istanbul.`);
  const language = (doc.language ?? "tr") as Language;
  if (!LANGUAGES.includes(language)) throw new Error(`language is ${LANGUAGES.join(", ")}: the language of the emails HR sends.`);
  const workWeek = doc.work_week === undefined ? [0, 1, 2, 3, 4] : week(doc.work_week, "work_week");

  const locations: Location[] = [];
  if (doc.locations !== undefined && doc.locations !== null) {
    if (!isObj(doc.locations) || Object.keys(doc.locations).length > 200)
      throw new Error("locations is a map of up to 200 locations, such as istanbul: { name }.");
    for (const [id, v] of Object.entries(doc.locations)) {
      const at = `locations.${id}`;
      if (!ID.test(id)) throw new Error(`${at}: a location id is up to 32 lowercase letters, digits and -.`);
      const l = typeof v === "string" ? { name: v } : v;
      if (!isObj(l)) throw new Error(`${at} is a name, or a map with name and work_week.`);
      keys(l, at, ["name", "work_week"]);
      locations.push({
        id,
        name: l.name === undefined ? id : text(l.name, `${at}.name`),
        workWeek: l.work_week === undefined ? workWeek : week(l.work_week, `${at}.work_week`),
      });
    }
  }

  // Holidays.
  const h = doc.holidays ?? {};
  if (!isObj(h)) throw new Error("holidays is a map with country, add and remove.");
  keys(h, "holidays", ["country", "add", "remove"]);
  const country = (h.country ?? "tr") as "tr" | "none";
  if (country !== "tr" && country !== "none") throw new Error("holidays.country is tr (Türkiye's holidays, built in) or none.");
  const add: Holiday[] = [];
  if (h.add !== undefined && h.add !== null) {
    if (!Array.isArray(h.add) || h.add.length > 500)
      throw new Error("holidays.add is a list of up to 500 days, such as { date: 2028-02-25, name: Arife, half: true }.");
    h.add.forEach((x, i) => {
      const at = `holidays.add[${i}]`;
      if (!isObj(x)) throw new Error(`${at} is a map with date, name and half.`);
      keys(x, at, ["date", "name", "half"]);
      const date = x.date instanceof Date ? x.date.toISOString().slice(0, 10) : String(x.date ?? "");
      if (!isDay(date)) throw new Error(`${at}.date is a day, YYYY-MM-DD.`);
      add.push({ date, name: words(x.name, `${at}.name`), half: bool(x.half, `${at}.half`, false) });
    });
  }
  const remove: string[] = [];
  if (h.remove !== undefined && h.remove !== null) {
    if (!Array.isArray(h.remove)) throw new Error("holidays.remove is a list of days, YYYY-MM-DD.");
    for (const r of h.remove) {
      const date = r instanceof Date ? r.toISOString().slice(0, 10) : String(r);
      if (!isDay(date)) throw new Error(`holidays.remove: ${date} is not a day, YYYY-MM-DD.`);
      remove.push(date);
    }
  }

  // Approval rules.
  let approvals = DEFAULT_APPROVALS;
  if (doc.approvals !== undefined && doc.approvals !== null) {
    if (!isObj(doc.approvals) || !Object.keys(doc.approvals).length) throw new Error("approvals is a map of rules, such as standard: [manager, hr].");
    approvals = Object.entries(doc.approvals).map(([id, v]) => {
      const at = `approvals.${id}`;
      if (!ID.test(id)) throw new Error(`${at}: a rule id is up to 32 lowercase letters, digits and -.`);
      if (!Array.isArray(v) || v.length > 5)
        throw new Error(`${at} is a list of up to 5 steps: manager, second_manager, hr or a member's email; [] approves at once.`);
      return { id, steps: v.map((s, i) => readStep(s, `${at}[${i}]`)) };
    });
  }

  // Document kinds.
  let documents = DEFAULT_DOCUMENTS;
  if (doc.documents !== undefined && doc.documents !== null) {
    if (!isObj(doc.documents) || !Object.keys(doc.documents).length || Object.keys(doc.documents).length > 50)
      throw new Error("documents is a map of 1 to 50 kinds, such as contract: { name, expires }.");
    documents = Object.entries(doc.documents).map(([id, v]) => {
      const at = `documents.${id}`;
      if (!ID.test(id)) throw new Error(`${at}: a document kind id is up to 32 lowercase letters, digits and -.`);
      const d = typeof v === "string" ? { name: v } : v;
      if (!isObj(d)) throw new Error(`${at} is a name, or a map with name, expires and warn_before.`);
      keys(d, at, ["name", "expires", "warn_before"]);
      return {
        id,
        name: d.name === undefined ? { en: id, de: id, tr: id } : words(d.name, `${at}.name`),
        expires: bool(d.expires, `${at}.expires`, false),
        warnDays: d.warn_before === undefined ? 30 : span(d.warn_before, `${at}.warn_before`),
      };
    });
  }

  // Leave types.
  let leaveTypes = DEFAULT_LEAVE;
  if (doc.leave_types !== undefined && doc.leave_types !== null) {
    if (!isObj(doc.leave_types) || !Object.keys(doc.leave_types).length || Object.keys(doc.leave_types).length > 40)
      throw new Error("leave_types is a map of 1 to 40 types, such as annual: { name, accrual, by_seniority }.");
    leaveTypes = Object.entries(doc.leave_types).map(([id, v]) => leaveType(id, v, `leave_types.${id}`));
  }
  for (const t of leaveTypes) {
    if (!approvals.some((a) => a.id === t.approval))
      throw new Error(`leave_types.${t.id}.approval: ${t.approval} is not a rule under approvals; there are ${approvals.map((a) => a.id).join(", ")}.`);
    if (t.document && !documents.some((d) => d.id === t.document))
      throw new Error(`leave_types.${t.id}.document: ${t.document} is not a kind under documents; there are ${documents.map((d) => d.id).join(", ")}.`);
  }

  // Checklists.
  let checklists = DEFAULT_CHECKLISTS;
  if (doc.checklists !== undefined && doc.checklists !== null) {
    if (!isObj(doc.checklists) || Object.keys(doc.checklists).length > 20)
      throw new Error("checklists is a map of up to 20 lists, such as onboarding: { on: start, tasks }.");
    checklists = Object.entries(doc.checklists).map(([id, v]) => {
      const at = `checklists.${id}`;
      if (!ID.test(id)) throw new Error(`${at}: a checklist id is up to 32 lowercase letters, digits and -.`);
      if (!isObj(v)) throw new Error(`${at} is a map with name, on and tasks.`);
      keys(v, at, ["name", "on", "tasks"]);
      if (v.on !== "start" && v.on !== "end") throw new Error(`${at}.on is start (joining) or end (leaving).`);
      if (!Array.isArray(v.tasks) || !v.tasks.length || v.tasks.length > 60) throw new Error(`${at}.tasks is a list of 1 to 60 tasks.`);
      const seen = new Set<string>();
      const tasks = v.tasks.map((t, i): ChecklistTask => {
        const tat = `${at}.tasks[${i}]`;
        if (!isObj(t)) throw new Error(`${tat} is a map with id, text, who and due.`);
        keys(t, tat, ["id", "text", "who", "due"]);
        const tid = t.id === undefined ? `task-${i + 1}` : String(t.id);
        if (!ID.test(tid) || seen.has(tid)) throw new Error(`${tat}.id is a task id unique in the list, up to 32 lowercase letters, digits and -.`);
        seen.add(tid);
        return {
          id: tid,
          text: words(t.text, `${tat}.text`, 200),
          who: readWho(t.who ?? "hr", `${tat}.who`),
          due: t.due === undefined ? 0 : span(t.due, `${tat}.due`, true),
        };
      });
      return { id, name: v.name === undefined ? { en: id, de: id, tr: id } : words(v.name, `${at}.name`), on: v.on, tasks };
    });
  }

  // Who reads what.
  const access: Record<Group, Reader[]> = { ...DEFAULT_ACCESS };
  if (doc.access !== undefined && doc.access !== null) {
    if (!isObj(doc.access)) throw new Error(`access is a map of ${GROUPS.join(", ")} to who reads them.`);
    keys(doc.access, "access", [...GROUPS]);
    for (const [g, v] of Object.entries(doc.access)) {
      const at = `access.${g}`;
      if (!Array.isArray(v)) throw new Error(`${at} is a list of self, manager, viewer and editor; admins always read everything.`);
      const list = [...new Set(v.map(String))];
      for (const r of list) if (!["self", "manager", "viewer", "editor"].includes(r)) throw new Error(`${at}: ${r} is not self, manager, viewer or editor.`);
      access[g as Group] = list as Reader[];
    }
  }

  const r = doc.retention ?? {};
  if (!isObj(r)) throw new Error("retention is a map with after_leaving and access_log.");
  keys(r, "retention", ["after_leaving", "access_log"]);
  const retention = {
    afterLeavingDays: r.after_leaving === undefined ? 3650 : span(r.after_leaving, "retention.after_leaving"),
    accessLogDays: r.access_log === undefined ? 730 : span(r.access_log, "retention.access_log"),
  };
  if (retention.afterLeavingDays < 30) throw new Error("retention.after_leaving is at least 30d.");
  if (retention.accessLogDays < 30) throw new Error("retention.access_log is at least 30d.");

  const n = doc.notify ?? {};
  if (!isObj(n)) throw new Error("notify is a map with hr.");
  keys(n, "notify", ["hr"]);
  const hrList = n.hr === undefined || n.hr === null ? [] : Array.isArray(n.hr) ? n.hr : [n.hr];
  const notify = { hr: hrList.map((e, i) => email(e, `notify.hr[${i}]`)) };

  let mail: Config["mail"] = null;
  if (doc.mail !== undefined && doc.mail !== null) {
    const m = doc.mail;
    if (!isObj(m)) throw new Error("mail is a map with host, port, security, user, password and from.");
    keys(m, "mail", ["host", "port", "security", "user", "password", "from"]);
    const security = (m.security ?? "starttls") as "starttls" | "tls" | "none";
    if (!["starttls", "tls", "none"].includes(security)) throw new Error("mail.security is starttls, tls or none.");
    const port = m.port === undefined ? (security === "tls" ? 465 : 587) : Number(m.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("mail.port is a port number.");
    mail = {
      host: text(m.host, "mail.host", 253),
      port,
      security,
      user: m.user === undefined || m.user === null ? null : text(m.user, "mail.user", 254),
      password: m.password === undefined ? "HR_MAIL_PASSWORD" : env(m.password, "mail.password"),
      from: text(m.from, "mail.from", 254),
    };
  }

  let identity: Config["identity"] = null;
  if (doc.identity !== undefined && doc.identity !== null) {
    const i = doc.identity;
    if (!isObj(i)) throw new Error("identity is a map with url, token, create_at, create_days_before, disable_at and groups.");
    keys(i, "identity", ["url", "token", "create_at", "create_days_before", "disable_at", "groups"]);
    const g = i.groups ?? {};
    if (!isObj(g)) throw new Error("identity.groups is a map with departments and all.");
    keys(g, "identity.groups", ["departments", "all"]);
    const all = g.all === undefined || g.all === null ? [] : Array.isArray(g.all) ? g.all : [g.all];
    identity = {
      url: baseUrl(i.url, "identity.url"),
      token: i.token === undefined ? "HR_IDENTITY_TOKEN" : env(i.token, "identity.token"),
      createAt: i.create_at === undefined ? 7 * 60 : time(i.create_at, "identity.create_at"),
      createDaysBefore: i.create_days_before === undefined ? 0 : count(i.create_days_before, "identity.create_days_before", 60),
      disableAt: i.disable_at === undefined ? 18 * 60 : time(i.disable_at, "identity.disable_at"),
      departmentGroups: bool(g.departments, "identity.groups.departments", true),
      allGroups: all.map((x, k) => text(x, `identity.groups.all[${k}]`, 100)),
    };
  }

  return {
    timeZone,
    language,
    workWeek,
    locations,
    holidays: { country, add, remove },
    leaveTypes,
    approvals,
    documents,
    checklists,
    access,
    retention,
    notify,
    mail,
    identity,
  };
}

/** Things to fix that do not stop the file from being applied. */
export function configWarnings(c: Config, environment: Record<string, string | undefined>, members: string[], today: string): string[] {
  const w: string[] = [];
  const year = Number(today.slice(0, 4));
  if (c.holidays.country === "tr")
    for (const y of [year, year + 1])
      if (!hasBayram(y) && !c.holidays.add.some((h) => h.date.startsWith(`${y}-`)))
        w.push(
          `holidays: Ramazan and Kurban Bayramı of ${y} are not built in (only ${BUILT_IN_YEARS.join(", ")}); add them under holidays.add once they are announced.`,
        );
  if (c.mail && c.mail.user && !environment[c.mail.password]) w.push(`mail: ${c.mail.password} is not set, so no email can be sent.`);
  if (!c.mail) w.push("mail: no mail server, so approvers and HR are not emailed; they see what waits for them in HR.");
  if (c.identity && !environment[c.identity.token]) w.push(`identity: ${c.identity.token} is not set, so Identity is not told who joins and leaves.`);
  for (const a of c.approvals)
    for (const s of a.steps) if (s.kind === "member" && !members.includes(s.email)) w.push(`approvals.${a.id}: ${s.email} is not a member of HR.`);
  for (const l of c.checklists)
    for (const t of l.tasks)
      if (typeof t.who === "object" && !members.includes(t.who.email)) w.push(`checklists.${l.id}.tasks.${t.id}.who: ${t.who.email} is not a member of HR.`);
  return w;
}

export interface ConfigFileState {
  path: string;
  appliedAt: string | null;
  error: string | null;
  warnings: string[];
}

/** Reads the file now and whenever it changes, and hands each new version to `apply`; a bad file keeps the last good one. */
export function watchConfig(
  path: string,
  apply: (config: Config, text: string) => string[],
  { everyMs = 60_000, onChange }: { everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, error: null, warnings: [] };
  let seen = "";
  const read = () => {
    let raw: string;
    let stamp: string;
    try {
      const st = statSync(path);
      raw = readFileSync(path, "utf8");
      stamp = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(raw).digest("hex")}`;
    } catch (err) {
      const error = `Cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
      if (state.error !== error) ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      state.warnings = apply(parseConfig(raw), raw);
      Object.assign(state, { appliedAt: new Date().toISOString(), error: null });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, stop: () => clearInterval(timer) };
}
