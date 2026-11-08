// The words of what HR writes itself: the emails to approvers, to the person whose leave was decided, and to HR about
// documents that expire. English, German and Turkish; the file's `language` picks the emails' language. The names of
// leave types, documents and checklist tasks come from the file in each language.
import type { Language } from "./config.ts";

const EN = {
  toApproveSubject: "Leave to approve: {name}, {from} to {to}",
  toApproveText: "{name} asks for {type} from {from} to {to}, {days} day(s).\n\nApprove or reject it in HR:\n{url}",
  approvedSubject: "Your leave is approved: {from} to {to}",
  approvedText: "Your {type} from {from} to {to}, {days} day(s), is approved.\n\n{url}",
  rejectedSubject: "Your leave is not approved: {from} to {to}",
  rejectedText: "Your {type} from {from} to {to} was not approved by {by}.{note}\n\n{url}",
  expiringSubject: "{document} of {name} expires on {date}",
  expiringText: "{document} of {name} expires on {date}. Upload the new one in HR:\n{url}",
  note: "\n\nTheir note: {note}",
  days: "day(s)",
};
type Words = typeof EN;

const DE: Words = {
  toApproveSubject: "Urlaub zu genehmigen: {name}, {from} bis {to}",
  toApproveText: "{name} beantragt {type} vom {from} bis {to}, {days} Tag(e).\n\nGenehmigen oder ablehnen in HR:\n{url}",
  approvedSubject: "Ihr Urlaub ist genehmigt: {from} bis {to}",
  approvedText: "Ihr Antrag auf {type} vom {from} bis {to}, {days} Tag(e), ist genehmigt.\n\n{url}",
  rejectedSubject: "Ihr Urlaub ist nicht genehmigt: {from} bis {to}",
  rejectedText: "Ihr Antrag auf {type} vom {from} bis {to} wurde von {by} nicht genehmigt.{note}\n\n{url}",
  expiringSubject: "{document} von {name} läuft am {date} ab",
  expiringText: "{document} von {name} läuft am {date} ab. Laden Sie das neue Dokument in HR hoch:\n{url}",
  note: "\n\nAnmerkung: {note}",
  days: "Tag(e)",
};

const TR: Words = {
  toApproveSubject: "Onay bekleyen izin: {name}, {from} - {to}",
  toApproveText: "{name}, {from} - {to} tarihleri için {days} gün {type} istiyor.\n\nHR'da onaylayın ya da reddedin:\n{url}",
  approvedSubject: "İzniniz onaylandı: {from} - {to}",
  approvedText: "{from} - {to} tarihleri için {days} günlük {type} talebiniz onaylandı.\n\n{url}",
  rejectedSubject: "İzniniz onaylanmadı: {from} - {to}",
  rejectedText: "{from} - {to} tarihleri için {type} talebiniz {by} tarafından onaylanmadı.{note}\n\n{url}",
  expiringSubject: "{name} için {document} {date} tarihinde sona eriyor",
  expiringText: "{name} için {document} {date} tarihinde sona eriyor. Yenisini HR'a yükleyin:\n{url}",
  note: "\n\nNotu: {note}",
  days: "gün",
};

const WORDS: Record<Language, Words> = { en: EN, de: DE, tr: TR };

/** The words in a language, with {name} placeholders filled in. */
export function say(lang: Language, key: keyof Words, vars: Record<string, string | number> = {}): string {
  return WORDS[lang][key].replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? ""));
}
