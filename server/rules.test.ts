import { describe, expect, it } from "vitest";
import { DEFAULT_LEAVE, parseConfig } from "./config.ts";
import { addYears, yearsBetween } from "./dates.ts";
import { turkishHolidays } from "./holidays.ts";
import { countDays, grants, holidaysOf, nextGrant } from "./rules.ts";

const cfg = parseConfig(`
locations:
  izmir: { name: İzmir, work_week: [mon, tue, wed, thu, fri, sat] }
`);
const annual = DEFAULT_LEAVE.find((t) => t.id === "annual")!;
const sick = DEFAULT_LEAVE.find((t) => t.id === "sick")!;
const person = (serviceStart: string, birthDate: string | null = "1990-01-01") => ({ startDate: serviceStart, serviceStart, endDate: null, birthDate });

describe("annual leave by seniority (İş Kanunu md. 53)", () => {
  it("grants nothing in the first year, 14 days on each anniversary up to five years, 20 from the sixth, 26 from the fifteenth", () => {
    const g = grants(annual, person("2005-01-15", "1980-01-01"), "2005-01-15", "2026-12-31");
    expect(g[0]).toEqual({ date: "2006-01-15", period: "2006-01-15", days: 14, years: 1 });
    const by = Object.fromEntries(g.map((x) => [x.years, x.days]));
    expect([by[1], by[5], by[6], by[14], by[15], by[21]]).toEqual([14, 14, 20, 20, 26, 26]);
    expect(grants(annual, person("2026-03-01"), "2026-03-01", "2027-02-28")).toEqual([]);
  });

  it("gives at least 20 days to people of 18 or younger and 50 or older on the day of the grant", () => {
    // 50 on 10 May 2026; the anniversary on 1 June 2026 is the third year.
    expect(grants(annual, person("2023-06-01", "1976-05-10"), "2026-01-01", "2026-12-31")).toEqual([
      { date: "2026-06-01", period: "2026-06-01", days: 20, years: 3 },
    ]);
    // 49 on the anniversary: 14.
    expect(grants(annual, person("2023-06-01", "1976-07-10"), "2026-01-01", "2026-12-31")[0]!.days).toBe(14);
    // 18 on the first anniversary.
    expect(grants(annual, person("2025-09-01", "2007-10-01"), "2026-01-01", "2026-12-31")[0]!.days).toBe(20);
    // Without a birth date the age rule cannot apply.
    expect(grants(annual, person("2023-06-01", null), "2026-01-01", "2026-12-31")[0]!.days).toBe(14);
  });

  it("counts service from the service start, so earlier years with the employer count (md. 54), and stops at the end day", () => {
    const p = { startDate: "2024-01-01", serviceStart: "2019-01-01", endDate: "2025-06-30", birthDate: null };
    expect(grants(annual, p, "2024-01-01", "2030-01-01")).toEqual([
      { date: "2024-01-01", period: "2024-01-01", days: 14, years: 5 },
      { date: "2025-01-01", period: "2025-01-01", days: 20, years: 6 },
    ]);
  });

  it("moves 29 February to 28 February in a year without it", () => {
    expect(addYears("2024-02-29", 1)).toBe("2025-02-28");
    expect(yearsBetween("2024-02-29", "2025-02-28")).toBe(1);
    expect(grants(annual, person("2024-02-29"), "2024-02-29", "2025-03-01")[0]!.date).toBe("2025-02-28");
  });

  it("says when the next grant comes", () => {
    expect(nextGrant(annual, person("2025-12-01"), "2026-11-02")).toEqual({ date: "2026-12-01", period: "2026-12-01", days: 14, years: 1 });
    expect(nextGrant(sick, person("2025-12-01"), "2026-11-02")).toBeNull();
  });
});

describe("yearly grants", () => {
  const c = parseConfig(`
leave_types:
  vacation: { name: Vacation, accrual: yearly, days: 24, prorate: true, carry_over: 5, approval: manager }
`);
  const t = c.leaveTypes[0]!;

  it("grants on 1 January and, prorated, from the start day in the first year", () => {
    const g = grants(t, person("2026-04-10"), "2026-01-01", "2027-12-31");
    // April to December, April counting because they start by the 15th: 9 months of 24 days.
    expect(g).toEqual([
      { date: "2026-04-10", period: "2026", days: 18, years: 0 },
      { date: "2027-01-01", period: "2027", days: 24, years: 0 },
    ]);
    expect(grants(t, person("2026-04-20"), "2026-01-01", "2026-12-31")[0]!.days).toBe(16);
    expect(t.carryOver).toBe(5);
  });
});

describe("the days a leave takes", () => {
  it("leaves out weekends and public holidays, and counts half-day holidays and half days as halves (md. 56)", () => {
    // Ramazan Bayramı 2026: the eve on Thursday 19 March is half a day, Friday 20 March to Sunday 22 March are off.
    const r = countDays(cfg, annual, null, "2026-03-16", "2026-03-27");
    expect(r.days).toBe(8.5);
    expect(r.perDay.find((d) => d.date === "2026-03-19")).toEqual({ date: "2026-03-19", takes: 0.5, why: "half-holiday" });
    expect(r.perDay.find((d) => d.date === "2026-03-20")).toEqual({ date: "2026-03-20", takes: 0, why: "holiday" });
    expect(r.perDay.find((d) => d.date === "2026-03-21")).toEqual({ date: "2026-03-21", takes: 0, why: "day-off" });
    expect(countDays(cfg, annual, null, "2026-11-02", "2026-11-06", true, true).days).toBe(4);
    expect(countDays(cfg, annual, null, "2026-11-02", "2026-11-02", false, true).days).toBe(0.5);
  });

  it("counts Saturdays where the location works six days", () => {
    expect(countDays(cfg, annual, "izmir", "2026-11-02", "2026-11-08").days).toBe(6);
    expect(countDays(cfg, annual, null, "2026-11-02", "2026-11-08").days).toBe(5);
  });

  it("counts every day for calendar-day types such as a sick report", () => {
    expect(countDays(cfg, sick, null, "2026-10-26", "2026-11-04").days).toBe(10);
  });

  it("takes 28 October as half a day and 29 October as a holiday", () => {
    expect(countDays(cfg, annual, null, "2026-10-26", "2026-10-30").days).toBe(3.5);
  });
});

describe("public holidays", () => {
  it("has Türkiye's national holidays every year, and the Bayrams of the years built in", () => {
    const h = turkishHolidays(2027);
    expect(h.map((x) => x.date)).toEqual([
      "2027-01-01",
      "2027-03-08",
      "2027-03-09",
      "2027-03-10",
      "2027-03-11",
      "2027-04-23",
      "2027-05-01",
      "2027-05-15",
      "2027-05-16",
      "2027-05-17",
      "2027-05-18",
      "2027-05-19",
      "2027-07-15",
      "2027-08-30",
      "2027-10-28",
      "2027-10-29",
    ]);
    expect(h.find((x) => x.date === "2027-05-15")).toMatchObject({ half: true, name: { tr: "Kurban Bayramı arifesi" } });
    // 19 May 2027 is both the fourth day of Kurban Bayramı and Atatürk's day; it is listed once.
    expect(turkishHolidays(2028).length).toBe(8);
  });

  it("adds and removes the file's days", () => {
    const c = parseConfig(`
holidays:
  add:
    - { date: 2028-02-25, name: { en: Ramadan Feast eve, tr: Ramazan Bayramı arifesi }, half: true }
    - { date: 2026-12-31, name: Company day }
  remove: [2026-07-15]
`);
    expect(holidaysOf(c, 2028).find((h) => h.date === "2028-02-25")).toEqual({
      date: "2028-02-25",
      name: { en: "Ramadan Feast eve", de: "Ramadan Feast eve", tr: "Ramazan Bayramı arifesi" },
      half: true,
    });
    expect(holidaysOf(c, 2026).some((h) => h.date === "2026-07-15")).toBe(false);
    expect(holidaysOf(c, 2026).at(-1)!.date).toBe("2026-12-31");
    expect(holidaysOf(parseConfig("holidays: { country: none }"), 2026)).toEqual([]);
  });
});
