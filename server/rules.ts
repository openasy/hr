// The leave rules, as pure functions of the file and a person's dates: which days a leave takes, what each
// anniversary or new year grants, and the holidays of a year. hr.ts keeps the requests and the ledger; this file only
// counts, so the law's cases are tested on their own (rules.test.ts).
import type { Config, LeaveType } from "./config.ts";
import { addDays, addYears, daysBetween, weekday, yearsBetween } from "./dates.ts";
import { turkishHolidays, type Holiday } from "./holidays.ts";

/** The public holidays of a year: Türkiye's when the file keeps them, with the file's additions and removals. */
export function holidaysOf(c: Config, year: number): Holiday[] {
  const base = c.holidays.country === "tr" ? turkishHolidays(year) : [];
  const removed = new Set(c.holidays.remove);
  const byDay = new Map<string, Holiday>();
  for (const h of base) if (!removed.has(h.date)) byDay.set(h.date, h);
  for (const h of c.holidays.add) if (h.date.startsWith(`${year}-`)) byDay.set(h.date, h);
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function workWeekOf(c: Config, location: string | null): number[] {
  return c.locations.find((l) => l.id === location)?.workWeek ?? c.workWeek;
}

export interface DayCount {
  /** Days the leave takes, in halves. */
  days: number;
  /** Each day of the leave and what it takes: 0, 0.5 or 1. */
  perDay: Array<{ date: string; takes: number; why?: "day-off" | "holiday" | "half-holiday" }>;
}

/**
 * The days a leave from `start` to `end` takes. Working-day types leave out the week's days off and public holidays
 * (İş Kanunu md. 56: holidays and the weekly rest day inside annual leave are not counted), and a half-day holiday
 * takes half a day. Calendar-day types count every day. The first day may start at noon and the last end at noon.
 */
export function countDays(c: Config, type: LeaveType, location: string | null, start: string, end: string, startHalf = false, endHalf = false): DayCount {
  const week = new Set(workWeekOf(c, location));
  const holidays = new Map<string, Holiday>();
  for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) for (const h of holidaysOf(c, y)) holidays.set(h.date, h);
  const perDay: DayCount["perDay"] = [];
  let total = 0;
  const n = daysBetween(start, end);
  for (let i = 0; i <= n; i++) {
    const date = addDays(start, i);
    let takes = 1;
    let why: DayCount["perDay"][number]["why"];
    if (type.counts === "working_days") {
      const h = holidays.get(date);
      if (!week.has(weekday(date))) ((takes = 0), (why = "day-off"));
      else if (h && !h.half) ((takes = 0), (why = "holiday"));
      else if (h?.half) ((takes = 0.5), (why = "half-holiday"));
    }
    if ((i === 0 && startHalf) || (i === n && endHalf)) takes = Math.min(takes, 0.5);
    perDay.push({ date, takes, ...(why && { why }) });
    total += takes;
  }
  return { days: total, perDay };
}

/** The days a type grants for this many completed years of service, before the age rule. */
export function daysForYears(type: LeaveType, years: number): number {
  let days = 0;
  for (const [from, d] of type.bySeniority) if (years >= from) days = d;
  return days;
}

export interface Grant {
  /** The day the days are granted: an anniversary, 1 January, or the start day in a prorated first year. */
  date: string;
  /** What makes the grant unique for the person and type: the anniversary's day or the year. */
  period: string;
  days: number;
  years: number;
}

/**
 * The grants a type makes to a person from `from` up to and including `to`. Anniversaries count from `serviceStart`
 * (the start of service with the employer, which may be before the start date in HR): on the first anniversary the
 * year is complete and the days for one year are granted, and so on (İş Kanunu md. 53, 54). The age rule raises the
 * days for people who are at most `ageUpTo` or at least `ageFrom` years old on the day of the grant.
 */
export function grants(
  type: LeaveType,
  p: { startDate: string; serviceStart: string; endDate: string | null; birthDate: string | null },
  from: string,
  to: string,
): Grant[] {
  const out: Grant[] = [];
  const last = p.endDate && p.endDate < to ? p.endDate : to;
  const atLeast = (date: string, days: number) => {
    const a = type.atLeast;
    if (!a || !p.birthDate || days <= 0) return days;
    const age = yearsBetween(p.birthDate, date);
    return (a.ageUpTo !== null && age <= a.ageUpTo) || (a.ageFrom !== null && age >= a.ageFrom) ? Math.max(days, a.days) : days;
  };
  if (type.accrual === "anniversary") {
    for (let n = 1; n <= 80; n++) {
      const date = addYears(p.serviceStart, n);
      if (date > last) break;
      if (date < from || date < p.startDate) continue;
      const days = atLeast(date, daysForYears(type, n));
      if (days > 0) out.push({ date, period: date, days, years: n });
    }
  } else if (type.accrual === "yearly") {
    const first = Math.max(Number(p.startDate.slice(0, 4)), Number(from.slice(0, 4)));
    for (let y = first; y <= Number(last.slice(0, 4)); y++) {
      const startYear = y === Number(p.startDate.slice(0, 4));
      const date = startYear && p.startDate > `${y}-01-01` ? p.startDate : `${y}-01-01`;
      if (date < from || date > last) continue;
      const years = yearsBetween(p.serviceStart, date);
      let days = atLeast(date, daysForYears(type, years));
      if (startYear && type.prorate && date !== `${y}-01-01`) {
        // The months left in the year, counting the start month when it starts by the 15th, in half days.
        const month = Number(date.slice(5, 7));
        const months = 12 - month + (Number(date.slice(8, 10)) <= 15 ? 1 : 0);
        days = Math.round(((days * months) / 12) * 2) / 2;
      }
      if (days > 0) out.push({ date, period: String(y), days, years });
    }
  }
  return out;
}

/** The next grant after `today`, to show what is coming. */
export function nextGrant(type: LeaveType, p: Parameters<typeof grants>[1], today: string): Grant | null {
  if (type.accrual === "none" || (p.endDate && p.endDate <= today)) return null;
  return grants(type, { ...p, endDate: null }, addDays(today, 1), addYears(today, 2))[0] ?? null;
}

/** Half-day units, so two halves of one day do not overlap: [start, end). */
export function halfUnits(start: string, end: string, startHalf: boolean, endHalf: boolean): [number, number] {
  const s = Date.parse(`${start}T00:00:00Z`) / 43_200_000 + (startHalf ? 1 : 0);
  const e = Date.parse(`${end}T00:00:00Z`) / 43_200_000 + (endHalf ? 1 : 2);
  return [s, e];
}
