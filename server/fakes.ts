// A fake of Identity's SCIM 2.0 endpoint for the tests, answering as identity/server/scim.ts does: the bearer token,
// `userName eq` and `displayName eq` filters, 409 for a person or group that exists, PUT and PATCH active on people,
// and PATCH add and remove on members. A group made by hand in Identity (not by SCIM) is refused with 409, as there.
// It is not Identity: what passes here is tested against this fake only.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const IDENTITY_TOKEN = "oisc_test-provisioning-token";

interface User {
  id: string;
  userName: string;
  externalId: string | null;
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  active: boolean;
}
interface Group {
  id: string;
  displayName: string;
  members: Set<string>;
  scim: boolean;
}

async function read(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export async function startIdentity() {
  const users = new Map<string, User>();
  const groups = new Map<string, Group>();
  const calls: Array<{ method: string; path: string }> = [];
  const state = { down: false };

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    if (body === undefined) return void res.writeHead(status).end();
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/scim+json" }).end(text);
  };
  const error = (res: ServerResponse, status: number, detail: string) =>
    send(res, status, { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: String(status), detail });
  const toUser = (u: User) => ({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: u.id,
    userName: u.userName,
    displayName: u.displayName,
    active: u.active,
    emails: [{ value: u.userName, primary: true }],
  });
  const toGroup = (g: Group) => ({ id: g.id, displayName: g.displayName, members: [...g.members].map((value) => ({ value })) });
  const list = (rows: unknown[]) => ({ schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: rows.length, Resources: rows });
  const filter = (url: URL) => /^\s*(\w+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(url.searchParams.get("filter") ?? "");

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    calls.push({ method: req.method ?? "GET", path: url.pathname + url.search });
    if (state.down) return error(res, 503, "Identity is starting.");
    if (req.headers.authorization !== `Bearer ${IDENTITY_TOKEN}`)
      return error(res, 401, "Send the SCIM token from Identity, Settings, Provisioning, as a bearer token.");
    const [, scim, v2, kind, id] = url.pathname.split("/");
    if (scim !== "scim" || v2 !== "v2") return error(res, 404, "Not found.");
    const body = req.method === "GET" ? {} : await read(req);
    if (kind === "Users" && !id && req.method === "GET") {
      const f = filter(url);
      return send(res, 200, list([...users.values()].filter((u) => !f || u.userName.toLowerCase() === f[2]!.toLowerCase()).map(toUser)));
    }
    if (kind === "Users" && !id && req.method === "POST") {
      const userName = String(body.userName ?? "").toLowerCase();
      if ([...users.values()].some((u) => u.userName === userName)) return error(res, 409, `${userName} exists.`);
      const name = (body.name ?? {}) as Record<string, string>;
      const u: User = {
        id: randomUUID(),
        userName,
        externalId: (body.externalId as string) ?? null,
        displayName: String(body.displayName),
        givenName: name.givenName ?? null,
        familyName: name.familyName ?? null,
        active: body.active !== false,
      };
      users.set(u.id, u);
      return send(res, 201, toUser(u));
    }
    const u = id ? users.get(id) : undefined;
    if (kind === "Users" && id && !u) return error(res, 404, `No user ${id}.`);
    if (kind === "Users" && u && req.method === "PUT") {
      const name = (body.name ?? {}) as Record<string, string>;
      Object.assign(u, {
        userName: String(body.userName ?? u.userName).toLowerCase(),
        displayName: String(body.displayName ?? u.displayName),
        givenName: name.givenName ?? u.givenName,
        familyName: name.familyName ?? u.familyName,
        active: body.active === undefined ? u.active : body.active === true,
      });
      return send(res, 200, toUser(u));
    }
    if (kind === "Users" && u && req.method === "PATCH") {
      for (const op of (body.Operations as Array<Record<string, unknown>>) ?? []) if (String(op.path).toLowerCase() === "active") u.active = op.value === true;
      return send(res, 200, toUser(u));
    }
    if (kind === "Groups" && !id && req.method === "GET") {
      const f = filter(url);
      return send(res, 200, list([...groups.values()].filter((g) => g.scim && (!f || g.displayName.toLowerCase() === f[2]!.toLowerCase())).map(toGroup)));
    }
    if (kind === "Groups" && !id && req.method === "POST") {
      const name = String(body.displayName ?? "");
      if ([...groups.values()].some((g) => g.displayName === name)) return error(res, 409, `A group named ${name} exists.`);
      const g: Group = { id: randomUUID(), displayName: name, members: new Set(), scim: true };
      groups.set(g.id, g);
      return send(res, 201, toGroup(g));
    }
    const g = id ? groups.get(id) : undefined;
    if (kind === "Groups" && g?.scim && req.method === "PATCH") {
      for (const op of (body.Operations as Array<Record<string, unknown>>) ?? []) {
        const one = /^members\[value eq "([^"]+)"\]$/i.exec(String(op.path ?? ""))?.[1];
        if (op.op === "add") for (const m of op.value as Array<{ value: string }>) g.members.add(m.value);
        else if (op.op === "remove" && one) g.members.delete(one);
      }
      return send(res, 200, toGroup(g));
    }
    return error(res, 404, "Not found.");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    base,
    users,
    groups,
    calls,
    state,
    /** A group someone made by hand in Identity, which SCIM may not change. */
    manualGroup(name: string) {
      groups.set(randomUUID(), { id: randomUUID(), displayName: name, members: new Set(), scim: false });
    },
    byEmail: (email: string) => [...users.values()].find((u) => u.userName === email),
    groupByName: (name: string) => [...groups.values()].find((g) => g.displayName === name),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type FakeIdentity = Awaited<ReturnType<typeof startIdentity>>;
