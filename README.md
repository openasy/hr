# hr

[![CI](https://github.com/openasy/hr/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/hr/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) HR product: each employee's record, contract dates, manager, department and
position, the org chart, documents with expiry dates, leave with balances and approvals by the rules in a file, with
Turkish labour law as the default, joining and leaving checklists, the history of every change and a log of every look
at a record. On a start day Identity makes the person's account in their department's group; on the end day it turns
it off.

**This release is the server and its API.** There are no screens yet: they come once the HR designs are in the
[ui](https://github.com/openasy/ui) Storybook, so the repository has no `web/` folder and the image serves only the
API and its reference at `/api/docs/`.

```
hr.yaml ──▶ hr ──▶ Identity: SCIM 2.0 /scim/v2 (accounts and groups follow joining, moving and leaving)
            │ ▲
            │ └── Payroll: GET /api/v1/payroll?month=   Time, Calendar: GET /api/v1/absences
            └──▶ SMTP: leave to approve, decisions, documents that expire
```

## Records and who reads them

A record has a **directory** part that everyone signed in reads (name, work email, department, position, manager,
location, start day) and five parts the file's `access` gives out:

| Part | Holds | Read by default by |
| --- | --- | --- |
| `work` | employee number, employment type, service start, probation end, contract and its end, end day and reason | the person, their managers, viewer and above |
| `personal` | birth date, gender, marital status, T.C. kimlik no, nationality, phone, personal email, address, emergency contact | the person, editor and above |
| `pay` | salary over time, IBAN and bank | the person, viewer and above |
| `documents` | contracts, ID copies, permits, reports | the person, editor and above |
| `leave` | requests with their types, balances | the person, their managers, viewer and above |

**Managers** are everyone above a person in the reporting line, not only their direct manager. **Roles** are the
members' roles (ADR 0003): employees sign in with the **user** role; **viewer** is for read-only HR staff and for the
tokens of other products such as Payroll; **editor** is HR, who change records; **admins** read everything and delete
records. A role in the file means that role and those above it. People change their own phone, personal email,
address and emergency contact; everything else is HR's.

**Every look is logged.** Reading a record, its history, its pay, its documents or its balances, downloading a
document, and Payroll's month write who, when, as whom and which parts to the record's access log and to the JSON log.
The person and admins read a record's access log (KVKK md. 11). Every change is in the record's history field by field,
shown to those who read that part.

**Encrypted at rest.** The personal part, the bank account, every salary, every document, leave notes and the history
of the personal and pay parts are encrypted with AES-256-GCM, each value with its own data key wrapped by the install's
key, `openasy-kek` (ADR 0021), and bound to its record and field. A backup of `/data` holds only ciphertext. The
T.C. kimlik number is also kept as a keyed hash, so a second record with the same number is refused without decrypting
any. HR does not start without the key. What stays in clear is what lists and rules need: names, work email, department,
position, manager, location and dates.

T.C. kimlik numbers are checked by their check digits and IBANs by theirs (ISO 13616).

## Leave

Leave types, their rules and the approval rules are in the file. Without a file HR uses Türkiye's:

| Type | Rule |
| --- | --- |
| `annual` | Granted on each anniversary of service (İş Kanunu md. 53): nothing in the first year, 14 days for one to five years, 20 from the sixth year, 26 from the fifteenth. At least 20 days for people of 18 or younger or 50 or older on the day of the grant. Counted in working days (md. 56). Unused days carry over: they do not expire. |
| `marriage`, `bereavement`, `adoption` | 3 working days a request, paid |
| `paternity` | 5 working days a request, paid |
| `maternity` | Up to 126 calendar days (16 weeks, 18 for more than one child, md. 74), unpaid by you (SGK pays), with a health report, approved by HR |
| `sick` | Calendar days, unpaid by you, with a health report, approved by HR; colleagues see only that the person is away |
| `unpaid` | Working days, approved by the manager and HR |

- **Days a leave takes.** Working-day types leave out the week's days off (`work_week`, per location) and public
  holidays; a half-day holiday such as the eve of a Bayram or 28 October takes half a day. A request may start at noon
  or end at noon where the type allows half days. `POST /api/v1/leave/quote` shows the count day by day before asking.
- **Service.** Anniversaries count from `serviceStart`, the start of service with you, which may be before the start
  day in HR (md. 54). Grants are written for anniversaries from the day the record was added to HR; what someone earned
  before is an opening balance (`POST /api/v1/employees/{id}/balances`, or `annual_leave` in the CSV import).
- **Balance.** Granted and adjusted days, less expired days and approved requests. Pending requests are held against
  it. A request may take it down to minus `advance`. A type with a yearly grant may cap what carries over
  (`carry_over`); what is above the cap expires when the next year's days come.
- **Public holidays.** Türkiye's national holidays are built in; Ramazan and Kurban Bayramı are built in for 2025 to
  2027, as the Presidency of Religious Affairs announced them. HR warns when this year or next has none: add them under
  `holidays.add`. The eve of each Bayram and 28 October are half days.
- **Approvals.** A request goes through the steps of its type's rule as the rule was when it was made: `manager`,
  `second_manager`, `hr` (any editor) or a member's email. A step with nobody to take it (no manager, or the person
  themselves) is left out, and a rule left with no step goes to HR. `[]` approves at once. Each approver is emailed in
  turn; the person is emailed the decision. Nobody approves their own leave. Editors can decide any step, and can record
  leave already agreed as approved. Overlapping requests are refused, except the two halves of one day.
- **Cancelling.** The person cancels a request until it starts; editors at any time. Its days go back to the balance.
- **Who is away.** `GET /api/v1/absences` lists approved leave, and pending leave when asked, for everyone signed in.
  The type is shown to those who read the person's leave, and to everyone for types with `shown_to_colleagues`.

Not enforced: md. 56's rule that one part of split annual leave is at least ten days, the four days of unpaid travel
leave, and the extra days collective agreements give; HR records what is agreed.

## Documents

Each document has a kind from the file. PDF, PNG and JPEG up to 10 MiB, checked to be what they say. A kind with
`expires: true` needs an expiry day; HR is emailed once when a document comes within its kind's `warn_before`, and
`GET /api/v1/expiring-documents` lists what has expired or soon will. People add documents to their own record, such
as a health report, and a leave request can name one.

## Joining and leaving

A checklist `on: start` starts for each new employee, anchored on their start day; one `on: end` starts when an end
day is set. Each task is for `hr`, the person's `manager`, the `employee` or a member's email, and is due some days
from the day (`due: -3d`). Moving the day moves the open tasks; clearing the end day cancels the leaving checklist.
`GET /api/v1/tasks` lists what is open for the caller.

**Identity.** With `identity` in the file, HR keeps each account at OpenAsy Identity as the record says, through
Identity's SCIM 2.0 endpoint (`/scim/v2`, see Identity's README) and its provisioning token from Identity, Settings,
Provisioning:

- on the start day at `create_at` (or `create_days_before` days earlier) the account is made, or found by work email
  and turned on, with `externalId` `hr:<id>`, and put in the department's group (the department's `identityGroup`, its
  name by default) and in `groups.all`;
- a changed name, work email or department changes the same account and moves it between groups. HR takes the person
  out only of the groups it put them in;
- on the end day at `disable_at` the account is turned off (`active: false`), which ends their sessions in Identity
  and so in every application signed in through it. The leaving checklist shows whether it is off. Clearing the end
  day turns it on again.

Products that sign in through Identity follow its groups. A failure is tried again after 1, 2, 4 minutes and
so on up to an hour, never given up, and shown on the record, under `GET /api/v1/integrations` and in
`openasy_hr_identity_failing`. Identity lets SCIM change only groups SCIM made: a group of the same name made by hand
there is reported, not changed. Identity has one provisioning token: if Okta or Entra ID already provision it, HR and
they would share it and both change the same people; use one of them.

## What other products read

**Payroll** reads `GET /api/v1/payroll?month=2026-11` with a token of the viewer role: everyone who worked a day of the
month, with their number, dates, employment type, current pay, IBAN, T.C. kimlik number (when the token reads the
personal part), leave days in the month by type and whether each is paid, and the annual balance (paid out on leaving,
md. 59). Each person's look is logged.

**Time** reads people, departments and managers from `GET /api/v1/employees` and leave from `GET /api/v1/absences`.
**Calendar** reads `GET /api/v1/absences?from=&to=` and shows each as busy for the person's work email. A caller
that does not read the person's leave sees that they are away, not the type.

Payroll, Time and Calendar are not built yet; these are HR's side of the links their stories name.

## CSV import

`POST /api/v1/import` with the file's text, comma or semicolon separated, with a header in English or Turkish
(`first_name` or `Ad`, `work_email` or `E-posta`, `start_date` or `İşe Giriş Tarihi`, `tckn`, `maaş`,
`yıllık_izin_bakiyesi` and the rest). People are matched by work email or number and updated; departments and
positions are made by name; managers are linked by work email after every row is read. Days may be `2021-02-01` or
`01.02.2021`, amounts `65.000,00`. `dryRun` checks every row and changes nothing; rows with a mistake are listed and
the others imported.

## Retention

A record is deleted `retention.after_leaving` after the end day (10 years by default), with its documents, leave,
pay, history and access log, once its Identity account is off; only that a record was deleted, its number and when are
kept. Admins can delete a record earlier. The access log is kept `retention.access_log` (2 years). What you must keep,
and for how long, is a legal question for you.

## The settings file

Everything but the records is in [config/hr.yaml](./config/hr.yaml), read at start and again within a minute of a
change, applied whole or not at all; a file with a mistake leaves the last good version in place. `GET /api/v1/settings`
shows it as applied.

| Key | Default | |
| --- | --- | --- |
| `time_zone`, `language` | `Europe/Istanbul`, `tr` | `language` is the emails': `tr`, `en` or `de` |
| `work_week` | `[mon, tue, wed, thu, fri]` | |
| `locations.<id>` | | `{ name, work_week }` |
| `holidays` | `country: tr` | `{ country: tr \| none, add: [{ date, name, half }], remove: [day] }` |
| `leave_types.<id>` | Türkiye's, above | `{ name, paid, counts, accrual, days \| by_seniority, at_least, prorate, carry_over, advance, per_request, half_days, document, approval, shown_to_colleagues }` |
| `approvals.<id>` | `standard: [manager, hr]`, `manager`, `hr`, `none` | a list of `manager`, `second_manager`, `hr` or a member's email |
| `documents.<id>` | contract, id-copy, health-report, work-permit, certificate, other | `{ name, expires, warn_before }` |
| `checklists.<id>` | joining and leaving | `{ name, on: start \| end, tasks: [{ id, text, who, due }] }` |
| `access` | above | `<part>: [self, manager, viewer, editor]` |
| `retention` | `10y`, `2y` | `{ after_leaving, access_log }` |
| `notify.hr` | | addresses for leave waiting on HR and documents that expire |
| `mail` | | `{ host, port, security, user, password, from }`; `password` names a variable |
| `identity` | | `{ url, token, create_at, create_days_before, disable_at, groups: { departments, all } }`; `token` names a variable |

Names in the file are a text, or `{ tr, en, de }`.

## Run

```bash
openssl rand -hex 32 > openasy-kek
$EDITOR config/hr.yaml
docker compose up -d
docker compose logs hr | grep 'no owner yet'
```

The first start prints a one-time link that creates the owner account (ADR 0013). Until the screens exist it opens
nothing; post its `setup` token to the API instead. Owners and admins who sign in with a password then add an
authenticator app (`/api/v1/auth/me/totp`) before they add members and tokens (ADR 0002):

```bash
curl -X POST localhost:8080/api/v1/auth/setup -H 'content-type: application/json' \
  -d '{"token":"<setup from the link>","name":"Selin Aydın","email":"selin@example.com","password":"<12 or more characters>"}'
```

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `HR_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy; links in emails use it |
| `HR_CONFIG` | `/config/hr.yaml` | The settings file |
| the variables the file names | | The mail password and Identity's provisioning token |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher |
| `HR_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key; required |
| `HR_DB` | `/data/hr.db` | SQLite file (WAL), on the `/data` volume |
| `HR_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `HR_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`. Responses
carry `cache-control: no-store`. Request logs carry the path only, never the query. Metrics include employees by
status, pending leave, expiring documents, Identity failures and the mail outbox. The API reference is at `/api/docs/`.

## Develop

```bash
npm install
npm test           # the file, the leave rules and Türkiye's holidays, who reads what, encryption at rest, the access
                   # log and history, approvals, balances, documents, checklists, the CSV import, retention, Identity
                   # against a fake SCIM server, and every API response against openapi.json
npm run openapi    # writes openapi.json after an API change; a test fails while it is out of date
npm start          # HR_DB=./data/hr.db HR_SECRETS_KEY_FILE=./data/kek HR_CONFIG=config/hr.yaml
```

Identity is tested against `server/fakes.ts`, which answers as Identity's `server/scim.ts` does; the real Identity is
not run here. SMTP is a fake mailer in the tests.

## Licence

AGPL-3.0 (ADR 0008).
