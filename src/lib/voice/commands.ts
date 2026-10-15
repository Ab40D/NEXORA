/**
 * Voice command allowlist.
 *
 * Recognized speech is normalized, filler words are removed, and the remainder
 * must EXACTLY match one of the allowlisted phrases. Anything else — including
 * negations ("don't turn the light on"), longer sentences or attempts to change
 * settings — is ignored. Voice can only ever produce "on" or "off" for the
 * already-configured light; it cannot change KNX connection settings.
 */
import type { OnOff } from "@/lib/state/types";

export type CommandLanguage = "en" | "fr" | "ar";

export interface VoiceLanguageOption {
  /** BCP-47 tag passed to SpeechRecognition.lang */
  tag: string;
  label: string;
  family: CommandLanguage;
  dir: "ltr" | "rtl";
}

export const VOICE_LANGUAGES: VoiceLanguageOption[] = [
  { tag: "en-US", label: "English (US)", family: "en", dir: "ltr" },
  { tag: "en-GB", label: "English (UK)", family: "en", dir: "ltr" },
  { tag: "fr-FR", label: "Français (France)", family: "fr", dir: "ltr" },
  { tag: "ar-DZ", label: "العربية (الجزائر)", family: "ar", dir: "rtl" },
  { tag: "ar-SA", label: "العربية (السعودية)", family: "ar", dir: "rtl" },
];

export const MAX_COMMAND_WORDS = 8;
export const MIN_ALTERNATIVE_CONFIDENCE = 0.35;

export interface VoiceParseResult {
  command: OnOff | null;
  /** canonical allowlisted phrase that matched */
  matched?: string;
  language?: CommandLanguage;
  normalized: string;
  reason?: "empty" | "no-match" | "too-long" | "ambiguous" | "low-confidence";
}

// ---------------------------------------------------------------- normalizers

export function normalizeLatin(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'`´-]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeArabic(input: string): string {
  return input
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "") // harakat / Quranic marks
    .replace(/\u0640/g, "") // tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^\u0621-\u064A\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripArabicArticle(token: string): string {
  return token.length > 3 && token.startsWith("ال") ? token.slice(2) : token;
}

// ---------------------------------------------------------------- allowlists

const EN_FILLERS = new Set([
  "please", "now", "hey", "hi", "ok", "okay", "the", "a", "se7enx", "sevenx", "seven", "x",
  "could", "can", "would", "will", "you", "kindly", "thanks", "thank",
]);
const EN_NOUNS = ["light", "lights", "lamp"];

const FR_FILLERS = new Set([
  "s", "il", "te", "vous", "plait", "la", "le", "les", "l", "peux", "pouvez", "tu", "merci",
  "maintenant", "est", "ce", "que", "stp", "svp", "s7", "se7enx",
]);
const FR_NOUNS = ["lumiere", "lumieres", "lampe", "eclairage"];
const FR_ON_VERBS = ["allume", "allumer", "allumez", "ouvre", "ouvrir", "ouvrez"];
const FR_OFF_VERBS = ["eteins", "eteint", "eteindre", "eteignez", "ferme", "fermer", "fermez", "coupe", "couper", "coupez"];

const AR_FILLERS = new Set(["من", "فضلك", "لو", "سمحت", "يا", "عافاك", "رجاء", "ارجوك", "الان", "دروك", "درك"]);
const AR_NOUNS = ["ضوء", "ضو", "نور", "مصباح", "لمبه", "اضاءه"];
const AR_ON_VERBS = ["شغل", "شغلي", "اشعل", "اشعلي", "شعل", "شعلي", "افتح", "افتحي", "حل", "حلي", "ولع", "ولعي"];
const AR_OFF_VERBS = ["اطفي", "اطفيء", "طفي", "اغلق", "اغلقي", "غلق", "سكر", "سكري", "سد", "سدي", "قفل", "اقفل"];

type Allowlist = Map<string, OnOff>;

function buildEnglish(): Allowlist {
  const m: Allowlist = new Map();
  for (const n of EN_NOUNS) {
    for (const v of ["on", "off"] as const) {
      m.set(`${n} ${v}`, v);
      m.set(`turn ${v} ${n}`, v);
      m.set(`turn ${n} ${v}`, v);
      m.set(`switch ${v} ${n}`, v);
      m.set(`switch ${n} ${v}`, v);
    }
  }
  return m;
}

function buildPairs(verbsOn: string[], verbsOff: string[], nouns: string[]): Allowlist {
  const m: Allowlist = new Map();
  for (const n of nouns) {
    for (const v of verbsOn) m.set(`${v} ${n}`, "on");
    for (const v of verbsOff) m.set(`${v} ${n}`, "off");
  }
  return m;
}

const ALLOWLISTS: Record<CommandLanguage, Allowlist> = {
  en: buildEnglish(),
  fr: buildPairs(FR_ON_VERBS, FR_OFF_VERBS, FR_NOUNS),
  ar: buildPairs(AR_ON_VERBS, AR_OFF_VERBS, AR_NOUNS),
};

/** Example phrases shown in the UI. */
export const EXAMPLE_PHRASES: Record<CommandLanguage, { on: string[]; off: string[] }> = {
  en: { on: ["Light on", "Turn the light on"], off: ["Light off", "Turn the light off"] },
  fr: { on: ["Allume la lumière", "Ouvre la lumière"], off: ["Éteins la lumière", "Ferme la lumière"] },
  ar: { on: ["شغّل الضوء", "شعّل الضو"], off: ["أطفئ الضوء", "طفّي الضو"] },
};

// ---------------------------------------------------------------- parsing

function canonicalFor(lang: CommandLanguage, transcript: string): { key: string; words: number } {
  if (lang === "ar") {
    const tokens = normalizeArabic(transcript)
      .split(" ")
      .filter(Boolean)
      .filter((t) => !AR_FILLERS.has(t))
      .map(stripArabicArticle);
    return { key: tokens.join(" "), words: tokens.length };
  }
  const fillers = lang === "en" ? EN_FILLERS : FR_FILLERS;
  const tokens = normalizeLatin(transcript)
    .split(" ")
    .filter(Boolean)
    .filter((t) => !fillers.has(t));
  return { key: tokens.join(" "), words: tokens.length };
}

/**
 * Parse one transcript. The preferred language is tried first, then the
 * others (recognizers sometimes return phrases in another language).
 */
export function parseVoiceCommand(transcript: string, preferred: CommandLanguage = "en"): VoiceParseResult {
  const raw = (transcript ?? "").trim();
  if (!raw) return { command: null, normalized: "", reason: "empty" };
  const totalWords = raw.split(/\s+/).length;
  if (totalWords > MAX_COMMAND_WORDS * 2) return { command: null, normalized: raw, reason: "too-long" };

  const order: CommandLanguage[] = [preferred, ...(["en", "fr", "ar"] as const).filter((l) => l !== preferred)];
  for (const lang of order) {
    const { key, words } = canonicalFor(lang, raw);
    if (!key || words > MAX_COMMAND_WORDS) continue;
    const hit = ALLOWLISTS[lang].get(key);
    if (hit) return { command: hit, matched: key, language: lang, normalized: key };
  }
  return { command: null, normalized: canonicalFor(preferred, raw).key, reason: "no-match" };
}

export interface RecognitionAlternative {
  transcript: string;
  /** 0..1; some engines always report 0 (treated as "unknown") */
  confidence: number;
}

/**
 * Resolve the recognizer's alternatives into at most one command.
 * If different alternatives map to different commands the result is
 * ambiguous and nothing is executed.
 */
export function resolveAlternatives(alts: RecognitionAlternative[], preferred: CommandLanguage = "en"): VoiceParseResult {
  if (alts.length === 0) return { command: null, normalized: "", reason: "empty" };
  const parsed = alts.map((a) => ({ alt: a, res: parseVoiceCommand(a.transcript, preferred) }));
  const hits = parsed.filter((p) => p.res.command !== null);
  if (hits.length === 0) return { ...parsed[0]!.res, reason: parsed[0]!.res.reason ?? "no-match" };
  const commands = new Set(hits.map((h) => h.res.command));
  if (commands.size > 1) return { command: null, normalized: hits[0]!.res.normalized, reason: "ambiguous" };
  const best = hits[0]!;
  const c = best.alt.confidence;
  if (Number.isFinite(c) && c > 0 && c < MIN_ALTERNATIVE_CONFIDENCE) {
    return { command: null, normalized: best.res.normalized, matched: best.res.matched, reason: "low-confidence" };
  }
  return best.res;
}

export function languageFamily(tag: string): CommandLanguage {
  const t = tag.toLowerCase();
  if (t.startsWith("fr")) return "fr";
  if (t.startsWith("ar")) return "ar";
  return "en";
}
