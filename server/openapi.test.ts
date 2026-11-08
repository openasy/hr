import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI_TEXT } from "../scripts/openapi.ts";
import { ADMIN_TOKEN, startApp, type TestApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json, and every operation is called.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "hr-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: TestApp;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});
afterAll(() => app.close());

async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method, redirect: "manual" });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);
  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;
  if (!response.content) {
    await res.arrayBuffer();
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined as any };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();
  if (!type.endsWith("json") && type !== "text/plain") return { res, body: Buffer.from(await res.arrayBuffer()) as any };
  const body = type.endsWith("json") ? await res.json() : await res.text();
  const validate = ajv.getSchema(`${at}/content/${type.replace("/", "~1")}/schema`)!;
  expect(validate(body), `${method} ${concrete}: ${JSON.stringify(validate.errors)}`).toBe(true);
  return { res, body: body as any };
}

const admin = (b?: unknown) => ({
  headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
  ...(b !== undefined && { body: typeof b === "string" ? b : JSON.stringify(b) }),
});

describe("openapi.json", () => {
  it("is what scripts/openapi.ts writes, with the version of this release", () => {
    expect(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")).toBe(OPENAPI_TEXT);
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version and the sign-in routes", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    expect((await fetch(`${base}/api/docs/`)).headers.get("content-type")).toContain("text/html");
  });
});

describe("responses match openapi.json", () => {
  const ids: Record<string, string> = {};
  const PDF = Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64");

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    for (const p of ["/api/v1/products", "/api/v1/me", "/api/v1/settings", "/api/v1/integrations"]) {
      await call("GET", p, admin());
      await call("GET", p, {});
    }
    await call("GET", "/api/v1/holidays", admin(), "/api/v1/holidays?year=2026");
    await call("GET", "/api/v1/holidays", admin(), "/api/v1/holidays?year=1066");
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("departments and positions", async () => {
    ids.dep = (await call("POST", "/api/v1/departments", admin({ name: "Finance" }))).body.id;
    ids.dep2 = (await call("POST", "/api/v1/departments", admin({ name: "Treasury", parent: ids.dep, identityGroup: "Finance - Treasury" }))).body.id;
    await call("POST", "/api/v1/departments", admin({ name: "finance" }));
    await call("POST", "/api/v1/departments", admin({ name: "" }));
    await call("GET", "/api/v1/departments", admin());
    await call("PATCH", "/api/v1/departments/{id}", admin({ parent: ids.dep2 }), `/api/v1/departments/${ids.dep}`);
    await call("PATCH", "/api/v1/departments/{id}", admin({ name: "Treasury" }), `/api/v1/departments/${ids.dep}`);
    await call("PATCH", "/api/v1/departments/{id}", admin({ name: "Money" }), `/api/v1/departments/${ids.dep2}`);
    await call("PATCH", "/api/v1/departments/{id}", admin({}), "/api/v1/departments/missing");
    ids.pos = (await call("POST", "/api/v1/positions", admin({ title: "Analyst", department: ids.dep }))).body.id;
    await call("POST", "/api/v1/positions", admin({ title: "Analyst", department: ids.dep }));
    await call("POST", "/api/v1/positions", admin({ title: "Analyst", department: "missing" }));
    await call("GET", "/api/v1/positions", admin());
    await call("PATCH", "/api/v1/positions/{id}", admin({ title: "Senior analyst" }), `/api/v1/positions/${ids.pos}`);
    await call("PATCH", "/api/v1/positions/{id}", admin({ title: "" }), `/api/v1/positions/${ids.pos}`);
    await call("PATCH", "/api/v1/positions/{id}", admin({}), "/api/v1/positions/missing");
    const other = (await call("POST", "/api/v1/positions", admin({ title: "Analyst", department: ids.dep }))).body.id;
    await call("PATCH", "/api/v1/positions/{id}", admin({ title: "Senior analyst" }), `/api/v1/positions/${other}`);
  });

  it("employees", async () => {
    ids.mgr = (
      await call(
        "POST",
        "/api/v1/employees",
        admin({ firstName: "Mert", lastName: "Şahin", workEmail: "mert@example.com", startDate: "2015-03-01", department: ids.dep }),
      )
    ).body.id;
    ids.emp = (
      await call(
        "POST",
        "/api/v1/employees",
        admin({
          firstName: "Ayşe",
          lastName: "Yılmaz",
          workEmail: "ayse@example.com",
          department: ids.dep,
          position: ids.pos,
          manager: ids.mgr,
          location: "istanbul",
          startDate: "2024-06-10",
          birthDate: "1994-02-14",
          nationalId: "10000000146",
          emergencyContact: { name: "Ali Yılmaz", relation: "brother", phone: "+90 555 000 00 00" },
          iban: "TR330006100519786457841326",
        }),
      )
    ).body.id;
    await call("POST", "/api/v1/employees", admin({ firstName: "X", lastName: "Y", startDate: "2026-12-01", workEmail: "ayse@example.com" }));
    await call("POST", "/api/v1/employees", admin({ firstName: "X", lastName: "Y" }));
    await call("POST", "/api/v1/employees", admin("{"));
    await call("GET", "/api/v1/employees", admin(), "/api/v1/employees?q=ayşe");
    await call("GET", "/api/v1/employees", admin(), "/api/v1/employees?status=sometimes");
    await call("GET", "/api/v1/employees/{id}", admin(), `/api/v1/employees/${ids.emp}`);
    await call("GET", "/api/v1/employees/{id}", admin(), "/api/v1/employees/missing");
    await call(
      "PATCH",
      "/api/v1/employees/{id}",
      admin({ phone: "+90 532 000 00 12", contract: "fixed", contractEnd: "2027-06-09" }),
      `/api/v1/employees/${ids.emp}`,
    );
    await call("PATCH", "/api/v1/employees/{id}", admin({ manager: ids.emp }), `/api/v1/employees/${ids.mgr}`);
    await call("PATCH", "/api/v1/employees/{id}", admin({ workEmail: "ayse@example.com" }), `/api/v1/employees/${ids.mgr}`);
    await call("PATCH", "/api/v1/employees/{id}", admin({}), "/api/v1/employees/missing");
    await call("GET", "/api/v1/employees/{id}/history", admin(), `/api/v1/employees/${ids.emp}/history`);
    await call("GET", "/api/v1/employees/{id}/history", admin(), "/api/v1/employees/missing/history");
    await call("GET", "/api/v1/employees/{id}/access-log", admin(), `/api/v1/employees/${ids.emp}/access-log`);
    await call("GET", "/api/v1/employees/{id}/access-log", admin(), "/api/v1/employees/missing/access-log");
    await call("POST", "/api/v1/employees/{id}/pay", admin({ from: "2026-01-01", amount: 85000.5 }), `/api/v1/employees/${ids.emp}/pay`);
    await call("POST", "/api/v1/employees/{id}/pay", admin({ from: "2026-01-01", amount: -1 }), `/api/v1/employees/${ids.emp}/pay`);
    await call("POST", "/api/v1/employees/{id}/pay", admin({ from: "2026-01-01", amount: 1 }), "/api/v1/employees/missing/pay");
    await call("GET", "/api/v1/employees/{id}/pay", admin(), `/api/v1/employees/${ids.emp}/pay`);
    await call("GET", "/api/v1/employees/{id}/pay", admin(), "/api/v1/employees/missing/pay");
    await call("GET", "/api/v1/employees/{id}", admin(), `/api/v1/employees/${ids.emp}`);
    await call("GET", "/api/v1/employees/{id}/checklists", admin(), `/api/v1/employees/${ids.emp}/checklists`);
    await call("GET", "/api/v1/employees/{id}/checklists", admin(), "/api/v1/employees/missing/checklists");
    await call("GET", "/api/v1/org-chart", admin());
    await call("GET", "/api/v1/upcoming", admin(), "/api/v1/upcoming?days=365");
    await call("GET", "/api/v1/upcoming", admin(), "/api/v1/upcoming?days=0");
  });

  it("documents", async () => {
    ids.doc = (
      await call(
        "POST",
        "/api/v1/employees/{id}/documents",
        admin({ kind: "id-copy", name: "Kimlik", contentType: "application/pdf", content: PDF, expiresOn: "2026-11-20" }),
        `/api/v1/employees/${ids.emp}/documents`,
      )
    ).body.id;
    await call(
      "POST",
      "/api/v1/employees/{id}/documents",
      admin({ kind: "id-copy", name: "x", contentType: "application/pdf", content: PDF }),
      `/api/v1/employees/${ids.emp}/documents`,
    );
    await call(
      "POST",
      "/api/v1/employees/{id}/documents",
      admin({ kind: "contract", name: "x", contentType: "application/pdf", content: PDF }),
      "/api/v1/employees/missing/documents",
    );
    await call("POST", "/api/v1/employees/{id}/documents", admin("x".repeat(16 * 1024 * 1024)), `/api/v1/employees/${ids.emp}/documents`);
    await call("GET", "/api/v1/employees/{id}/documents", admin(), `/api/v1/employees/${ids.emp}/documents`);
    await call("GET", "/api/v1/employees/{id}/documents", admin(), "/api/v1/employees/missing/documents");
    const file = await call("GET", "/api/v1/documents/{id}", admin(), `/api/v1/documents/${ids.doc}`);
    expect(file.res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''Kimlik.pdf");
    await call("GET", "/api/v1/documents/{id}", admin(), "/api/v1/documents/missing");
    await call("GET", "/api/v1/expiring-documents", admin());
    await call("DELETE", "/api/v1/documents/{id}", admin(), `/api/v1/documents/${ids.doc}`);
    await call("DELETE", "/api/v1/documents/{id}", admin(), `/api/v1/documents/${ids.doc}`);
  });

  it("leave", async () => {
    await call("GET", "/api/v1/employees/{id}/balances", admin(), `/api/v1/employees/${ids.emp}/balances`);
    await call("GET", "/api/v1/employees/{id}/balances", admin(), "/api/v1/employees/missing/balances");
    await call(
      "POST",
      "/api/v1/employees/{id}/balances",
      admin({ type: "annual", days: 10, note: "Opening balance" }),
      `/api/v1/employees/${ids.emp}/balances`,
    );
    await call("POST", "/api/v1/employees/{id}/balances", admin({ type: "sick", days: 10, note: "x" }), `/api/v1/employees/${ids.emp}/balances`);
    await call("POST", "/api/v1/employees/{id}/balances", admin({ type: "annual", days: 1, note: "x" }), "/api/v1/employees/missing/balances");
    const req = { employee: ids.emp, type: "annual", startDate: "2026-11-16", endDate: "2026-11-20", note: "Holiday" };
    await call("POST", "/api/v1/leave/quote", admin(req));
    await call("POST", "/api/v1/leave/quote", admin({ ...req, type: "nope" }));
    await call("POST", "/api/v1/leave/quote", admin({ ...req, employee: "missing" }));
    ids.leave = (await call("POST", "/api/v1/leave", admin(req))).body.id;
    await call("POST", "/api/v1/leave", admin(req));
    await call("POST", "/api/v1/leave", admin({ ...req, type: "marriage", startDate: "2026-11-23", endDate: "2026-11-27" }));
    await call("POST", "/api/v1/leave", admin({ ...req, employee: "missing" }));
    await call("GET", "/api/v1/leave", admin(), "/api/v1/leave?scope=all&status=pending");
    await call("GET", "/api/v1/leave", admin(), "/api/v1/leave?scope=everyone");
    await call("GET", "/api/v1/leave/{id}", admin(), `/api/v1/leave/${ids.leave}`);
    await call("GET", "/api/v1/leave/{id}", admin(), "/api/v1/leave/missing");
    await call("POST", "/api/v1/leave/{id}/approve", admin({ note: "For Mert" }), `/api/v1/leave/${ids.leave}/approve`);
    await call("POST", "/api/v1/leave/{id}/approve", admin(), `/api/v1/leave/${ids.leave}/approve`);
    await call("POST", "/api/v1/leave/{id}/approve", admin(), `/api/v1/leave/${ids.leave}/approve`);
    await call("POST", "/api/v1/leave/{id}/approve", admin(), "/api/v1/leave/missing/approve");
    const other = (await call("POST", "/api/v1/leave", admin({ employee: ids.emp, type: "unpaid", startDate: "2026-12-01" }))).body.id;
    await call("POST", "/api/v1/leave/{id}/reject", admin({ note: "Year end" }), `/api/v1/leave/${other}/reject`);
    await call("POST", "/api/v1/leave/{id}/reject", admin(), `/api/v1/leave/${other}/reject`);
    await call("POST", "/api/v1/leave/{id}/reject", admin(), "/api/v1/leave/missing/reject");
    await call("GET", "/api/v1/absences", admin(), "/api/v1/absences?from=2026-11-01&to=2026-11-30&pending=true");
    await call("GET", "/api/v1/absences", admin(), "/api/v1/absences?from=2026-11-30&to=2026-11-01");
    await call("GET", "/api/v1/payroll", admin(), "/api/v1/payroll?month=2026-11");
    await call("GET", "/api/v1/payroll", admin(), "/api/v1/payroll?month=2026-13");
    await call("POST", "/api/v1/leave/{id}/cancel", admin(), `/api/v1/leave/${ids.leave}/cancel`);
    await call("POST", "/api/v1/leave/{id}/cancel", admin(), `/api/v1/leave/${ids.leave}/cancel`);
    await call("POST", "/api/v1/leave/{id}/cancel", admin(), "/api/v1/leave/missing/cancel");
  });

  it("checklists", async () => {
    const { body } = await call("GET", "/api/v1/tasks", admin(), "/api/v1/tasks?all=true");
    const task = body.tasks[0].id;
    await call("GET", "/api/v1/tasks", admin());
    await call("POST", "/api/v1/tasks/{id}/done", admin(), `/api/v1/tasks/${task}/done`);
    await call("POST", "/api/v1/tasks/{id}/undo", admin(), `/api/v1/tasks/${task}/undo`);
    await call("POST", "/api/v1/tasks/{id}/done", admin(), "/api/v1/tasks/missing/done");
    await call("POST", "/api/v1/tasks/{id}/undo", admin(), "/api/v1/tasks/missing/undo");
  });

  it("import", async () => {
    await call(
      "POST",
      "/api/v1/import",
      admin({ csv: "first_name,last_name,work_email,start_date\nZeynep,Kara,zeynep@example.com,2021-02-01\n", dryRun: true }),
    );
    await call("POST", "/api/v1/import", admin({ csv: "name\nZeynep" }));
    await call("POST", "/api/v1/import", admin({ csv: "x".repeat(9 * 1024 * 1024) }));
  });

  it("deleting", async () => {
    await call("DELETE", "/api/v1/departments/{id}", admin(), `/api/v1/departments/${ids.dep}`);
    await call("DELETE", "/api/v1/positions/{id}", admin(), `/api/v1/positions/${ids.pos}`);
    // Identity made her account; it is turned off before her record can go.
    await app.hr.identityRound();
    await call("DELETE", "/api/v1/employees/{id}", admin(), `/api/v1/employees/${ids.emp}`);
    await call("PATCH", "/api/v1/employees/{id}", admin({ endDate: "2026-11-02" }), `/api/v1/employees/${ids.emp}`);
    app.clock.set(Date.parse("2026-11-02T15:00:00Z"));
    await app.hr.identityRound();
    await call("DELETE", "/api/v1/employees/{id}", admin(), `/api/v1/employees/${ids.emp}`);
    await call("DELETE", "/api/v1/employees/{id}", admin(), "/api/v1/employees/missing");
    await call("DELETE", "/api/v1/positions/{id}", admin(), `/api/v1/positions/${ids.pos}`);
    await call("DELETE", "/api/v1/positions/{id}", admin(), "/api/v1/positions/missing");
    await call("PATCH", "/api/v1/employees/{id}", admin({ department: null }), `/api/v1/employees/${ids.mgr}`);
    await call("DELETE", "/api/v1/departments/{id}", admin(), `/api/v1/departments/${ids.dep}`);
    await call("DELETE", "/api/v1/departments/{id}", admin(), "/api/v1/departments/missing");
  });

  it("refuses without sign-in", async () => {
    const { body } = await call("GET", "/api/v1/employees", {});
    expect(body.code).toBe("unauthenticated");
  });

  it("calls every operation", () => {
    const all = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`));
    expect(all.filter((o) => !covered.has(o))).toEqual([]);
  });
});
