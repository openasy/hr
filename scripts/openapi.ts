// Writes openapi.json (ADR 0014, 0024). Run `npm run openapi` after changing the API; a test fails when the file is out
// of date. Sign-in routes come from @openasy/auth and are merged in when the description is served.
import { readFileSync, writeFileSync } from "node:fs";

type S = Record<string, unknown>;
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const str = { type: "string" };
const int = { type: "integer" };
const num = { type: "number" };
const bool = { type: "boolean" };
const dt = { type: "string", format: "date-time" };
const day = { type: "string", format: "date", examples: ["2026-12-01"] };
const nul = (s: S) => ({ anyOf: [s, { type: "null" }] });
const arr = (s: S) => ({ type: "array", items: s });
const en = (...values: string[]) => ({ type: "string", enum: values });
const obj = (properties: Record<string, S>, required = Object.keys(properties)) => ({ type: "object", required, properties });
const map = { type: "object" };
const desc = (s: S, description: string) => ({ ...s, description });

const problem = { $ref: "#/components/responses/Problem" };
const ok = (schema: S, description = "OK") => ({ description, content: { "application/json": { schema } } });
const SECURE = [{ session: [] }, { apiToken: [] }, { adminToken: [] }];
const id = (what: string) => [{ name: "id", in: "path", required: true, description: `The ${what}'s id.`, schema: str }];
const query = (name: string, description: string, schema: S = str) => ({ name, in: "query", required: false, description, schema });
const json = (schema: S) => ({ required: true, content: { "application/json": { schema } } });
const empty = { description: "Done." };

/** An operation that needs a role (ADR 0003), with the refusals every such operation can answer. */
function op(role: "user" | "viewer" | "editor" | "admin", o: S & { responses: Record<string, unknown> }) {
  const who =
    role === "user"
      ? "Needs someone signed in (the user role and above); what they read is decided per record by the file's access."
      : `Needs the ${role} role.`;
  return {
    ...o,
    security: SECURE,
    "x-openasy-role": role,
    description: [o.description, who].filter(Boolean).join("\n\n"),
    responses: { ...o.responses, ...(o.requestBody ? { "400": problem } : {}), "401": problem, "403": problem },
  };
}
const pub = (o: S & { responses: Record<string, unknown> }) => ({ ...o, security: [] });

const GROUP = en("work", "personal", "pay", "documents", "leave");
const Words = obj({ en: str, de: str, tr: str });
const Ref = obj({ id: str, name: str });
const LooseRef = obj({ id: nul(str), name: str });

const Pay = obj({
  id: str,
  from: day,
  amount: desc(num, "In the currency's units, gross unless your payroll says otherwise."),
  currency: str,
  period: en("month", "hour", "year"),
  createdAt: dt,
  createdBy: str,
});

const Personal = obj({
  birthDate: nul(day),
  gender: nul(en("female", "male", "other")),
  maritalStatus: nul(en("single", "married", "divorced", "widowed")),
  nationalId: nul(desc(str, "T.C. kimlik no, checked by its check digits, or another national id.")),
  nationality: nul(str),
  phone: nul(str),
  personalEmail: nul(str),
  address: nul(str),
  emergencyContact: nul(obj({ name: str, relation: nul(str), phone: str })),
});

const Employee = obj(
  {
    id: str,
    name: str,
    firstName: str,
    lastName: str,
    preferredName: nul(str),
    workEmail: nul(str),
    status: en("upcoming", "active", "left"),
    startDate: day,
    department: nul(Ref),
    position: nul(obj({ id: str, title: str })),
    manager: nul(Ref),
    location: nul(Ref),
    reports: desc(int, "People who report to them directly."),
    parts: desc(arr(GROUP), "The parts of this record the caller reads, besides the directory."),
    work: obj({
      number: nul(str),
      employmentType: en("full_time", "part_time", "intern", "contractor"),
      serviceStart: day,
      probationEnd: nul(day),
      contract: en("indefinite", "fixed"),
      contractEnd: nul(day),
      endDate: nul(day),
      endReason: nul(str),
    }),
    personal: Personal,
    pay: obj({ iban: nul(str), bankName: nul(str), current: nul(Pay) }),
    identity: obj({ linked: bool, accountId: nul(str), state: nul(en("active", "disabled")), error: nul(str), at: nul(dt) }),
    can: obj({ edit: bool, editContact: bool, delete: bool }),
    createdAt: dt,
    updatedAt: dt,
  },
  [
    "id",
    "name",
    "firstName",
    "lastName",
    "preferredName",
    "workEmail",
    "status",
    "startDate",
    "department",
    "position",
    "manager",
    "location",
    "reports",
    "parts",
    "can",
    "createdAt",
    "updatedAt",
  ],
);

const EmployeeInput = {
  type: "object",
  additionalProperties: false,
  description:
    "firstName, lastName and startDate are needed for a new record. Leave a field out to keep it, null to clear it. People change phone, personalEmail, address and emergencyContact on their own record; the rest is HR's.",
  properties: {
    firstName: str,
    lastName: str,
    preferredName: nul(str),
    workEmail: nul(str),
    number: nul(str),
    department: nul(desc(str, "A department's id.")),
    position: nul(desc(str, "A position's id.")),
    manager: nul(desc(str, "An employee's id; not someone who reports to them.")),
    location: nul(desc(str, "A location id from the file.")),
    startDate: day,
    employmentType: en("full_time", "part_time", "intern", "contractor"),
    serviceStart: nul(desc(day, "When service with you began, if before startDate: seniority counts from it.")),
    probationEnd: nul(desc(day, "Two months after the start unless given.")),
    contract: en("indefinite", "fixed"),
    contractEnd: nul(day),
    endDate: nul(desc(day, "The last day. Setting it starts the leaving checklist and Identity turns the account off on it.")),
    endReason: nul(str),
    birthDate: nul(day),
    gender: nul(en("female", "male", "other")),
    maritalStatus: nul(en("single", "married", "divorced", "widowed")),
    nationalId: nul(str),
    nationality: nul(str),
    phone: nul(str),
    personalEmail: nul(str),
    address: nul(str),
    emergencyContact: nul(obj({ name: str, relation: nul(str), phone: str }, ["name", "phone"])),
    iban: nul(str),
    bankName: nul(str),
  },
};

const Department = obj({ id: str, name: str, parentId: nul(str), head: nul(Ref), identityGroup: str, people: int, createdAt: dt, updatedAt: dt });
const Position = obj({ id: str, title: str, departmentId: nul(str), createdAt: dt });

const Document = obj({
  id: str,
  employeeId: str,
  kind: str,
  kindName: Words,
  name: str,
  contentType: en("application/pdf", "image/png", "image/jpeg"),
  size: int,
  expiresOn: nul(day),
  expired: bool,
  expiresSoon: desc(bool, "Expires within its kind's warn_before."),
  uploadedAt: dt,
  uploadedBy: str,
});

const Step = obj({
  kind: en("manager", "second_manager", "hr", "member"),
  approver: nul(LooseRef),
  decision: nul(en("approved", "rejected")),
  by: nul(str),
  at: nul(dt),
  note: nul(str),
});
const LeaveRequest = obj({
  id: str,
  employee: Ref,
  type: nul(desc(str, "null for colleagues when the type is not shown to them, such as sick leave.")),
  typeName: nul(Words),
  paid: nul(bool),
  startDate: day,
  endDate: day,
  startHalf: desc(bool, "The first day starts at noon."),
  endHalf: desc(bool, "The last day ends at noon."),
  days: desc(num, "Days it takes, by the type's rule: working days leave out days off and public holidays."),
  status: en("pending", "approved", "rejected", "cancelled"),
  note: nul(str),
  documentId: nul(str),
  needsDocument: bool,
  steps: arr(Step),
  waitingFor: nul(obj({ kind: str, approver: nul(LooseRef) })),
  canDecide: bool,
  canCancel: bool,
  createdAt: dt,
  createdBy: str,
  decidedAt: nul(dt),
});

const Balance = obj(
  {
    type: str,
    name: Words,
    paid: bool,
    hasBalance: desc(bool, "false for types granted per request, such as sick or marriage leave."),
    perRequest: nul(num),
    granted: num,
    adjusted: num,
    expired: num,
    taken: num,
    pending: num,
    balance: desc(num, "Granted and adjusted, less expired and approved."),
    available: desc(num, "The balance less pending requests."),
    advance: num,
    takenThisYear: num,
    next: nul(obj({ date: day, days: num })),
    ledger: arr(obj({ day: day, days: num, kind: en("accrual", "expiry", "adjustment"), note: nul(str) })),
  },
  ["type", "name", "paid", "hasBalance", "pending", "takenThisYear"],
);

const Task = obj(
  {
    id: str,
    task: str,
    text: Words,
    who: en("hr", "manager", "employee", "member"),
    assignee: nul(LooseRef),
    dueDate: day,
    overdue: bool,
    doneAt: nul(dt),
    doneBy: nul(str),
    canDo: bool,
    employee: Ref,
  },
  ["id", "task", "text", "who", "assignee", "dueDate", "overdue", "doneAt", "doneBy", "canDo"],
);
const Checklist = obj({
  id: str,
  checklist: str,
  name: Words,
  on: en("start", "end"),
  anchor: day,
  cancelled: bool,
  done: int,
  total: int,
  overdue: int,
  tasks: arr(Task),
  identity: nul(obj({ status: en("waiting", "done", "failed"), accountId: nul(str), error: nul(str) })),
});

const Holiday = obj({ date: day, name: Words, half: desc(bool, "Only the afternoon is off: leave on it takes half a day.") });

const schemas: Record<string, S> = {
  Problem: obj({ type: str, title: str, status: int, code: str, detail: str }, ["type", "title", "status", "code"]),
  Status: obj({ status: str }),
  Version: obj({ product: en("hr"), version: str }),
  Products: obj({ products: arr(obj({ id: str, url: str })) }),
  Me: obj({
    member: obj({ id: str, name: str, role: str }),
    employee: nul(Ref),
    manages: int,
    hr: desc(bool, "The viewer role or above: reads everyone's records as the file allows."),
    waitingForMe: int,
    tasks: int,
  }),
  Settings: {
    ...obj({ timeZone: str, language: str, workWeek: arr(int), leaveTypes: arr(map), approvals: arr(map), access: map, file: nul(map), text: str }),
    description: "The file as applied.",
  },
  Integrations: obj({
    identity: obj({ configured: bool, tokenSet: bool, url: nul(str), waiting: int, failing: arr(obj({ employee: Ref, error: str, nextTry: nul(dt) })) }),
    mail: obj({ configured: bool, waiting: int, lastError: nul(str) }),
  }),
  Holiday,
  Department,
  Position,
  Employee,
  EmployeeInput,
  Pay,
  Document,
  LeaveRequest,
  Balance,
  Task,
  Checklist,
  OrgNode: obj({ id: str, name: str, position: nul(str), department: nul(str), reports: arr(ref("OrgNode")) }),
  Upcoming: obj({
    date: day,
    kind: en("start", "end", "probation-end", "contract-end", "anniversary", "document-expires"),
    employee: Ref,
    detail: nul(desc(str, "Years for an anniversary, the reason for an end, the document's name.")),
  }),
  Absence: obj({
    id: str,
    employee: obj({ id: str, name: str, workEmail: nul(str), departmentId: nul(str) }),
    startDate: day,
    endDate: day,
    startHalf: bool,
    endHalf: bool,
    status: en("approved", "pending"),
    type: nul(str),
    typeName: nul(Words),
  }),
  PayrollEmployee: obj({
    id: str,
    number: nul(str),
    name: str,
    workEmail: nul(str),
    startDate: day,
    endDate: nul(day),
    employmentType: nul(str),
    departmentId: nul(str),
    nationalId: nul(str),
    pay: nul(Pay),
    iban: nul(str),
    leave: nul(arr(obj({ type: str, paid: bool, days: num }))),
    annualBalance: nul(desc(num, "The first type with a balance (annual leave by default), on the month's last day or today.")),
  }),
};

const ExpiringDocument = { allOf: [ref("Document"), obj({ employee: Ref })] };
const DocumentInput = obj(
  {
    kind: desc(str, "A kind from the file's documents."),
    name: str,
    contentType: en("application/pdf", "image/png", "image/jpeg"),
    content: desc(str, "The file in base64, up to 10 MiB. It is checked to be what contentType says."),
    expiresOn: nul(desc(day, "Needed for kinds that expire.")),
  },
  ["kind", "name", "contentType", "content"],
);
const LeaveInput = obj(
  {
    employee: desc(str, "Whose leave; leave it out for your own. Only editors record leave for others."),
    type: str,
    startDate: day,
    endDate: day,
    startHalf: bool,
    endHalf: bool,
    note: str,
    document: desc(str, "One of the person's documents, such as a health report."),
    approved: desc(bool, "Editors only: recorded as approved, with no steps."),
  },
  ["type", "startDate"],
);

const paths: Record<string, S> = {
  "/api/v1/version": { get: pub({ operationId: "version", tags: ["Product"], summary: "Product and version", responses: { "200": ok(ref("Version")) } }) },
  "/api/v1/products": {
    get: op("user", { operationId: "products", tags: ["Product"], summary: "The install's other OpenAsy products", responses: { "200": ok(ref("Products")) } }),
  },
  "/api/v1/me": {
    get: op("user", { operationId: "me", tags: ["Product"], summary: "Who the caller is in HR, and what waits for them", responses: { "200": ok(ref("Me")) } }),
  },
  "/api/v1/settings": {
    get: op("viewer", {
      operationId: "settings",
      tags: ["Product"],
      summary: "The settings file as applied; nothing changes it but the file",
      responses: { "200": ok(ref("Settings")) },
    }),
  },
  "/api/v1/integrations": {
    get: op("viewer", {
      operationId: "integrations",
      tags: ["Product"],
      summary: "Identity and mail: what waits, and what failed",
      responses: { "200": ok(ref("Integrations")) },
    }),
  },
  "/api/v1/holidays": {
    get: op("user", {
      operationId: "holidays",
      tags: ["Leave"],
      summary: "The public holidays of a year",
      parameters: [query("year", "Such as 2026; this year by default.")],
      responses: { "200": ok(obj({ holidays: arr(ref("Holiday")) })), "422": problem },
    }),
  },

  "/api/v1/departments": {
    get: op("user", {
      operationId: "listDepartments",
      tags: ["Organisation"],
      summary: "Departments",
      responses: { "200": ok(obj({ departments: arr(ref("Department")) })) },
    }),
    post: op("editor", {
      operationId: "createDepartment",
      tags: ["Organisation"],
      summary: "Add a department",
      requestBody: json(
        obj({ name: str, parent: nul(str), head: nul(str), identityGroup: nul(desc(str, "The Identity group its people are put in; its name by default.")) }, [
          "name",
        ]),
      ),
      responses: { "201": ok(ref("Department")), "409": problem, "422": problem },
    }),
  },
  "/api/v1/departments/{id}": {
    patch: op("editor", {
      operationId: "updateDepartment",
      tags: ["Organisation"],
      summary: "Change a department",
      parameters: id("department"),
      requestBody: json(obj({ name: str, parent: nul(str), head: nul(str), identityGroup: nul(str) }, [])),
      responses: { "200": ok(ref("Department")), "404": problem, "409": problem, "422": problem },
    }),
    delete: op("editor", {
      operationId: "removeDepartment",
      tags: ["Organisation"],
      summary: "Delete a department nobody is in",
      parameters: id("department"),
      responses: { "204": empty, "404": problem, "409": problem },
    }),
  },
  "/api/v1/positions": {
    get: op("user", {
      operationId: "listPositions",
      tags: ["Organisation"],
      summary: "Positions",
      responses: { "200": ok(obj({ positions: arr(ref("Position")) })) },
    }),
    post: op("editor", {
      operationId: "createPosition",
      tags: ["Organisation"],
      summary: "Add a position",
      requestBody: json(obj({ title: str, department: nul(str) }, ["title"])),
      responses: { "201": ok(ref("Position")), "409": problem, "422": problem },
    }),
  },
  "/api/v1/positions/{id}": {
    patch: op("editor", {
      operationId: "updatePosition",
      tags: ["Organisation"],
      summary: "Change a position",
      parameters: id("position"),
      requestBody: json(obj({ title: str, department: nul(str) }, [])),
      responses: { "200": ok(ref("Position")), "404": problem, "409": problem, "422": problem },
    }),
    delete: op("editor", {
      operationId: "removePosition",
      tags: ["Organisation"],
      summary: "Delete a position nobody holds",
      parameters: id("position"),
      responses: { "204": empty, "404": problem, "409": problem },
    }),
  },
  "/api/v1/org-chart": {
    get: op("user", {
      operationId: "orgChart",
      tags: ["Organisation"],
      summary: "Everyone working, by manager",
      responses: { "200": ok(obj({ roots: arr(ref("OrgNode")), people: int })) },
    }),
  },
  "/api/v1/upcoming": {
    get: op("user", {
      operationId: "upcoming",
      tags: ["Organisation"],
      summary: "Starts, ends, probation and contract ends, anniversaries and expiring documents",
      description: "Only what the caller reads: starts for everyone, the rest by the work and documents parts.",
      parameters: [query("days", "How far ahead, 1 to 365; 30 by default.", int)],
      responses: { "200": ok(obj({ events: arr(ref("Upcoming")) })), "422": problem },
    }),
  },

  "/api/v1/employees": {
    get: op("user", {
      operationId: "listEmployees",
      tags: ["People"],
      summary: "Employees, with the parts the caller reads",
      parameters: [
        query("status", "current (the default: active and upcoming), active, upcoming, left or all; left and all for the viewer role and above."),
        query("department", "A department's id."),
        query("manager", "A manager's id: their direct reports."),
        query("q", "Part of a name or work email."),
      ],
      responses: { "200": ok(obj({ employees: arr(ref("Employee")) })), "422": problem },
    }),
    post: op("editor", {
      operationId: "createEmployee",
      tags: ["People"],
      summary: "Add an employee",
      description: "Starts the joining checklist; Identity makes their account on the start day.",
      requestBody: json(ref("EmployeeInput")),
      responses: { "201": ok(ref("Employee")), "409": problem, "422": problem },
    }),
  },
  "/api/v1/employees/{id}": {
    get: op("user", {
      operationId: "getEmployee",
      tags: ["People"],
      summary: "An employee's record, with the parts the caller reads",
      description: "The look is written to the record's access log.",
      parameters: id("employee"),
      responses: { "200": ok(ref("Employee")), "404": problem },
    }),
    patch: op("user", {
      operationId: "updateEmployee",
      tags: ["People"],
      summary: "Change a record",
      description: "Editors change everything; people change their own contact details. Every change is in the history.",
      parameters: id("employee"),
      requestBody: json(ref("EmployeeInput")),
      responses: { "200": ok(ref("Employee")), "404": problem, "409": problem, "422": problem },
    }),
    delete: op("admin", {
      operationId: "removeEmployee",
      tags: ["People"],
      summary: "Delete a record and everything about it",
      description: "Refused while their Identity account is on. Records are also deleted by themselves after retention.after_leaving.",
      parameters: id("employee"),
      responses: { "204": empty, "404": problem, "409": problem },
    }),
  },
  "/api/v1/employees/{id}/history": {
    get: op("user", {
      operationId: "employeeHistory",
      tags: ["People"],
      summary: "Every change to the record, field by field",
      description: "Only the parts the caller reads.",
      parameters: id("employee"),
      responses: { "200": ok(obj({ history: arr(obj({ at: dt, by: str, part: str, field: str, from: nul(str), to: nul(str) })) })), "404": problem },
    }),
  },
  "/api/v1/employees/{id}/access-log": {
    get: op("user", {
      operationId: "employeeAccessLog",
      tags: ["People"],
      summary: "Who looked at the record (KVKK)",
      description: "For the person themselves and admins.",
      parameters: id("employee"),
      responses: { "200": ok(obj({ entries: arr(obj({ at: dt, by: str, as: str, what: str, parts: arr(str) })) })), "404": problem },
    }),
  },
  "/api/v1/employees/{id}/pay": {
    get: op("user", {
      operationId: "listPay",
      tags: ["People"],
      summary: "Pay over time",
      parameters: id("employee"),
      responses: { "200": ok(obj({ pay: arr(ref("Pay")) })), "404": problem },
    }),
    post: op("editor", {
      operationId: "addPay",
      tags: ["People"],
      summary: "Set pay from a day on",
      parameters: id("employee"),
      requestBody: json(obj({ from: day, amount: num, currency: str, period: en("month", "hour", "year") }, ["from", "amount"])),
      responses: { "201": ok(ref("Pay")), "404": problem, "422": problem },
    }),
  },
  "/api/v1/employees/{id}/documents": {
    get: op("user", {
      operationId: "listDocuments",
      tags: ["Documents"],
      summary: "A person's documents",
      parameters: id("employee"),
      responses: { "200": ok(obj({ documents: arr(ref("Document")) })), "404": problem },
    }),
    post: op("user", {
      operationId: "addDocument",
      tags: ["Documents"],
      summary: "Add a document",
      description: "Editors add to any record, people to their own. The file is encrypted with the install's key.",
      parameters: id("employee"),
      requestBody: json(DocumentInput),
      responses: { "201": ok(ref("Document")), "404": problem, "413": problem, "422": problem },
    }),
  },
  "/api/v1/employees/{id}/balances": {
    get: op("user", {
      operationId: "balances",
      tags: ["Leave"],
      summary: "Leave balances, by type",
      parameters: id("employee"),
      responses: { "200": ok(obj({ balances: arr(ref("Balance")) })), "404": problem },
    }),
    post: op("editor", {
      operationId: "adjustBalance",
      tags: ["Leave"],
      summary: "Add or take away days, such as an opening balance",
      parameters: id("employee"),
      requestBody: json(obj({ type: str, days: num, note: str, day: day }, ["type", "days", "note"])),
      responses: { "200": ok(ref("Balance")), "404": problem, "422": problem },
    }),
  },
  "/api/v1/employees/{id}/checklists": {
    get: op("user", {
      operationId: "employeeChecklists",
      tags: ["Checklists"],
      summary: "Joining and leaving checklists, and whether Identity turned the account off",
      parameters: id("employee"),
      responses: { "200": ok(obj({ checklists: arr(ref("Checklist")) })), "404": problem },
    }),
  },

  "/api/v1/documents/{id}": {
    get: op("user", {
      operationId: "documentFile",
      tags: ["Documents"],
      summary: "The document's file",
      description: "The look is written to the record's access log.",
      parameters: id("document"),
      responses: {
        "200": {
          description: "The file.",
          content: {
            "application/pdf": { schema: { type: "string", format: "binary" } },
            "image/png": { schema: { type: "string", format: "binary" } },
            "image/jpeg": { schema: { type: "string", format: "binary" } },
          },
        },
        "404": problem,
      },
    }),
    delete: op("editor", {
      operationId: "removeDocument",
      tags: ["Documents"],
      summary: "Delete a document",
      parameters: id("document"),
      responses: { "204": empty, "404": problem },
    }),
  },
  "/api/v1/expiring-documents": {
    get: op("user", {
      operationId: "expiringDocuments",
      tags: ["Documents"],
      summary: "Documents expired or expiring within their kind's warn_before",
      responses: { "200": ok(obj({ documents: arr(ExpiringDocument) })) },
    }),
  },

  "/api/v1/tasks": {
    get: op("user", {
      operationId: "tasks",
      tags: ["Checklists"],
      summary: "Open checklist tasks for the caller",
      parameters: [query("all", "true: every open task, for editors.")],
      responses: { "200": ok(obj({ tasks: arr(ref("Task")) })) },
    }),
  },
  "/api/v1/tasks/{id}/done": {
    post: op("user", {
      operationId: "taskDone",
      tags: ["Checklists"],
      summary: "Mark a task done",
      parameters: id("task"),
      responses: { "200": ok(ref("Task")), "404": problem },
    }),
  },
  "/api/v1/tasks/{id}/undo": {
    post: op("user", {
      operationId: "taskUndo",
      tags: ["Checklists"],
      summary: "Mark a task not done",
      parameters: id("task"),
      responses: { "200": ok(ref("Task")), "404": problem },
    }),
  },

  "/api/v1/leave": {
    get: op("user", {
      operationId: "listLeave",
      tags: ["Leave"],
      summary: "Leave requests",
      parameters: [
        query("scope", "mine (the default), approvals (waiting for the caller), team (the people they manage) or all (those whose leave they read)."),
        query("status", "pending, approved, rejected or cancelled."),
        query("employee", "One person's."),
      ],
      responses: { "200": ok(obj({ requests: arr(ref("LeaveRequest")) })), "422": problem },
    }),
    post: op("user", {
      operationId: "createLeave",
      tags: ["Leave"],
      summary: "Ask for leave",
      description: "It goes through the steps of its type's approval rule; each approver is emailed in turn.",
      requestBody: json(LeaveInput),
      responses: { "201": ok(ref("LeaveRequest")), "404": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/leave/quote": {
    post: op("user", {
      operationId: "quoteLeave",
      tags: ["Leave"],
      summary: "What a request would take, without making it",
      requestBody: json(LeaveInput),
      responses: {
        "200": ok(
          obj({
            days: num,
            perDay: arr(obj({ date: day, takes: num, why: en("day-off", "holiday", "half-holiday") }, ["date", "takes"])),
            balance: nul(obj({ available: num, after: num })),
          }),
        ),
        "404": problem,
        "422": problem,
      },
    }),
  },
  "/api/v1/leave/{id}": {
    get: op("user", {
      operationId: "getLeave",
      tags: ["Leave"],
      summary: "A leave request",
      parameters: id("request"),
      responses: { "200": ok(ref("LeaveRequest")), "404": problem },
    }),
  },
  "/api/v1/leave/{id}/approve": {
    post: op("user", {
      operationId: "approveLeave",
      tags: ["Leave"],
      summary: "Approve the step the request waits on",
      description: "The step's approver, or editors on their behalf; nobody approves their own leave.",
      parameters: id("request"),
      requestBody: { required: false, content: { "application/json": { schema: obj({ note: str }, []) } } },
      responses: { "200": ok(ref("LeaveRequest")), "404": problem, "409": problem },
    }),
  },
  "/api/v1/leave/{id}/reject": {
    post: op("user", {
      operationId: "rejectLeave",
      tags: ["Leave"],
      summary: "Reject the request",
      parameters: id("request"),
      requestBody: { required: false, content: { "application/json": { schema: obj({ note: str }, []) } } },
      responses: { "200": ok(ref("LeaveRequest")), "404": problem, "409": problem },
    }),
  },
  "/api/v1/leave/{id}/cancel": {
    post: op("user", {
      operationId: "cancelLeave",
      tags: ["Leave"],
      summary: "Cancel a request",
      description: "The person cancels before it starts; editors at any time. Its days go back to the balance.",
      parameters: id("request"),
      responses: { "200": ok(ref("LeaveRequest")), "404": problem, "409": problem },
    }),
  },
  "/api/v1/absences": {
    get: op("user", {
      operationId: "absences",
      tags: ["Contracts"],
      summary: "Who is away: the team calendar, Calendar's busy times and Time's leave",
      description:
        "Approved leave overlapping the days, and pending leave when asked. The type is shown to those who read the person's leave, and to everyone for types the file shows to colleagues; otherwise only that they are away.",
      parameters: [
        query("from", "A day; today by default.", day),
        query("to", "A day, at most a year after from; 30 days after from by default.", day),
        query("pending", "true to include pending requests."),
        query("department", "A department's id."),
      ],
      responses: { "200": ok(obj({ absences: arr(ref("Absence")) })), "422": problem },
    }),
  },

  "/api/v1/import": {
    post: op("editor", {
      operationId: "importCsv",
      tags: ["People"],
      summary: "Import employees from a CSV file",
      description:
        "Comma or semicolon separated, with a header line in English or Turkish. People are matched by work email or number and updated; departments and positions are made by name; managers are linked by work email; salary and an opening annual leave balance may be given. dryRun checks every row and changes nothing.",
      requestBody: json(obj({ csv: str, dryRun: bool }, ["csv"])),
      responses: {
        "200": ok(
          obj({
            rows: int,
            created: int,
            updated: int,
            skipped: int,
            errors: arr(obj({ row: int, message: str })),
            ignoredColumns: arr(str),
            dryRun: bool,
          }),
        ),
        "413": problem,
        "422": problem,
      },
    }),
  },
  "/api/v1/payroll": {
    get: op("viewer", {
      operationId: "payroll",
      tags: ["Contracts"],
      summary: "The month as Payroll reads it",
      description:
        "Everyone who worked a day of the month, with their dates, current pay and bank account, leave days by type and whether each is paid, and the annual balance. Parts the caller does not read are null; each person's look is logged.",
      parameters: [query("month", "YYYY-MM; this month by default.")],
      responses: { "200": ok(obj({ month: str, from: day, to: day, employees: arr(ref("PayrollEmployee")) })), "422": problem },
    }),
  },

  "/healthz": { get: pub({ operationId: "healthz", tags: ["Product"], summary: "Alive", responses: { "200": ok(ref("Status")) } }) },
  "/readyz": {
    get: pub({ operationId: "readyz", tags: ["Product"], summary: "Ready", responses: { "200": ok(ref("Status")), "503": ok(ref("Status"), "Not ready.") } }),
  },
  "/metrics": {
    get: pub({
      operationId: "metrics",
      tags: ["Product"],
      summary: "Prometheus metrics",
      responses: { "200": { description: "Metrics.", content: { "text/plain": { schema: str } } } },
    }),
  },
};

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const doc = {
  openapi: "3.1.0",
  info: {
    title: "OpenAsy HR",
    version,
    description:
      "Employee records, departments and positions, the org chart, documents with expiry, leave with balances and approvals as hr.yaml sets them, joining and leaving checklists, the history of every change and the access log. Everyone signed in reads the directory; the other parts of a record go to the person, their managers and the roles the file names; admins read everything.",
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [{ url: "/" }],
  security: SECURE,
  paths,
  components: {
    securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: "openasy_session" },
      apiToken: { type: "http", scheme: "bearer", description: "An API token made under Settings, API tokens." },
      adminToken: { type: "http", scheme: "bearer", description: "Tests only." },
    },
    responses: { Problem: { description: "A problem (RFC 9457).", content: { "application/problem+json": { schema: ref("Problem") } } } },
    schemas,
  },
};

export const OPENAPI = doc;
const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  writeFileSync(new URL("../openapi.json", import.meta.url), text);
  console.log("openapi.json written");
}
export const OPENAPI_TEXT = text;
