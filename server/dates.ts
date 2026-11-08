// Days as YYYY-MM-DD and wall-clock times in the install's zone. A day is a calendar day with no zone: a leave from
// 2026-12-01 to 2026-12-05 is those five days wherever it is read. Instants are only for "now" and for when Identity is
// told, which is a wall-clock time on a day in the file's time_zone.

const formats = new Map<string, Intl.DateTimeFormat>();
function format(tz: string) {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(tz, f);
  }
  return f;
}

/** True when the zone is one Intl knows. */
export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function wallClock(ms: number, tz: string) {
  const p: Record<string, number> = {};
  for (const part of format(tz).formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour! % 24, minute: p.minute!, second: p.second! };
}

function offset(ms: number, tz: string) {
  const w = wallClock(ms, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock time on a day has in a zone; minutes after midnight. */
export function instantOf(day: string, minutes: number, tz: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const before = offset(guess, tz);
  const t = guess - before;
  const after = offset(t, tz);
  return after === before ? t : guess - after;
}

/** The day an instant falls on in a zone. */
export function dayIn(ms: number, tz: string): string {
  const w = wallClock(ms, tz);
  return ymd(w.year, w.month, w.day);
}

export const ymd = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

const parts = (day: string) => day.split("-").map(Number) as [number, number, number];

/** The day n days after (or before, for a negative n). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The same day n years later; 29 February becomes 28 February in a year without it. */
export function addYears(day: string, n: number): string {
  const [y, m, d] = parts(day);
  const last = new Date(Date.UTC(y + n, m, 0)).getUTCDate();
  return ymd(y + n, m, Math.min(d, last));
}

/** Monday is 0, Sunday 6. */
export const weekday = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;

/** Whole days from a to b. */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Completed years from a to b, as service or age is counted: on the anniversary the year is complete. */
export function yearsBetween(a: string, b: string): number {
  if (b < a) return 0;
  const [ya] = parts(a);
  const [yb] = parts(b);
  let n = yb - ya;
  if (addYears(a, n) > b) n--;
  return Math.max(0, n);
}

export function isDay(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
    new Date(`${v}T00:00:00Z`).toISOString().startsWith(v)
  );
}

export const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** The same day n months later, or the month's last day when it is shorter. */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = parts(day);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  const t = new Date(Date.UTC(y, m - 1 + n, Math.min(d, last)));
  return t.toISOString().slice(0, 10);
}
