// Starts the app on a random port for tests, with a fake Identity, a mailer that keeps what it is given and a clock the
// test moves by hand.
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { IDENTITY_TOKEN, startIdentity } from "./fakes.ts";
import { createHr } from "./hr.ts";
import type { Mail, Mailer } from "./mail.ts";
import { createKeyring } from "./seal.ts";
import type { Actor } from "./store.ts";

export const ADMIN_TOKEN = "test-admin-token";
export const KEK = Buffer.alloc(32, 7);

/** Members: Selin is HR (editor), Okan an admin, Veli a viewer (Payroll's token would be one), the rest employees. */
export const SELIN: Actor = { id: "user-selin", name: "Selin Aydın", role: "editor", email: "selin@example.com" };
export const OKAN: Actor = { id: "user-okan", name: "Okan Demir", role: "admin", email: "okan@example.com" };
export const VELI: Actor = { id: "user-veli", name: "Veli Kaya", role: "viewer", email: "veli@example.com" };
export const MERT: Actor = { id: "user-mert", name: "Mert Şahin", role: "user", email: "mert@example.com" };
export const AYSE: Actor = { id: "user-ayse", name: "Ayşe Yılmaz", role: "user", email: "ayse@example.com" };
export const CAN: Actor = { id: "user-can", name: "Can Öztürk", role: "user", email: "can@example.com" };
export const DENIZ: Actor = { id: "user-deniz", name: "Deniz Arslan", role: "user", email: "deniz@example.com" };
const MEMBERS = [SELIN, OKAN, VELI, MERT, AYSE, CAN, DENIZ];

/** The settings file the tests start with; IDENTITY_URL is replaced with the fake's address. */
export const SETTINGS = `
time_zone: Europe/Istanbul
language: en
locations:
  istanbul: { name: İstanbul }
  izmir: { name: İzmir factory, work_week: [mon, tue, wed, thu, fri, sat] }
notify:
  hr: [hr@example.com]
mail: { host: localhost, port: 2525, security: none, from: HR <hr@example.com> }
identity:
  url: IDENTITY_URL
  token: HR_IDENTITY_TOKEN
  create_at: "07:00"
  disable_at: "18:00"
  groups: { departments: true, all: [Employees] }
`;

/** A clock the test moves by hand: Monday 2 November 2026, 09:00 in Istanbul. */
export function fakeClock(start = Date.parse("2026-11-02T06:00:00Z")) {
  let t = start;
  return Object.assign(() => t, { advance: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) });
}

export async function startApp(opts: Partial<AppOptions> & { version?: string; settings?: string } = {}) {
  const identity = await startIdentity();
  const db = openDb(":memory:");
  const { settings = SETTINGS, version = "0.1.0", ...rest } = opts;
  const clock = fakeClock();
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "hr", productName: "OpenAsy HR", origin: base, users: true });
  for (const m of MEMBERS)
    db.prepare("INSERT INTO auth_users (id, email, name, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)").run(
      m.id,
      m.email!,
      m.name,
      m.role,
      new Date().toISOString(),
    );
  const mails: Mail[] = [];
  const mailer: Mailer & { fail: boolean } = {
    fail: false,
    async send(m) {
      if (this.fail) throw new Error("connect ECONNREFUSED");
      mails.push(m);
    },
    close() {},
  };
  const hr = createHr(db, {
    publicUrl: base,
    keyring: createKeyring(KEK),
    clock,
    env: { HR_IDENTITY_TOKEN: IDENTITY_TOKEN },
    mailer: (c) => (c.mail ? mailer : null),
  });
  const text = settings.replaceAll("IDENTITY_URL", identity.base);
  hr.setConfig(parseConfig(text), text);
  handler = createApp({ db, hr, auth, adminToken: ADMIN_TOKEN, version, ...rest });
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers } });
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await identity.close();
  };
  /** Finance and Engineering, a manager (Mert) with two reports (Ayşe, Can), and Deniz who reports to Ayşe. */
  function seed() {
    const finance = hr.createDepartment(SELIN, { name: "Finance" });
    const eng = hr.createDepartment(SELIN, { name: "Engineering" });
    const analyst = hr.createPosition(SELIN, { title: "Analyst", department: finance.id });
    const mert = hr.createEmployee(SELIN, {
      firstName: "Mert",
      lastName: "Şahin",
      workEmail: MERT.email,
      department: finance.id,
      startDate: "2015-03-01",
      birthDate: "1980-05-10",
      location: "istanbul",
    });
    const ayse = hr.createEmployee(SELIN, {
      firstName: "Ayşe",
      lastName: "Yılmaz",
      workEmail: AYSE.email,
      department: finance.id,
      position: analyst.id,
      manager: mert.id,
      startDate: "2026-12-01",
      birthDate: "1994-02-14",
      nationalId: "10000000146",
      phone: "+90 532 000 00 12",
      iban: "TR33 0006 1005 1978 6457 8413 26",
      location: "istanbul",
    });
    const can = hr.createEmployee(SELIN, {
      firstName: "Can",
      lastName: "Öztürk",
      workEmail: CAN.email,
      department: eng.id,
      manager: mert.id,
      startDate: "2024-06-10",
    });
    const deniz = hr.createEmployee(SELIN, {
      firstName: "Deniz",
      lastName: "Arslan",
      workEmail: DENIZ.email,
      department: finance.id,
      manager: ayse.id,
      startDate: "2026-12-01",
    });
    return { finance, eng, analyst, mert, ayse, can, deniz };
  }
  return { db, hr, auth, base, admin, clock, identity, mails, mailer, close, seed };
}

export type TestApp = Awaited<ReturnType<typeof startApp>>;
