// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

export interface ProductLink {
  id: string;
  url: string;
}

export interface Words {
  en: string;
  de: string;
  tr: string;
}
export interface Ref {
  id: string;
  name: string;
}
export type Part = "work" | "personal" | "pay" | "documents" | "leave";
export type Reader = "self" | "manager" | "viewer" | "editor";

export interface LeaveTypeInfo {
  id: string;
  name: Words;
  paid: boolean;
  counts: "working_days" | "calendar_days";
  hasBalance: boolean;
  perRequest: number | null;
  halfDays: boolean;
  document: string | null;
}
export interface DocumentKind {
  id: string;
  name: Words;
  expires: boolean;
  warnDays: number;
}

export interface Me {
  member: { id: string; name: string; role: string };
  employee: Ref | null;
  manages: number;
  hr: boolean;
  waitingForMe: number;
  tasks: number;
  leaveTypes: LeaveTypeInfo[];
  documentKinds: DocumentKind[];
  identity: { createAt: string; createDaysBefore: number; disableAt: string } | null;
}

export type ConfigFile = { path: string; appliedAt: string | null; error: string | null; warnings: string[] } | null;

export interface SettingsLeaveType {
  id: string;
  name: Words;
  paid: boolean;
  counts: "working_days" | "calendar_days";
  accrual: "anniversary" | "yearly" | "none";
  bySeniority: Array<{ years: number; days: number }>;
  atLeast: { days: number; ageUpTo: number | null; ageFrom: number | null } | null;
  carryOver: number | null;
  advance: number;
  perRequest: number | null;
  halfDays: boolean;
  document: string | null;
  approval: string;
  shownToColleagues: boolean;
}
export type Step = { kind: "manager" } | { kind: "second_manager" } | { kind: "hr" } | { kind: "member"; email: string };
export interface Holiday {
  date: string;
  name: Words;
  half: boolean;
}
export interface Settings {
  timeZone: string;
  language: string;
  workWeek: number[];
  locations: Array<{ id: string; name: string; workWeek: number[] }>;
  holidays: { country: "tr" | "none"; thisYear: Holiday[]; nextYear: Holiday[] };
  leaveTypes: SettingsLeaveType[];
  approvals: Array<{ id: string; steps: Step[] }>;
  documents: DocumentKind[];
  checklists: Array<{ id: string; name: Words; on: "start" | "end"; tasks: Array<{ id: string; text: Words; who: string; due: number }> }>;
  access: Record<Part, Reader[]>;
  retention: { afterLeavingDays: number; accessLogDays: number };
  notify: { hr: string[] };
  mail: { host: string; port: number; security: string; from: string } | null;
  identity: {
    url: string;
    token: string;
    createAt: number;
    createDaysBefore: number;
    disableAt: number;
    departmentGroups: boolean;
    allGroups: string[];
  } | null;
  file: ConfigFile;
  text: string;
}

export interface Department {
  id: string;
  name: string;
  parentId: string | null;
  head: Ref | null;
  identityGroup: string;
  people: number;
}
export interface Position {
  id: string;
  title: string;
  departmentId: string | null;
}

export type EmploymentType = "full_time" | "part_time" | "intern" | "contractor";
export interface PayEntry {
  id: string;
  from: string;
  amount: number;
  currency: string;
  period: "month" | "hour" | "year";
  createdAt: string;
  createdBy: string;
}
export interface Personal {
  birthDate: string | null;
  gender: "female" | "male" | "other" | null;
  maritalStatus: "single" | "married" | "divorced" | "widowed" | null;
  /** Masked, such as 104•••••846: the whole number is read on its own, and that read is logged. */
  nationalId: string | null;
  nationality: string | null;
  phone: string | null;
  personalEmail: string | null;
  address: string | null;
  emergencyContact: { name: string; relation: string | null; phone: string } | null;
}
export interface Employee {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  workEmail: string | null;
  status: "upcoming" | "active" | "left";
  startDate: string;
  department: Ref | null;
  position: { id: string; title: string } | null;
  manager: Ref | null;
  location: Ref | null;
  reports: number;
  parts: Part[];
  work?: {
    number: string | null;
    employmentType: EmploymentType;
    serviceStart: string;
    probationEnd: string | null;
    contract: "indefinite" | "fixed";
    contractEnd: string | null;
    endDate: string | null;
    endReason: string | null;
  };
  personal?: Personal;
  pay?: { iban: string | null; bankName: string | null; current: PayEntry | null };
  identity?: { linked: boolean; accountId: string | null; state: "active" | "disabled" | null; error: string | null; at: string | null };
  can: { edit: boolean; editContact: boolean; delete: boolean };
}

export interface HistoryEntry {
  at: string;
  by: string;
  part: string;
  field: string;
  from: string | null;
  to: string | null;
}
export interface Look {
  at: string;
  by: string;
  as: string;
  what: string;
  parts: string[];
}

export interface Doc {
  id: string;
  employeeId: string;
  kind: string;
  kindName: Words;
  name: string;
  contentType: string;
  size: number;
  expiresOn: string | null;
  expired: boolean;
  expiresSoon: boolean;
  uploadedAt: string;
  uploadedBy: string;
}
export type ExpiringDoc = Doc & { employee: Ref };

export interface Grant {
  years: number;
  days: number;
  rule: "none" | "seniority" | "age";
  from: number | null;
  to: number | null;
}
export interface Balance {
  type: string;
  name: Words;
  paid: boolean;
  hasBalance: boolean;
  perRequest?: number | null;
  granted?: number;
  adjusted?: number;
  expired?: number;
  taken?: number;
  pending: number;
  balance?: number;
  available?: number;
  advance?: number;
  takenThisYear: number;
  grant?: Grant;
  next?: { date: string; days: number } | null;
}
export interface BalanceRow {
  employee: Ref;
  type: string;
  grant: Grant | null;
  balance: number;
  available: number;
  pending: number;
  next: { date: string; days: number } | null;
}

export interface LeaveStep {
  kind: "manager" | "second_manager" | "hr" | "member";
  approver: { id: string | null; name: string } | null;
  decision: "approved" | "rejected" | null;
  by: string | null;
  at: string | null;
  note: string | null;
}
export interface LeaveRequest {
  id: string;
  employee: Ref;
  type: string | null;
  typeName: Words | null;
  paid: boolean | null;
  startDate: string;
  endDate: string;
  startHalf: boolean;
  endHalf: boolean;
  days: number;
  status: "pending" | "approved" | "rejected" | "cancelled";
  note: string | null;
  documentId: string | null;
  needsDocument: boolean;
  steps: LeaveStep[];
  waitingFor: { kind: string; approver: { id: string | null; name: string } | null } | null;
  canDecide: boolean;
  canCancel: boolean;
  createdAt: string;
  createdBy: string;
  decidedAt: string | null;
}
export interface Quote {
  days: number;
  perDay: Array<{ date: string; takes: number; why?: "day-off" | "holiday" | "half-holiday" }>;
  balance: { available: number; after: number } | null;
}
export interface Absence {
  id: string;
  employee: { id: string; name: string; workEmail: string | null; departmentId: string | null };
  startDate: string;
  endDate: string;
  startHalf: boolean;
  endHalf: boolean;
  status: "approved" | "pending";
  type: string | null;
  typeName: Words | null;
}

export interface Task {
  id: string;
  task: string;
  text: Words;
  who: "hr" | "manager" | "employee" | "member";
  assignee: { id: string | null; name: string } | null;
  dueDate: string;
  overdue: boolean;
  doneAt: string | null;
  doneBy: string | null;
  canDo: boolean;
  employee?: Ref;
}
export interface Checklist {
  id: string;
  checklist: string;
  name: Words;
  on: "start" | "end";
  anchor: string;
  cancelled: boolean;
  done: number;
  total: number;
  overdue: number;
  tasks: Task[];
  identity: { status: "waiting" | "done" | "failed"; accountId: string | null; error: string | null } | null;
  employee?: Ref;
}

export interface OrgNode {
  id: string;
  name: string;
  position: string | null;
  department: string | null;
  reports: OrgNode[];
}
export interface Upcoming {
  date: string;
  kind: "start" | "end" | "probation-end" | "contract-end" | "anniversary" | "document-expires";
  employee: Ref;
  detail: string | null;
}

export interface Integrations {
  identity: {
    configured: boolean;
    tokenSet: boolean;
    url: string | null;
    waiting: number;
    failing: Array<{ employee: Ref; error: string; nextTry: string | null }>;
  };
  mail: { configured: boolean; waiting: number; lastError: string | null };
}

export interface ImportResult {
  rows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
  results: Array<{
    row: number;
    name: string;
    workEmail: string | null;
    result: "created" | "updated" | "skipped";
    employee: string | null;
    message: string | null;
  }>;
  ignoredColumns: string[];
  dryRun: boolean;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`, res.status);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
