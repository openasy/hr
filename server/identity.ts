// The link to OpenAsy Identity, through its SCIM 2.0 endpoint (identity/README.md, SCIM; identity/server/scim.ts),
// with the provisioning token made in Identity under Settings, Provisioning. HR is the provider here, as Okta or
// Microsoft Entra ID would be:
//
// - a person is found by `userName eq "<work email>"` and made with POST /scim/v2/Users when not there;
// - turned off with PATCH active false on the end date, which ends their sessions in Identity and so in every
//   application signed in through it; turned on again with active true if they come back;
// - put in their department's group and in the groups every employee is in: the group is found by
//   `displayName eq "<name>"` or made with POST /scim/v2/Groups, and members are added and removed with PATCH. Identity
//   lets SCIM change only the groups SCIM made.
export class IdentityError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export interface Person {
  /** HR's id, sent as externalId. */
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string;
}

export interface IdentityLink {
  /**
   * The account's id at Identity, turned on and up to date: the one HR made before when `known` is given (so a changed
   * work email changes that account), else found by email or made.
   */
  provision(p: Person, known?: string | null): Promise<string>;
  /** Turns the account off; false when Identity no longer has it. */
  disable(id: string): Promise<boolean>;
  /** The group's id, found by name or made. */
  group(name: string, externalId: string): Promise<string>;
  addMember(groupId: string, userId: string): Promise<void>;
  removeMember(groupId: string, userId: string): Promise<void>;
}

type Json = Record<string, unknown>;
const esc = (s: string) => s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

export function identityLink(o: { url: string; token: string | undefined; fetch?: typeof fetch }): IdentityLink {
  const f = o.fetch ?? fetch;
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json | null }> {
    if (!o.token) throw new IdentityError("The Identity provisioning token is not set.");
    let res: Response;
    try {
      res = await f(`${o.url}/scim/v2${path}`, {
        method,
        headers: {
          authorization: `Bearer ${o.token}`,
          accept: "application/scim+json",
          ...(body !== undefined && { "content-type": "application/scim+json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
    } catch (err) {
      throw new IdentityError(`Identity could not be reached: ${(err as Error).message}`);
    }
    const text = await res.text();
    let parsed: Json | null = null;
    try {
      parsed = text ? (JSON.parse(text) as Json) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  }
  const fail = (what: string, r: { status: number; body: Json | null }) =>
    new IdentityError(`Identity answered ${r.status} to ${what}${typeof r.body?.detail === "string" ? `: ${r.body.detail}` : ""}`, r.status);
  const first = (r: { body: Json | null }) => {
    const list = r.body?.Resources;
    return Array.isArray(list) && list[0] && typeof (list[0] as Json).id === "string" ? String((list[0] as Json).id) : null;
  };

  async function findUser(email: string) {
    const r = await call("GET", `/Users?${new URLSearchParams({ filter: `userName eq "${esc(email)}"` })}`);
    if (r.status !== 200) throw fail("the search for the person", r);
    return first(r);
  }

  return {
    async provision(p, known) {
      const user = {
        schemas: [USER],
        userName: p.email,
        externalId: `hr:${p.id}`,
        name: { givenName: p.firstName, familyName: p.lastName, formatted: p.displayName },
        displayName: p.displayName,
        emails: [{ value: p.email, type: "work", primary: true }],
        active: true,
      };
      if (known) {
        const r = await call("PUT", `/Users/${encodeURIComponent(known)}`, user);
        if (r.status === 200) return known;
        if (r.status !== 404) throw fail("changing the person", r);
      }
      let id = await findUser(p.email);
      if (!id) {
        const r = await call("POST", "/Users", user);
        if (r.status === 201 && typeof r.body?.id === "string") return r.body.id;
        // Made by someone else in between: find it again.
        if (r.status === 409) id = await findUser(p.email);
        if (!id) throw fail("making the person", r);
      }
      const r = await call("PUT", `/Users/${encodeURIComponent(id)}`, user);
      if (r.status !== 200) throw fail("changing the person", r);
      return id;
    },
    async disable(id) {
      const r = await call("PATCH", `/Users/${encodeURIComponent(id)}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "active", value: false }] });
      if (r.status === 404) return false;
      if (r.status !== 200) throw fail("turning the person off", r);
      return true;
    },
    async group(name, externalId) {
      const found = await call("GET", `/Groups?${new URLSearchParams({ filter: `displayName eq "${esc(name)}"` })}`);
      if (found.status !== 200) throw fail("the search for the group", found);
      const id = first(found);
      if (id) return id;
      const r = await call("POST", "/Groups", { schemas: [GROUP], displayName: name, externalId });
      if (r.status === 201 && typeof r.body?.id === "string") return r.body.id;
      if (r.status === 409)
        throw new IdentityError(`Identity has a group named ${name} that it keeps by hand; SCIM can change only groups it made. Rename one of them.`, 409);
      throw fail("making the group", r);
    },
    async addMember(groupId, userId) {
      const r = await call("PATCH", `/Groups/${encodeURIComponent(groupId)}`, {
        schemas: [PATCH],
        Operations: [{ op: "add", path: "members", value: [{ value: userId }] }],
      });
      if (r.status !== 200) throw fail("adding the person to a group", r);
    },
    async removeMember(groupId, userId) {
      const r = await call("PATCH", `/Groups/${encodeURIComponent(groupId)}`, {
        schemas: [PATCH],
        Operations: [{ op: "remove", path: `members[value eq "${esc(userId)}"]` }],
      });
      if (r.status !== 200 && r.status !== 404) throw fail("taking the person out of a group", r);
    },
  };
}
