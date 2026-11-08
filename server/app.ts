import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import type { Hr } from "./hr.ts";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";
import { HrError, type Actor, type ProblemCode } from "./store.ts";

export interface AppOptions {
  db: DatabaseSync;
  hr: Hr;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
}

function metricsText(hr: Hr, version: string) {
  return renderMetrics(version, { ...hr.gauges(), fileError: !!hr.settings().file?.error });
}

/** Serves only /metrics, for a port that is not exposed with the rest (HR_METRICS_PORT). */
export function createMetricsHandler(hr: Hr, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(hr, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

// Personal data: nothing is cached on the way, and the pages and the API reference run nothing from elsewhere.
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'`,
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data));

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  forbidden: "Forbidden",
  "not-found": "Not found",
  conflict: "Conflict",
  "rate-limited": "Too many requests",
  "payload-too-large": "Payload too large",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json");
}

async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 4 * limit) {
      req.destroy();
      break;
    }
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw new HrError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024)} KiB.`);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HrError(400, "invalid-json", "The body must be JSON.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Access = "none" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  who: Actor;
  body: () => Promise<unknown>;
}
interface Route {
  method: string;
  path: string;
  auth: Access;
  limit?: number;
  handle: (ctx: Ctx) => unknown;
}

export function createApp({ db, hr, version, auth, adminToken, webDir, docsDir, openapi, serveMetrics = true, products = [] }: AppOptions) {
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const noContent = (res: ServerResponse) => void res.writeHead(204, SECURITY_HEADERS).end();
  const created = (res: ServerResponse, data: unknown) => json(res, 201, data);
  const P = "/api/v1";

  // Every route but the version needs someone signed in. Employees have the user role; what they read and change
  // beyond the directory is decided per record by the file's access (core.ts), not here.
  const routes: Route[] = [
    { method: "GET", path: `${P}/version`, auth: "none", handle: () => ({ product: "hr", version }) },
    { method: "GET", path: `${P}/products`, auth: "user", handle: () => ({ products }) },
    { method: "GET", path: `${P}/me`, auth: "user", handle: ({ who }) => hr.me(who) },
    { method: "GET", path: `${P}/settings`, auth: "viewer", handle: () => hr.settings() },
    { method: "GET", path: `${P}/integrations`, auth: "viewer", handle: () => hr.integrations() },
    { method: "GET", path: `${P}/holidays`, auth: "user", handle: ({ url }) => ({ holidays: hr.holidays(url.searchParams) }) },

    { method: "GET", path: `${P}/departments`, auth: "user", handle: () => ({ departments: hr.listDepartments() }) },
    { method: "POST", path: `${P}/departments`, auth: "editor", handle: async ({ res, who, body }) => created(res, hr.createDepartment(who, await body())) },
    {
      method: "PATCH",
      path: `${P}/departments/:id`,
      auth: "editor",
      handle: async ({ who, params, body }) => hr.updateDepartment(who, params[0]!, await body()),
    },
    {
      method: "DELETE",
      path: `${P}/departments/:id`,
      auth: "editor",
      handle: ({ res, who, params }) => (hr.removeDepartment(who, params[0]!), noContent(res)),
    },
    { method: "GET", path: `${P}/positions`, auth: "user", handle: () => ({ positions: hr.listPositions() }) },
    { method: "POST", path: `${P}/positions`, auth: "editor", handle: async ({ res, who, body }) => created(res, hr.createPosition(who, await body())) },
    { method: "PATCH", path: `${P}/positions/:id`, auth: "editor", handle: async ({ who, params, body }) => hr.updatePosition(who, params[0]!, await body()) },
    { method: "DELETE", path: `${P}/positions/:id`, auth: "editor", handle: ({ res, who, params }) => (hr.removePosition(who, params[0]!), noContent(res)) },
    { method: "GET", path: `${P}/org-chart`, auth: "user", handle: () => hr.orgChart() },
    { method: "GET", path: `${P}/upcoming`, auth: "user", handle: ({ who, url }) => ({ events: hr.upcoming(who, url.searchParams) }) },

    { method: "GET", path: `${P}/employees`, auth: "user", handle: ({ who, url }) => ({ employees: hr.listEmployees(who, url.searchParams) }) },
    { method: "POST", path: `${P}/employees`, auth: "editor", handle: async ({ res, who, body }) => created(res, hr.createEmployee(who, await body())) },
    { method: "GET", path: `${P}/employees/:id`, auth: "user", handle: ({ who, params }) => hr.getEmployee(who, params[0]!) },
    { method: "PATCH", path: `${P}/employees/:id`, auth: "user", handle: async ({ who, params, body }) => hr.updateEmployee(who, params[0]!, await body()) },
    { method: "DELETE", path: `${P}/employees/:id`, auth: "admin", handle: ({ res, who, params }) => (hr.removeEmployee(who, params[0]!), noContent(res)) },
    { method: "GET", path: `${P}/employees/:id/history`, auth: "user", handle: ({ who, params }) => ({ history: hr.history(who, params[0]!) }) },
    { method: "GET", path: `${P}/employees/:id/national-id`, auth: "user", handle: ({ who, params }) => hr.nationalId(who, params[0]!) },
    { method: "GET", path: `${P}/employees/:id/access-log`, auth: "user", handle: ({ who, params }) => ({ entries: hr.accessLog(who, params[0]!) }) },
    { method: "GET", path: `${P}/employees/:id/pay`, auth: "user", handle: ({ who, params }) => ({ pay: hr.listPay(who, params[0]!) }) },
    {
      method: "POST",
      path: `${P}/employees/:id/pay`,
      auth: "editor",
      handle: async ({ res, who, params, body }) => created(res, hr.addPay(who, params[0]!, await body())),
    },
    { method: "GET", path: `${P}/employees/:id/documents`, auth: "user", handle: ({ who, params }) => ({ documents: hr.listDocuments(who, params[0]!) }) },
    {
      method: "POST",
      path: `${P}/employees/:id/documents`,
      auth: "user",
      limit: 15 * 1024 * 1024,
      handle: async ({ res, who, params, body }) => created(res, hr.addDocument(who, params[0]!, await body())),
    },
    { method: "GET", path: `${P}/employees/:id/balances`, auth: "user", handle: ({ who, params }) => ({ balances: hr.balances(who, params[0]!) }) },
    { method: "POST", path: `${P}/employees/:id/balances`, auth: "editor", handle: async ({ who, params, body }) => hr.adjust(who, params[0]!, await body()) },
    { method: "GET", path: `${P}/employees/:id/checklists`, auth: "user", handle: ({ who, params }) => ({ checklists: hr.checklists(who, params[0]!) }) },

    {
      method: "GET",
      path: `${P}/documents/:id`,
      auth: "user",
      handle: ({ res, who, params }) => {
        const f = hr.documentFile(who, params[0]!);
        send(res, 200, f.content, f.type, { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}` });
      },
    },
    { method: "DELETE", path: `${P}/documents/:id`, auth: "editor", handle: ({ res, who, params }) => (hr.removeDocument(who, params[0]!), noContent(res)) },
    {
      method: "GET",
      path: `${P}/expiring-documents`,
      auth: "user",
      handle: ({ who, url }) => ({ documents: hr.expiring(who, url.searchParams.get("all") === "true") }),
    },
    { method: "GET", path: `${P}/checklists`, auth: "user", handle: ({ who }) => ({ checklists: hr.openChecklists(who) }) },
    { method: "GET", path: `${P}/balances`, auth: "user", handle: ({ who, url }) => ({ balances: hr.balanceList(who, url.searchParams) }) },

    { method: "GET", path: `${P}/tasks`, auth: "user", handle: ({ who, url }) => ({ tasks: hr.tasks(who, url.searchParams.get("all") === "true") }) },
    { method: "POST", path: `${P}/tasks/:id/done`, auth: "user", handle: ({ who, params }) => hr.setTask(who, params[0]!, true) },
    { method: "POST", path: `${P}/tasks/:id/undo`, auth: "user", handle: ({ who, params }) => hr.setTask(who, params[0]!, false) },

    { method: "GET", path: `${P}/leave`, auth: "user", handle: ({ who, url }) => ({ requests: hr.listLeave(who, url.searchParams) }) },
    { method: "POST", path: `${P}/leave`, auth: "user", handle: async ({ res, who, body }) => created(res, hr.createLeave(who, await body())) },
    { method: "POST", path: `${P}/leave/quote`, auth: "user", handle: async ({ who, body }) => hr.quoteLeave(who, await body()) },
    { method: "GET", path: `${P}/leave/:id`, auth: "user", handle: ({ who, params }) => hr.getLeave(who, params[0]!) },
    {
      method: "POST",
      path: `${P}/leave/:id/approve`,
      auth: "user",
      handle: async ({ who, params, body }) => hr.decideLeave(who, params[0]!, await body(), "approved"),
    },
    {
      method: "POST",
      path: `${P}/leave/:id/reject`,
      auth: "user",
      handle: async ({ who, params, body }) => hr.decideLeave(who, params[0]!, await body(), "rejected"),
    },
    { method: "POST", path: `${P}/leave/:id/cancel`, auth: "user", handle: ({ who, params }) => hr.cancelLeave(who, params[0]!) },
    { method: "GET", path: `${P}/absences`, auth: "user", handle: ({ who, url }) => ({ absences: hr.absences(who, url.searchParams) }) },

    { method: "POST", path: `${P}/import`, auth: "editor", limit: 8 * 1024 * 1024, handle: async ({ who, body }) => hr.importCsv(who, await body()) },
    // What Payroll reads.
    { method: "GET", path: `${P}/payroll`, auth: "viewer", handle: ({ who, url }) => hr.payroll(who, url.searchParams) },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  function authorize(req: IncomingMessage, access: Access): Actor {
    if (access === "none") return { id: "anonymous", name: "Anonymous", role: "user", email: null };
    if (tokenMatches(req.headers.authorization, adminToken)) return { id: "admin-token", name: "Admin token", role: "admin", email: null };
    const p = auth.authorize(req, access);
    return p.kind === "session"
      ? { id: p.user.id, name: p.user.name, role: p.role, email: p.user.email }
      : { id: `token:${p.tokenId}`, name: p.name, role: p.role, email: null };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");
    if (path === "/readyz") {
      try {
        db.prepare("SELECT 1").get();
        if (!hr.config()) throw new Error("no settings");
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "not ready" });
      }
      return "/readyz";
    }
    if (path === "/metrics") {
      if (serveMetrics) send(res, 200, metricsText(hr, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }
    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");
    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      if (!(await serveFile(res, docsDir, path.slice("/api/docs/".length) || "index.html"))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const who = authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url, params, who, body: () => readJson(req, r.limit ?? 1024 * 1024) });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof HrError)) throw err;
        problem(res, err.status, err.code, err.message);
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url?.split("?")[0] });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    // Query strings can carry names; only the path is logged.
    if (!["/healthz", "/metrics"].includes(routeName)) {
      log("info", "request", { method: req.method, path: (req.url ?? "/").split("?")[0], status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}
