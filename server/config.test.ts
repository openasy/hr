import { mkdtempSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configWarnings, DEFAULT_LEAVE, parseConfig, watchConfig } from "./config.ts";

describe("the settings file", () => {
  it("reads the file in the repository, which writes out the defaults", () => {
    const c = parseConfig(readFileSync(new URL("../config/hr.yaml", import.meta.url), "utf8"));
    const d = parseConfig("");
    expect(c.leaveTypes.map((t) => t.id)).toEqual(d.leaveTypes.map((t) => t.id).filter((id) => id !== "adoption"));
    const annual = c.leaveTypes[0]!;
    expect(annual).toMatchObject({
      accrual: "anniversary",
      bySeniority: [
        [1, 14],
        [6, 20],
        [15, 26],
      ],
      atLeast: { days: 20, ageUpTo: 18, ageFrom: 50 },
      carryOver: null,
    });
    expect(annual.bySeniority).toEqual(DEFAULT_LEAVE[0]!.bySeniority);
    expect(c.locations[1]).toEqual({ id: "izmir", name: "İzmir factory", workWeek: [0, 1, 2, 3, 4, 5] });
    expect(c.checklists[0]!.tasks.find((t) => t.id === "laptop")).toMatchObject({ who: "manager", due: -3 });
    expect(c.access.pay).toEqual(["self", "viewer"]);
    expect(c.retention).toEqual({ afterLeavingDays: 3650, accessLogDays: 730 });
    expect(c.identity).toBeNull();
  });

  it("runs on Türkiye's defaults without a file", () => {
    const c = parseConfig("");
    expect(c).toMatchObject({ timeZone: "Europe/Istanbul", language: "tr", workWeek: [0, 1, 2, 3, 4], holidays: { country: "tr" } });
    expect(c.leaveTypes.find((t) => t.id === "sick")).toMatchObject({ counts: "calendar_days", shownToColleagues: false, document: "health-report" });
    expect(c.approvals.find((a) => a.id === "standard")!.steps).toEqual([{ kind: "manager" }, { kind: "hr" }]);
  });

  it("names the field at fault", () => {
    const bad = (yaml: string) => () => parseConfig(yaml);
    expect(bad("nope: 1")).toThrow(/The file: unknown nope/);
    expect(bad("time_zone: Mars/Base")).toThrow(/time_zone/);
    expect(bad("language: fr")).toThrow(/language is en, de, tr/);
    expect(bad("work_week: [mon, funday]")).toThrow(/funday is not a day/);
    expect(bad("leave_types: { annual: { accrual: anniversary } }")).toThrow(/needs days or by_seniority/);
    expect(bad("leave_types: { annual: { days: 14, by_seniority: { 1: 14 } } }")).toThrow(/not both/);
    expect(bad("leave_types: { annual: { days: 14.3 } }")).toThrow(/in halves/);
    expect(bad("leave_types: { annual: { days: 14, approval: boss } }")).toThrow(/boss is not a rule/);
    expect(bad("leave_types: { sick: { document: x-ray } }")).toThrow(/x-ray is not a kind/);
    expect(bad("approvals: { standard: [boss] }")).toThrow(/manager, second_manager, hr or a member's email/);
    expect(bad("checklists: { onboarding: { on: hire, tasks: [] } }")).toThrow(/on is start/);
    expect(bad("checklists: { onboarding: { on: start, tasks: [{ text: x, due: soon }] } }")).toThrow(/due is a span/);
    expect(bad("access: { personal: [everyone] }")).toThrow(/everyone is not self/);
    expect(bad("retention: { after_leaving: 2d }")).toThrow(/at least 30d/);
    expect(bad("identity: { url: http://identity.example.com }")).toThrow(/https/);
    expect(bad("identity: { url: http://identity:8080, token: oisc_secret }")).toThrow(/environment variable/);
    expect(bad("holidays: { add: [{ date: 2026-02-30, name: x }] }")).toThrow(/YYYY-MM-DD/);
    expect(bad("locations: { izmir: { name: İzmir, work_week: [] } }")).toThrow(/list of days/);
  });

  it("warns about what it cannot do, without refusing the file", () => {
    const c = parseConfig(`
approvals: { standard: [manager, ceo@example.com] }
leave_types: { annual: { days: 14 } }
identity: { url: http://identity:8080 }
`);
    expect(configWarnings(c, {}, ["hr@example.com"], "2027-03-01")).toEqual([
      "holidays: Ramazan and Kurban Bayramı of 2028 are not built in (only 2025, 2026, 2027); add them under holidays.add once they are announced.",
      "mail: no mail server, so approvers and HR are not emailed; they see what waits for them in HR.",
      "identity: HR_IDENTITY_TOKEN is not set, so Identity is not told who joins and leaves.",
      "approvals.standard: ceo@example.com is not a member of HR.",
    ]);
  });

  it("keeps the last good version when the file on disk has a mistake", () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-config-"));
    const path = join(dir, "hr.yaml");
    writeFileSync(path, "language: en\n");
    const applied: string[] = [];
    const w = watchConfig(path, (c) => (applied.push(c.language), []), { everyMs: 60_000 });
    writeFileSync(path, "language: fr\n");
    w.read();
    expect(applied).toEqual(["en"]);
    expect(w.state.error).toMatch(/language/);
    writeFileSync(path, "language: de\n");
    w.read();
    expect(applied).toEqual(["en", "de"]);
    expect(w.state.error).toBeNull();
    w.stop();
  });
});
