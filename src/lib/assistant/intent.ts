/**
 * Local, deterministic intent engine for "Talk to SE7ENX" (no network, no AI service).
 *
 * Understands English, French, Modern Standard Arabic and Algerian Darija (Arabic script and
 * common Latin-script spellings), including mixed-language messages. It only produces intents
 * from a fixed set; anything uncertain becomes a clarification or "unknown" — it never guesses.
 *
 * Absolute vs relative brightness is decided by the preposition before the number:
 *   to / à / على / الى / ل  → absolute; anything else after an increase/decrease verb
 *   (by / de / بـ / بمقدار, or no preposition) → relative.
 */
import type { Locale } from "@/lib/i18n/core";

export type IntentKind =
  | "turn_on"
  | "turn_off"
  | "toggle"
  | "set_brightness"
  | "adjust_brightness"
  | "query_state"
  | "greeting"
  | "help"
  | "thanks"
  | "clarify_value"
  | "clarify_number"
  | "ambiguous"
  | "unknown";

export interface Intent {
  kind: IntentKind;
  /** set_brightness: 0-100 · adjust_brightness: signed delta · clarify_number: the number heard */
  value?: number;
  /** language the message was written in (null when it cannot be told, e.g. "60%") */
  lang: Locale | null;
  /** true when a negation ("don't", «ما ... ش») stopped an action */
  negated?: boolean;
}

/** Default step for "brighter"/"a little" and "a lot". */
export const SMALL_STEP = 10;
export const LARGE_STEP = 30;

// ------------------------------------------------------------------ normalization

const ARABIC_DIGITS = /[\u0660-\u0669]/g;
const PERSIAN_DIGITS = /[\u06F0-\u06F9]/g;

export function normalizeMessage(input: string): string {
  let s = input.normalize("NFKC");
  s = s.replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660));
  s = s.replace(PERSIAN_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0));
  s = s.replace(/\u066A/g, "%"); // Arabic percent sign
  s = s.toLowerCase();
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // Latin accents (é → e)
  s = s
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "") // harakat, shadda, Quranic marks
    .replace(/\u0640/g, "") // tatweel (بـ → ب)
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ئ/g, "ي")
    .replace(/ؤ/g, "و");
  s = s.replace(/(\d)\s*%/g, "$1 %"); // "60%" → "60 %"
  s = s.replace(/([\u0600-\u06FF])(\d)/g, "$1 $2").replace(/(\d)([\u0600-\u06FF])/g, "$1 $2"); // "ب20" → "ب 20"
  s = s.replace(/[’'`´\-_]/g, " ");
  s = s.replace(/[^\p{L}\p{N}%\s]/gu, " ");
  return s.replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------------------ numbers

const AR_UNITS: Record<string, number> = {
  واحد: 1, اثنين: 2, زوج: 2, ثلاثه: 3, تلاته: 3, اربعه: 4, ربعه: 4, خمسه: 5, سته: 6, سبعه: 7, ثمانيه: 8, تمنيه: 8, تسعه: 9,
};
const AR_TENS: Record<string, number> = {
  عشرين: 20, ثلاثين: 30, تلاتين: 30, اربعين: 40, ربعين: 40, خمسين: 50, ستين: 60, سبعين: 70, ثمانين: 80, تمانين: 80, تسعين: 90,
};
const AR_SINGLE: Record<string, number> = {
  صفر: 0, عشره: 10, عشر: 10, خمسطاش: 15, ميه: 100, مايه: 100, مائه: 100, مئه: 100, ميا: 100,
};
const EN_UNITS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const EN_TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const EN_SINGLE: Record<string, number> = { zero: 0, five: 5, ten: 10, fifteen: 15, hundred: 100 };
const FR_PHRASES: [string, number][] = [
  ["quatre vingt dix", 90],
  ["quatre vingts", 80],
  ["quatre vingt", 80],
  ["soixante quinze", 75],
  ["soixante dix", 70],
  ["soixante cinq", 65],
  ["cinquante cinq", 55],
  ["quarante cinq", 45],
  ["trente cinq", 35],
  ["vingt cinq", 25],
];
const FR_SINGLE: Record<string, number> = {
  zero: 0, cinq: 5, dix: 10, quinze: 15, vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60, cent: 100,
};

const W = (word: string) => `(?<=^|\\s)${word}(?=\\s|$)`;

/** Replace spelled-out numbers with digits ("soixante quinze" → "75", "خمسه وعشرين" → "25"). */
export function wordsToDigits(s: string): string {
  let out = s.replace(/\bpour\s?cent\b/g, "%"); // keep "cent" (100) from eating "pour cent"
  for (const [phrase, n] of FR_PHRASES) out = out.replace(new RegExp(W(phrase), "g"), String(n));
  out = out.replace(new RegExp(`${W("(?:one|a)\\s+hundred")}`, "g"), "100");
  out = out.replace(
    new RegExp(`${W(`(${Object.keys(EN_TENS).join("|")})\\s+(${Object.keys(EN_UNITS).join("|")})`)}`, "g"),
    (_m, tens: string, unit: string) => String((EN_TENS[tens] ?? 0) + (EN_UNITS[unit] ?? 0)),
  );
  out = out.replace(
    new RegExp(`${W(`(${Object.keys(AR_UNITS).join("|")})\\s*و\\s*(${Object.keys(AR_TENS).join("|")})`)}`, "g"),
    (_m, unit: string, tens: string) => String((AR_UNITS[unit] ?? 0) + (AR_TENS[tens] ?? 0)),
  );
  const singles: Record<string, number> = { ...FR_SINGLE, ...EN_SINGLE, ...EN_TENS, ...AR_SINGLE, ...AR_TENS };
  out = out
    .split(" ")
    .map((tok) => (tok in singles ? String(singles[tok]) : tok))
    .join(" ");
  return out;
}

interface NumberInfo {
  value: number;
  /** the word right before the number (preposition), if any */
  before: string | null;
}

function findNumber(s: string): NumberInfo | null {
  const m = /(?<![\p{L}\d])(\d{1,3})(?:[.,]\d+)?(?![\p{L}\d])/u.exec(s);
  if (!m) return null;
  const head = s.slice(0, m.index).trim().split(" ");
  return { value: Number(m[1]), before: head[head.length - 1] || null };
}

const ABSOLUTE_PREP = new Set(["to", "at", "a", "au", "sur", "على", "علي", "عل", "ع", "الى", "الي", "لـ", "ل", "حتى", "حتي"]);

// ------------------------------------------------------------------ vocabulary

const AR_PREFIX = "(?:و|ف)?";
/** present-tense prefixes: تشعل (you turn on), نطفي (I turn off), يزيد (it increases) */
const AR_VERB_PREFIX = "(?:و|ف)?(?:ت|ن|ي)?";
const AR_SUFFIX = "(?:لي|ليا|ها|ه|و|ي|يه|يها|هولي|هالي)?";
const arVerb = (stems: string[]) => new RegExp(`(?<=^|\\s)${AR_VERB_PREFIX}(?:${stems.join("|")})${AR_SUFFIX}(?=\\s|$)`);
const arWord = (words: string[]) => new RegExp(`(?<=^|\\s)(?:${words.join("|")})(?=\\s|$)`);

const LIGHT_NOUN_AR = new RegExp(
  `(?<=^|\\s)${AR_PREFIX}(?:ال|ب|بال|ل|لل)?(?:ضو|ضوء|ضاو|اضاءه|اناره|مصباح|نور|لمبه|لومبه|لامبه|ليمبه|بولة|بوله)(?:ها|ه)?(?=\\s|$)`,
);
const BRIGHT_NOUN_AR = arWord(["سطوع", "السطوع", "شده", "الشده", "قوه", "القوه", "الضو", "الضوء", "الاضاءه"]);

const ON = [
  /\b(?:turn|switch|put|set)\s+(?:the\s+)?(?:lights?\s+|lamp\s+|it\s+)?on\b/,
  /\blights?\s+on\b/,
  /^on$/,
  /\blight\s+up\b/,
  /\ballum(?:e|er|ez|es)\b/,
  /\bmets?\s+(?:la\s+)?(?:lumiere|lampe)\b/,
  /\b(?:chaal|cha3el|che3el|cha3al|chael)\b/,
  arVerb(["شعل", "اشعل", "شغل", "ولع"]),
  arWord(["تشغيل"]),
];
const ON_CONTEXT_AR = arVerb(["افتح", "حل"]); // only together with a light noun
const OFF = [
  /\b(?:turn|switch|put|shut)\s+(?:the\s+)?(?:lights?\s+|lamp\s+|it\s+)?off\b/,
  /\blights?\s+(?:off|out)\b/,
  /^off$/,
  /\beteins?\b/,
  /\beteindre\b/,
  /\beteignez\b/,
  /\bcoupe[rz]?\s+(?:la\s+)?(?:lumiere|lampe)\b/,
  /\b(?:tfi|tafi|teffi|tfih|tfiha)\b/,
  arVerb(["طفي", "اطفي", "اطف", "طفا"]),
  arWord(["اطفاء"]),
];
const OFF_CONTEXT_AR = arVerb(["سكر", "اغلق", "اقفل", "وقف", "اوقف"]);
const TOGGLE = [/\btoggle\b/, /\bbascule[rz]?\b/];
const TOGGLE_CONTEXT_AR = arVerb(["بدل"]);

const INC = [
  /\b(?:increase|raise|brighter|brighten|boost|more\s+light|turn\s+(?:it\s+)?up|up\s+the)\b/,
  /\baugment(?:e|er|ez)\b/,
  /\bmont(?:e|er|ez)\b/,
  /\bplus\s+(?:fort|lumineu[xs]e?|de\s+lumiere)\b/,
  /\b(?:zid|zidli|zidou)\b/,
  arVerb(["زيد", "زد", "ارفع", "رفع", "طلع", "قوي", "زود", "كبر"]),
  arWord(["زياده", "اكثر", "اقوي"]),
];
const DEC = [
  /\b(?:decrease|lower|reduce|dim|dimmer|darker|less\s+light|turn\s+(?:it\s+)?down|down\s+the)\b/,
  /\bbaiss(?:e|er|ez)\b/,
  /\bdiminu(?:e|er|ez)\b/,
  /\breduis\b|\breduire\b|\btamise[rz]?\b/,
  /\bmoins\s+(?:fort|lumineu[xs]e?|de\s+lumiere)\b/,
  /\b(?:n9as|nqas|na9es|n9es|nkas)\b/,
  arVerb(["نقص", "انقص", "قلل", "خفض", "اخفض", "خفف", "هبط", "طيح", "صغر", "اخفت", "وطي"]),
  arWord(["تقليل", "تخفيض", "اقل"]),
];
const LITTLE = [
  /\b(?:a\s+little|a\s+bit|slightly|a\s+touch|little\s+bit)\b/,
  /\bun\s+(?:petit\s+)?peu\b|\blegerement\b/,
  /\b(?:chwiya|chouia|chwia|chwiyа|shwiya)\b/,
  arWord(["شويه", "شويا", "شوي", "شوييه", "قليلا", "قليل", "شيء قليل", "بعض الشيء"]),
];
const LOT = [/\b(?:a\s+lot|much\s+more|way\s+more)\b/, /\bbeaucoup\b/, /\bbezzaf\b|\bbzaf\b/, arWord(["بزاف", "كثيرا", "كثير"])];
const HALF = [
  /\bhalf\b/,
  /\bmoitie\b/,
  /\b(?:nos|ness|nouss)\b/,
  new RegExp(`(?<=^|\\s)(?:ال|ل|ع|عال|علي)?(?:نص|نصف)(?:ها|ه)?(?=\\s|$)`),
];
const FULL = [
  /\b(?:full|maximum|max)\b/,
  /\ba\s+fond\b|\bau\s+max(?:imum)?\b/,
  /الحد الاقصي|(?<=^|\s)(?:ال)?اقصي(?=\s|$)|للاخر|لاخر|ماكسيموم|(?<=^|\s)(?:كامل|قاع|بالكامل)(?=\s|$)/,
];
const MIN = [/\b(?:minimum|min)\b/, /\bau\s+min(?:imum)?\b/, /الحد الادني|(?<=^|\s)(?:ال)?ادني(?=\s|$)|مينيموم/];
const PERCENT = /%|\bper\s?cent\b|\bpercent\b|\bpour\s?cent\b|\bpourcent\b|\bbel\s?m(?:y|i)a\b|بالميه|بالمايه|بالمائه|بالمئه|في الميه|في المئه|بالمية/;
const SET_VERB = [
  /\b(?:set|make|put|adjust|change)\b/,
  /\b(?:mets?|regle[rz]?|ajuste[rz]?|passe[rz]?|fixe[rz]?)\b/,
  arVerb(["اضبط", "اجعل", "خلي", "حط", "دير", "ضبط"]),
];
const BRIGHT_NOUN = [/\b(?:brightness|level|intensity|dimming)\b/, /\b(?:luminosite|intensite|niveau)\b/, BRIGHT_NOUN_AR];
const LIGHT_NOUN = [/\b(?:light|lights|lamp|it)\b/, /\b(?:lumiere|lampe|eclairage|la)\b/, /\b(?:dow|dhaw|daw|do)\b/, LIGHT_NOUN_AR];
const QUERY = [
  /\b(?:is|are)\s+(?:the\s+)?(?:lights?|lamp|it)\s+(?:on|off|lit)\b/,
  /\b(?:status|state)\b/,
  /\bhow\s+bright\b/,
  /\bwhat\s+(?:is\s+)?the\s+(?:brightness|level)\b/,
  /\best\s+ce\s+que?\b.*\b(?:allumee?|eteinte?)\b/,
  /\b(?:lumiere|lampe|elle)\s+est\s+(?:allumee?|eteinte?)\b/,
  /\b(?:etat|statut)\b/,
  /\bquelle\s+(?:est\s+la\s+)?luminosite\b/,
  /(?<=^|\s)هل(?=\s)/,
  /(?<=^|\s)(?:ال)?حاله(?=\s|$)/,
  /(?<=^|\s)واش(?=\s)/,
  /كيفاش راه/,
];
const STATE_WORDS = /(?<=^|\s)(?:شاعل|شاعله|طافي|طافيه|مشغل|مشغله|مطفا|مطفيه|مطفاه)(?=\s|$)|\b(?:allumee?|eteinte?|on|off)\b/;
const GREETING = [
  /^(?:hello|hi|hey|good\s+(?:morning|evening|afternoon))\b/,
  /^(?:bonjour|salut|bonsoir|coucou)\b/,
  /^(?:salam|saha|wesh|wach\s+rak)\b/,
  /^(?:مرحبا|السلام عليكم|السلام|سلام|اهلا|صباح الخير|مساء الخير|واش راك|واش راكم|كي راك|لاباس|صحه)/,
];
const THANKS = [/\b(?:thanks|thank\s+you|thx)\b/, /\bmerci\b/, /\b(?:sahit|saha|ya3tik)\b/, /شكرا|يعطيك الصحه|صحيت|بارك الله فيك|بارك الله/];
const HELP = [
  /\b(?:help|what\s+can\s+you\s+do)\b/,
  /\baide\b|\bque\s+(?:peux|sais)\s+tu\s+faire\b/,
  /(?<=^|\s)(?:مساعده|ساعدني|عاوني|عاونني)(?=\s|$)|واش تقدر دير|ماذا يمكنك/,
];
const NEGATION = [
  /\b(?:don\s?t|do\s+not|never|dont)\b/,
  /\bne\b.*\bpas\b|\bn\s+\w+\s+pas\b/,
  /(?<=^|\s)لا\s+ت/,
  /(?<=^|\s)ما\s?ت?\S+ش(?=\s|$)/,
  /(?<=^|\s)ماشي(?=\s|$)/,
];

const any = (patterns: RegExp[], s: string) => patterns.some((p) => p.test(s));

// ------------------------------------------------------------------ language detection

const DZ_MARKERS = new Set([
  "خويا", "خو", "راه", "راهو", "راهي", "راني", "شعل", "شعللي", "شعلها", "طفي", "طفيلي", "طفيها", "زيد", "زيدلي", "نقص",
  "نقصلي", "شويه", "شويا", "شوي", "الضو", "ضو", "بالميه", "واش", "كيفاش", "دوك", "ضرك", "درك", "خلي", "خليه", "خليها",
  "بزاف", "ماشي", "برك", "صحيت", "تاع", "اللومبه", "لومبه", "الضاو", "قاع", "مليح", "بصح", "يعطيك", "نتا", "هاد", "هادي",
  "طلع", "هبط", "طيح", "عاود", "باش", "كاين",
]);
const FR_MARKERS = new Set([
  "allume", "allumer", "allumez", "eteins", "eteindre", "eteignez", "lumiere", "lampe", "luminosite", "mets", "met", "regle",
  "baisse", "augmente", "monte", "diminue", "peu", "moitie", "fond", "pour", "cent", "pourcent", "bonjour", "salut", "merci",
  "plus", "moins", "est", "etat", "la", "le", "les", "de", "du", "au", "une", "elle", "quelle", "fort", "plait",
]);
const EN_MARKERS = new Set([
  "turn", "switch", "light", "lights", "lamp", "brightness", "set", "increase", "decrease", "dim", "brighter", "dimmer",
  "percent", "half", "full", "hello", "hi", "hey", "thanks", "thank", "please", "the", "on", "off", "is", "it", "by", "to",
  "what", "little", "bit", "make", "lower", "raise", "help", "lot", "more", "less", "much",
]);
const DZ_LATIN_MARKERS = new Set([
  "chaal", "cha3el", "che3el", "cha3al", "tfi", "tafi", "teffi", "dow", "dhaw", "daw", "zid", "zidli", "n9as", "nqas",
  "na9es", "chwiya", "chouia", "chwia", "khouya", "khoya", "rah", "wach", "wesh", "3afak", "sahit", "bel", "mya", "mia",
  "nos", "bezzaf", "bzaf", "salam",
]);

export function detectLanguage(normalized: string, hint: Locale): Locale | null {
  const tokens = normalized.split(" ").filter(Boolean);
  if (/[\u0600-\u06FF]/.test(normalized)) {
    return tokens.some((tok) => DZ_MARKERS.has(tok) || DZ_MARKERS.has(tok.replace(/^و/, ""))) ? "dz" : "ar";
  }
  const score = { en: 0, fr: 0, dz: 0 };
  for (const tok of tokens) {
    if (EN_MARKERS.has(tok)) score.en += 1;
    if (FR_MARKERS.has(tok)) score.fr += 1;
    if (DZ_LATIN_MARKERS.has(tok)) score.dz += 1.5;
  }
  const best = Math.max(score.en, score.fr, score.dz);
  if (best === 0) return null;
  const leaders = (Object.keys(score) as (keyof typeof score)[]).filter((k) => score[k] === best);
  if (leaders.length === 1) return leaders[0] ?? null;
  if ((leaders as string[]).includes(hint)) return hint;
  return leaders.includes("en") ? "en" : (leaders[0] ?? null);
}

// ------------------------------------------------------------------ parser

export function parseIntent(text: string, hint: Locale = "en"): Intent {
  const raw = text.trim();
  const base = normalizeMessage(raw);
  const lang = detectLanguage(base, hint);
  if (!base) return { kind: "unknown", lang };
  const s = wordsToDigits(base);

  const lightNoun = any(LIGHT_NOUN, s);
  let on = any(ON, s) || (lightNoun && ON_CONTEXT_AR.test(s));
  let off = any(OFF, s) || (lightNoun && OFF_CONTEXT_AR.test(s));
  const toggle = any(TOGGLE, s) || (lightNoun && TOGGLE_CONTEXT_AR.test(s));
  const little = any(LITTLE, s);
  const lot = any(LOT, s);
  // "a little more", "un peu moins", "a bit less"
  const more = /\bmore\b|\bplus\b/.test(s);
  const less = /\bless\b|\bmoins\b/.test(s);
  const inc = any(INC, s) || ((little || lot) && more && !less);
  const dec = any(DEC, s) || ((little || lot) && less && !more);
  const half = any(HALF, s);
  const full = any(FULL, s);
  const min = any(MIN, s);
  const num = findNumber(s);
  const percent = PERCENT.test(base);
  const setVerb = any(SET_VERB, s);
  const brightNoun = any(BRIGHT_NOUN, s);
  const isQuestion = /[?؟]\s*$/.test(raw);
  const interrogative = /^(?:is|are|est ce|est ce que|هل|واش|كيفاش)(?=\s|$)/.test(s);
  const request = /\b(?:can|could|would)\s+you\b|\bpeux\s+tu\b|\bpouvez\s+vous\b|(?<=^|\s)(?:تقدر|تقدري|يمكنك|ممكن)(?=\s|$)/.test(s);

  // "Is the light on" mentions "on" but asks a question (voice transcripts have no "?").
  if ((isQuestion || interrogative) && !request && !inc && !dec && !num && any(QUERY, s)) {
    on = false;
    off = false;
  }
  const actionable = on || off || toggle || inc || dec || num !== null || half || full || min;
  if (actionable && any(NEGATION, s)) return { kind: "unknown", lang, negated: true };

  if (inc || dec) {
    if (inc && dec) return { kind: "ambiguous", lang };
    const sign = inc ? 1 : -1;
    if (num) {
      const prep = num.before;
      if (prep && ABSOLUTE_PREP.has(prep)) return { kind: "set_brightness", value: clamp(num.value), lang };
      return { kind: "adjust_brightness", value: sign * Math.min(100, num.value), lang };
    }
    if (full && inc) return { kind: "set_brightness", value: 100, lang };
    if (min && dec) return { kind: "set_brightness", value: 1, lang };
    if (half) return { kind: "clarify_value", lang };
    return { kind: "adjust_brightness", value: sign * (lot ? LARGE_STEP : SMALL_STEP), lang };
  }

  if (num || half || full || min) {
    if (off && !on) return { kind: "turn_off", lang };
    const value = num ? num.value : half ? 50 : full ? 100 : 1;
    if (num && !percent && !setVerb && !brightNoun && !lightNoun && !on) {
      return { kind: "clarify_number", value: clamp(value), lang };
    }
    return { kind: "set_brightness", value: clamp(value), lang };
  }

  if (on && off) return { kind: "ambiguous", lang };
  if (on) return { kind: "turn_on", lang };
  if (off) return { kind: "turn_off", lang };
  if (toggle) return { kind: "toggle", lang };
  if (setVerb && brightNoun) return { kind: "clarify_value", lang };
  if (any(QUERY, s) && (lightNoun || STATE_WORDS.test(s) || brightNoun || /\b(?:status|state|etat|statut)\b/.test(s))) {
    return { kind: "query_state", lang };
  }
  if (any(HELP, s)) return { kind: "help", lang };
  if (any(THANKS, s)) return { kind: "thanks", lang };
  if (any(GREETING, s)) return { kind: "greeting", lang };
  return { kind: "unknown", lang };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
