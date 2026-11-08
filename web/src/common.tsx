// What the pages share: data loading with the session, formatting days, money and names, and small pieces of layout.
import { useAuth } from "@openasy/auth/react";
import type { Locale } from "@openasy/ui";
import { ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized, type Words } from "./api.ts";

/** Data loading with the session; when it ends, the sign-in screen comes back. */
export function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <R,>(path: string, init?: RequestInit): Promise<R> => {
      try {
        return await api<R>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
export type Call = ReturnType<typeof useApi>;

/** Loads a path when it changes; `reload` loads it again. undefined while loading, null when it failed. */
export function useLoad<R>(call: Call, path: string | null) {
  const [data, setData] = useState<R | null>();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    void call<R>(path).then(
      (d) => live && setData(d),
      () => live && setData(null),
    );
    return () => {
      live = false;
    };
  }, [call, path, n]);
  return [data, () => setN((x) => x + 1)] as const;
}

/** A status line after something was done, read out by screen readers. */
export function Notice({ children, tone = "success" }: { children: ReactNode; tone?: "success" | "danger" }) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`mb-2.5 rounded-md px-3 py-2 text-sm text-fg ${tone === "danger" ? "bg-danger-soft" : "bg-success-soft"}`}
    >
      {children}
    </div>
  );
}

export function Code({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <pre aria-label={label} className="hr-code m-0 overflow-x-auto rounded-md bg-canvas px-2.5 py-2 font-mono text-2xs leading-relaxed text-fg">
      {children}
    </pre>
  );
}

/** A label and its value in a two-column list. */
export function Field({ label, children, mono }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="contents">
      <dt className="text-fg-muted">{label}</dt>
      <dd className={`m-0 min-w-0 text-fg ${mono ? "font-mono" : ""}`}>{children}</dd>
    </div>
  );
}

/** Who reads a part of the record, above it: the file's access, as people read it. */
export function ReadBy({ children }: { children: ReactNode }) {
  return (
    <p className="mt-0 mb-2 flex items-center gap-1.5 text-xs text-fg-muted">
      <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
      {children}
    </p>
  );
}

// ---------------------------------------------------------------- formatting

/** A name from the file in the page's language, English where it has none. */
export const words = (w: Words | null | undefined, locale: Locale) => (w ? w[locale] || w.en : "");

const at = (d: string) => new Date(`${d}T12:00:00Z`);
/** 1 Dec 2026 */
export const day = (d: string, locale: string) => at(d).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
/** Tue 1 Dec */
export const weekday = (d: string, locale: string) => at(d).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
/** Tue 1 */
export const dayShort = (d: string, locale: string) => at(d).toLocaleDateString(locale, { weekday: "short", day: "numeric", timeZone: "UTC" });
export const when = (iso: string, locale: string) =>
  new Date(iso).toLocaleString(locale, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
/** 14.5 as people write it in the language. */
export const num = (n: number, locale: string) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n);

/** 45000 is "45,000 TL" in English and "45.000 TL" in Turkish; TRY is written TL, as people write it. */
export function money(n: number, currency: string, locale: string) {
  const v = new Intl.NumberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
  return `${v} ${currency === "TRY" ? "TL" : currency}`;
}

/** Today as YYYY-MM-DD in the browser's zone. */
export function today(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function addDays(d: string, n: number) {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
/** Completed years from a day to today, as anniversaries count them. */
export function yearsSince(d: string) {
  const now = today();
  const years = Number(now.slice(0, 4)) - Number(d.slice(0, 4));
  return Math.max(0, now.slice(5) < d.slice(5) ? years - 1 : years);
}
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** A file the person picked, as base64 for the API. */
export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error ?? new Error("The file could not be read."));
    r.readAsDataURL(file);
  });
}

/** TR as "Türkiye" in the language; a code the browser does not know is shown as it is. */
export function country(code: string, locale: string) {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export const size = (bytes: number, locale: string) =>
  bytes < 1024 * 1024 ? `${num(Math.max(1, Math.round(bytes / 1024)), locale)} KB` : `${num(Math.round((bytes / 1024 / 1024) * 10) / 10, locale)} MB`;
