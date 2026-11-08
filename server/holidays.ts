// Public holidays. Türkiye's national holidays (Law 2429) are built in and fall on the same day every year; the
// religious holidays (Ramazan and Kurban Bayramı) move with the lunar calendar, so they are listed by year as the
// Presidency of Religious Affairs announces them. Years past the table are added in the file (holidays.add), and HR
// warns when this year or next has none. The eve (arife) of each Bayram and 28 October are half days, from 13:00.
import { addDays } from "./dates.ts";

export type Words3 = { en: string; de: string; tr: string };

export interface Holiday {
  date: string;
  name: Words3;
  /** Only the afternoon is off: a leave on that day counts half a day. */
  half: boolean;
}

const FIXED: Array<[string, Words3, boolean]> = [
  ["01-01", { en: "New Year's Day", de: "Neujahr", tr: "Yılbaşı" }, false],
  [
    "04-23",
    { en: "National Sovereignty and Children's Day", de: "Tag der nationalen Souveränität und des Kindes", tr: "Ulusal Egemenlik ve Çocuk Bayramı" },
    false,
  ],
  ["05-01", { en: "Labour and Solidarity Day", de: "Tag der Arbeit und Solidarität", tr: "Emek ve Dayanışma Günü" }, false],
  [
    "05-19",
    {
      en: "Commemoration of Atatürk, Youth and Sports Day",
      de: "Gedenktag an Atatürk, Tag der Jugend und des Sports",
      tr: "Atatürk'ü Anma, Gençlik ve Spor Bayramı",
    },
    false,
  ],
  ["07-15", { en: "Democracy and National Unity Day", de: "Tag der Demokratie und der nationalen Einheit", tr: "Demokrasi ve Millî Birlik Günü" }, false],
  ["08-30", { en: "Victory Day", de: "Tag des Sieges", tr: "Zafer Bayramı" }, false],
  ["10-28", { en: "Republic Day eve", de: "Vorabend des Tages der Republik", tr: "Cumhuriyet Bayramı arifesi" }, true],
  ["10-29", { en: "Republic Day", de: "Tag der Republik", tr: "Cumhuriyet Bayramı" }, false],
];

/** The first day of each Bayram, by year. Ramazan Bayramı lasts three days, Kurban Bayramı four, each after its eve. */
const BAYRAM: Record<number, { ramazan: string; kurban: string }> = {
  2025: { ramazan: "2025-03-30", kurban: "2025-06-06" },
  2026: { ramazan: "2026-03-20", kurban: "2026-05-27" },
  2027: { ramazan: "2027-03-09", kurban: "2027-05-16" },
};

const RAMAZAN: Words3 = { en: "Ramadan Feast", de: "Ramadanfest", tr: "Ramazan Bayramı" };
const KURBAN: Words3 = { en: "Feast of Sacrifice", de: "Opferfest", tr: "Kurban Bayramı" };
const eve = (w: Words3): Words3 => ({ en: `${w.en} eve`, de: `Vorabend: ${w.de}`, tr: `${w.tr} arifesi` });
const day = (w: Words3, n: number): Words3 => ({ en: `${w.en}, day ${n}`, de: `${w.de}, Tag ${n}`, tr: `${w.tr} ${n}. gün` });

/** Years whose religious holidays are built in. */
export const BUILT_IN_YEARS = Object.keys(BAYRAM).map(Number);

/** Türkiye's public holidays of a year, as built in. */
export function turkishHolidays(year: number): Holiday[] {
  const out: Holiday[] = FIXED.map(([md, name, half]) => ({ date: `${year}-${md}`, name, half }));
  const b = BAYRAM[year];
  if (b) {
    for (const [first, w, days] of [
      [b.ramazan, RAMAZAN, 3],
      [b.kurban, KURBAN, 4],
    ] as const) {
      out.push({ date: addDays(first, -1), name: eve(w), half: true });
      for (let i = 0; i < days; i++) out.push({ date: addDays(first, i), name: day(w, i + 1), half: false });
    }
  }
  // A Bayram day on a national holiday (19 May 2027) is one day off, listed once.
  const seen = new Set<string>();
  return out.filter((h) => !seen.has(h.date) && seen.add(h.date)).sort((a, b) => a.date.localeCompare(b.date));
}

/** Whether the built-in table has the religious holidays of a year. */
export const hasBayram = (year: number) => year in BAYRAM;
