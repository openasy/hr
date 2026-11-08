// What the parts of HR share: the error the API turns into a problem, who does something, the database helpers and
// the checks that read a request's fields.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Role } from "@openasy/auth";
import { isDay } from "./dates.ts";

export type ProblemCode =
  "invalid-token" | "invalid-json" | "invalid-body" | "forbidden" | "not-found" | "conflict" | "rate-limited" | "payload-too-large" | "internal-error";

export class HrError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Who does something: a signed-in member (with their email), an API token, or the tests' admin token. */
export interface Actor {
  id: string;
  name: string;
  role: Role;
  email?: string | null;
}

export const bad = (message: string) => new HrError(422, "invalid-body", message);
export const notFound = (what: string) => new HrError(404, "not-found", `${what} does not exist.`);
export const forbidden = (message: string) => new HrError(403, "forbidden", message);
export const conflict = (message: string) => new HrError(409, "conflict", message);
export const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function createStore(db: DatabaseSync, clock: () => number) {
  let depth = 0;
  return {
    db,
    clock,
    iso: (ms = clock()) => new Date(ms).toISOString(),
    q: <T>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as T[],
    one: <T>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).get(...args) as T | undefined,
    run: (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).run(...args),
    /** One write transaction; BEGIN IMMEDIATE so a check and the write after it cannot be split by another writer. */
    tx<T>(fn: () => T): T {
      if (depth > 0) return fn();
      db.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      } finally {
        depth--;
      }
    },
  };
}
export type Store = ReturnType<typeof createStore>;

/** The body as a map, or a 422 that says what it takes. */
export function body(v: unknown, takes: string[]): Record<string, unknown> {
  if (!isObj(v)) throw bad(`The body is a JSON object with ${takes.join(", ")}.`);
  const extra = Object.keys(v).filter((k) => !takes.includes(k));
  if (extra.length) throw bad(`unknown ${extra.join(", ")}; it takes ${takes.join(", ")}.`);
  return v;
}

export function text(v: unknown, field: string, max = 200): string {
  if (typeof v !== "string" || !v.trim() || v.trim().length > max) throw bad(`${field} is a text of 1 to ${max} characters.`);
  return v.trim();
}

/** A text field that may be left out (undefined), cleared (null or ""), or set. */
export function optText(v: unknown, field: string, max = 200): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || (typeof v === "string" && !v.trim())) return null;
  return text(v, field, max);
}

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
export function optEmail(v: unknown, field = "email"): string | null | undefined {
  const s = optText(v, field, 254);
  if (s === undefined || s === null) return s;
  if (!EMAIL.test(s)) throw bad(`${field} is an email address.`);
  return s.toLowerCase();
}

export function optDay(v: unknown, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (!isDay(v)) throw bad(`${field} is a day, YYYY-MM-DD.`);
  return v;
}

export function day(v: unknown, field: string): string {
  const d = optDay(v, field);
  if (!d) throw bad(`${field} is a day, YYYY-MM-DD.`);
  return d;
}

export function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !allowed.includes(v as T)) throw bad(`${field} is ${allowed.join(", ")}.`);
  return v as T;
}

/** T.C. kimlik numarası: eleven digits, the first not 0, with its two check digits. */
export function validTckn(s: string): boolean {
  if (!/^[1-9]\d{10}$/.test(s)) return false;
  const d = [...s].map(Number);
  const odd = d[0]! + d[2]! + d[4]! + d[6]! + d[8]!;
  const even = d[1]! + d[3]! + d[5]! + d[7]!;
  const ten = (((odd * 7 - even) % 10) + 10) % 10;
  const eleven = d.slice(0, 10).reduce((a, b) => a + b, 0) % 10;
  return d[9] === ten && d[10] === eleven;
}

/** An IBAN with a valid check (ISO 13616), spaces removed and upper case. */
export function validIban(raw: string): string | null {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return null;
  if (s.startsWith("TR") && s.length !== 26) return null;
  const moved = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const c of moved) {
    const n = c >= "A" ? String(c.charCodeAt(0) - 55) : c;
    for (const digit of n) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1 ? s : null;
}
