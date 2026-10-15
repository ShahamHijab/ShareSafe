import { COMMON_ENGLISH } from "./englishWords";
import type { Category, Detection, Rect } from "./types";

export type OCRWord = {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
};

type Rule = {
  category: Category;
  regex: RegExp;
  confidence: Detection["confidence"];
  validate?: (match: string) => boolean;
};

const rules: Rule[] = [
  { category: "Email", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, confidence: "Pattern match" },
  {
    category: "Pakistan phone",
    // Accept OCR splitting digits into separate words, and common separators
    // (spaces, dots, brackets, and hyphens) between digits.
    regex: /(?<!\d)(?:(?:(?:\+|00)?92[\s().-]*)?(?:0?3(?:[\s().-]*\d){9}|3(?:[\s().-]*\d){9})|(?:\+?92[\s().-]*|0)(?:21|42|51|41|91|61|81|22|24|25|26|44|45|46|48|52|53|55|56|57|58|62|63|64|65|66|67|68|69|71|72|73|74|75|76|77|78|82|83|84|85|86|87|88|89)(?:[\s().-]*\d){6,8})(?!\d)/g,
    confidence: "Pattern match",
    validate: (value) => {
      const digits = value.replace(/\D/g, "");
      return digits.length >= 10 && digits.length <= 13;
    },
  },
  {
    category: "CNIC",
    // Allows OCR to split a CNIC into arbitrary digit groups, not just 5-7-1.
    regex: /(?<!\d)(?:\d[\s().-]*){12}\d(?!\d)/g,
    confidence: "Pattern match",
    validate: (value) => value.replace(/\D/g, "").length === 13,
  },
  {
    category: "Bank account",
    // Masked numbers as shown by banking apps: PK11xxx6497, 0405xxx2719, ****2719, PK****8969.
    // Tolerates OCR slips in the visible digits (O/o for 0, I/l for 1, a stray "/").
    regex: /(?<![A-Za-z0-9])(?:PK\d{0,2}[A-Z]{0,4}|[\dOo]{2,6})?[*xX\u2022\u25CF]{3,}(?:\s?[\dOoIl/]){3,6}(?![A-Za-z0-9])/gi,
    confidence: "Pattern match",
  },
  {
    category: "Bank account",
    // Full Pakistani IBAN: PK + 2 check digits + 4-letter bank code + 16 digits (spaces allowed).
    regex: /(?<![A-Za-z0-9])PK\s?\d{2}\s?[A-Z]{4}\s?(?:\d\s?){15}\d(?!\d)/gi,
    confidence: "Pattern match",
    validate: (value) => value.replace(/\s/g, "").length === 24,
  },
  {
    category: "Bank account",
    // Heavily masked IBAN that OCR turned into junk, e.g. "PK AKKKKKKKKKKKKKKQOGO":
    // "PK" followed by a long token that has a run of one repeated character or mask symbols.
    regex: /(?<![A-Za-z0-9])PK\s?[A-Za-z0-9*\u2022\u25CF#]{10,40}(?![A-Za-z0-9*\u2022\u25CF#])/g,
    confidence: "Pattern match",
    validate: (value) => {
      const rest = value.replace(/^PK\s?/, "");
      return /(.)\1{4,}/i.test(rest) || /[*\u2022\u25CF#]/.test(rest);
    },
  },
  {
    category: "Bank account",
    // Unmasked account number right after an "account / A/C / IBAN" label.
    regex: /(?<=\b(?:account|acct?|a\/c|iban)\s*(?:no\.?|number|num\.?|#)?\s*[:\-]?\s*)\d(?:[ -]?\d){7,22}(?!\d)/gi,
    confidence: "Heuristic",
    validate: (value) => value.replace(/\D/g, "").length >= 8,
  },
  {
    category: "IP address",
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    confidence: "Pattern match",
    validate: (value) => value.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255),
  },
  { category: "URL", regex: /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi, confidence: "Pattern match" },
  {
    category: "Possible secret",
    regex: /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd|bearer)\s*[:=]\s*[^\s,;]{4,}|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/gi,
    confidence: "Heuristic",
  },
];

// Address labels are strong evidence, but city names and administrative terms alone
// are not addresses. Keep the unlabeled heuristic deliberately conservative.
const ADDRESS_LABEL = /(?:^|\b)(?:(?:my|our|home|current|permanent|residential|delivery|mailing)\s+)?address(?:\s+in\s+pakistan)?(?:\s*(?:is|:|-)\s*|\s+)/i;
const STRONG_ADDRESS_CUE = /\b(?:h\s*\.?\s*no\.?|house\s*(?:no\.?|number)?|flat\s*(?:no\.?|number)?|apartment|apt\.?|plot\s*(?:no\.?|number)?|street|st\.?\s*no\.?|road|rd\.?|lane|marg|avenue|ave\.?|mohalla|muhalla|village|gaon|chak|block|phase|sector|colony|housing\s+scheme|society|cantonment|cantt\.?|dha|bahria|gulberg|gulshan|clifton|pechs|nazimabad|model\s+town|johar\s+town|faisal\s+town|wapda\s+town|satellite\s+town|askari|pwd|near|opposite|opp\.?|behind|adjacent|landmark|chowk|chorangi|bazaar|bazar|market|markaz|postal\s+code|postcode|zip\s+code|p\s*\.?\s*o\.?\s*box)\b/i;
const ADDRESS_NUMBER = /(?:\b\d{1,5}\s*[/\-]?[A-Z]{0,3}\b|\b#\s*\d+\b)/i;

function lineGroups(words: OCRWord[]): OCRWord[][] {
  const sorted = [...words].sort((a, b) => {
    const ay = (a.bbox.y0 + a.bbox.y1) / 2;
    const by = (b.bbox.y0 + b.bbox.y1) / 2;
    return ay - by || a.bbox.x0 - b.bbox.x0;
  });
  const lines: OCRWord[][] = [];
  for (const word of sorted) {
    const cy = (word.bbox.y0 + word.bbox.y1) / 2;
    const h = Math.max(1, word.bbox.y1 - word.bbox.y0);
    let best: OCRWord[] | undefined;
    let bestDistance = Infinity;
    for (const line of lines) {
      const lineY = line.reduce((sum, w) => sum + (w.bbox.y0 + w.bbox.y1) / 2, 0) / line.length;
      const lineH = line.reduce((sum, w) => sum + Math.max(1, w.bbox.y1 - w.bbox.y0), 0) / line.length;
      const distance = Math.abs(cy - lineY);
      // Cap the tolerance so one oversized junk box (a logo read as text) cannot pull neighbouring lines together.
      const tolerance = Math.min(Math.max(h, lineH), Math.min(h, lineH) * 1.6) * 0.65;
      if (distance <= tolerance && distance < bestDistance) {
        best = line;
        bestDistance = distance;
      }
    }
    if (best) best.push(word);
    else lines.push([word]);
  }
  return lines.map((line) => line.sort((a, b) => a.bbox.x0 - b.bbox.x0));
}

function addressDetections(words: OCRWord[], existing: Detection[]): Detection[] {
  const lines = lineGroups(words);
  const accepted: { words: OCRWord[]; text: string }[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const value = line.map((word) => word.text).join(" ").replace(/\s+/g, " ").trim();
    if (value.length < 5 || value.length > 260) continue;

    const labelMatch = ADDRESS_LABEL.exec(value);
    if (labelMatch) {
      const labelEnd = (labelMatch.index ?? 0) + labelMatch[0].length;
      let cursor = 0;
      const valueWords = line.filter((word) => {
        const begin = cursor;
        const finish = begin + word.text.length;
        cursor = finish + 1;
        return finish > labelEnd && word.text.trim().length > 0;
      });
      let addressWords = [...valueWords];
      let addressText = addressWords.map((word) => word.text).join(" ").trim();

      // Chat bubbles often wrap a labeled address onto the next OCR line.
      // Include at most two following lines, and only if they contain address evidence.
      if (addressText.length < 8 || !(ADDRESS_NUMBER.test(addressText) || STRONG_ADDRESS_CUE.test(addressText) || /[,/]/.test(addressText))) {
        for (let next = index + 1; next < Math.min(lines.length, index + 3); next++) {
          const nextLine = lines[next];
          const nextText = nextLine.map((word) => word.text).join(" ").replace(/\s+/g, " ").trim();
          if (!nextText || nextText.length > 180) break;
          const hasEvidence = ADDRESS_NUMBER.test(nextText) || STRONG_ADDRESS_CUE.test(nextText) || /[,/]/.test(nextText);
          if (!hasEvidence) break;
          addressWords.push(...nextLine);
          addressText = addressWords.map((word) => word.text).join(" ").trim();
        }
      }
      // A bare label or generic phrase like "my address is home" is not enough.
      if (addressText.length >= 8 && (ADDRESS_NUMBER.test(addressText) || STRONG_ADDRESS_CUE.test(addressText) || /[,/]/.test(addressText))) {
        accepted.push({ words: addressWords, text: addressText });
      }
      continue;
    }

    // Unlabeled address: require specific address evidence plus a number, or
    // multiple address cues. City names alone never qualify.
    const cues = value.match(new RegExp(STRONG_ADDRESS_CUE.source, "gi")) || [];
    const hasNumber = ADDRESS_NUMBER.test(value);
    const hasComma = /[,;]/.test(value);
    if ((cues.length >= 1 && hasNumber && value.length >= 12) || (cues.length >= 2 && hasComma && value.length >= 16)) {
      accepted.push({ words: line, text: value });
    }
  }

  const chosen: typeof accepted = [];
  for (const candidate of accepted) {
    const ids = new Set(candidate.words);
    if (chosen.some((item) => item.words.filter((word) => ids.has(word)).length / Math.min(item.words.length, candidate.words.length) > 0.7)) continue;
    chosen.push(candidate);
  }

  return chosen.map((candidate, index) => ({
    id: `Pakistan address-${index}-${candidate.words[0]?.bbox.y0 ?? 0}`,
    category: "Pakistan address" as const,
    text: candidate.text,
    confidence: "Heuristic" as const,
    rect: union(candidate.words),
    selected: true,
  })).filter((item) => !existing.some((d) => d.category === item.category && d.text.toLowerCase() === item.text.toLowerCase()));
}

function normalizedWord(word: string) {
  return word.replace(/^[^A-Za-z0-9@+]+|[^A-Za-z0-9@./:_+-]+$/g, "");
}

function union(words: OCRWord[]): Rect {
  const xs = words.map((w) => w.bbox.x0);
  const ys = words.map((w) => w.bbox.y0);
  const xe = words.map((w) => w.bbox.x1);
  const ye = words.map((w) => w.bbox.y1);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xe) - Math.min(...xs), height: Math.max(...ye) - Math.min(...ys) };
}


function mostlyInside(inner: Rect, outer: Rect, threshold = 0.8): boolean {
  const w = Math.max(0, Math.min(inner.x + inner.width, outer.x + outer.width) - Math.max(inner.x, outer.x));
  const h = Math.max(0, Math.min(inner.y + inner.height, outer.y + outer.height) - Math.max(inner.y, outer.y));
  const area = inner.width * inner.height;
  return area > 0 && (w * h) / area >= threshold;
}

// ---------------------------------------------------------------------------
// Masked account numbers, found by layout rather than exact text.
//
// OCR rarely reads "PK*******************8969" cleanly. It comes back as fragments such as
// "PK*x**" "kk" "kkk" "k*xkxk*xk*x*x*x*x89Q69", or "PKT1xxx6497/". Instead of matching one
// string, find a seed (a "PK" token or a token containing mask characters) and merge the
// neighbouring pieces that sit on the same line, close together, and look like mask/digit debris.
// ---------------------------------------------------------------------------
function isMaskish(text: string): boolean {
  return /[*\u2022\u25CF]/.test(text) || /[xX]{3,}/.test(text) || /^[kKxX]{2,}$/.test(text);
}

function isDigitish(text: string): boolean {
  const chars = text.replace(/[^A-Za-z0-9/|]/g, "");
  if (!chars || /[,:;]/.test(text)) return false;
  return (chars.match(/[0-9OoIlQ/|]/g) || []).length / chars.length >= 0.6;
}

function isPkAnchor(text: string): boolean {
  return /^PK(?!R)/.test(text);
}

function maskedAccountDetections(words: OCRWord[], existing: Detection[]): Detection[] {
  const found: { words: OCRWord[]; text: string }[] = [];
  for (const line of lineGroups(words)) {
    const used = new Set<number>();
    const compatible = (word: OCRWord) => /^[A-Za-z0-9*\u2022\u25CF#._/|\\-]{1,40}$/.test(word.text) && (isMaskish(word.text) || isDigitish(word.text));
    const near = (a: OCRWord, b: OCRWord) => b.bbox.x0 - a.bbox.x1 <= Math.max(1, a.bbox.y1 - a.bbox.y0) * 1.8;

    for (let i = 0; i < line.length; i++) {
      if (used.has(i)) continue;
      const anchored = isPkAnchor(line[i].text);
      if (!anchored && !isMaskish(line[i].text)) continue;

      let from = i;
      while (!anchored && from > 0 && !used.has(from - 1) && compatible(line[from - 1]) && near(line[from - 1], line[from])) from--;
      let to = i;
      while (to + 1 < line.length && compatible(line[to + 1]) && near(line[to], line[to + 1])) to++;
      for (let k = from; k <= to; k++) used.add(k);

      const cluster = line.slice(from, to + 1);
      const joined = cluster.map((word) => word.text).join("");
      const maskCount = (joined.match(/[*\u2022\u25CF xXkK]/g) || []).length - (joined.match(/ /g) || []).length;
      const digitCount = (joined.match(/[0-9]/g) || []).length;
      const accept = anchored
        ? joined.length >= 10 && (maskCount >= 3 || digitCount >= 8)
        : joined.length >= 7 && (joined.match(/[*\u2022\u25CF]|[xX]/g) || []).length >= 3 && digitCount >= 3;
      if (accept) found.push({ words: cluster, text: cluster.map((word) => word.text).join(" ") });
    }
  }
  return found
    .map((item, index) => ({
      id: `Bank account-layout-${index}-${item.words[0].bbox.y0}`,
      category: "Bank account" as const,
      text: item.text,
      confidence: "Pattern match" as const,
      rect: union(item.words),
      selected: true,
    }))
    .filter((item) => !existing.some((d) => mostlyInside(item.rect, d.rect)));
}

// ---------------------------------------------------------------------------
// Person names
//
// There is no local named-entity model, so names are found from context and word shape:
//   1. A label or title cue ("From Account:", "transferred to", "Beneficiary", "Dr", "my name is")
//      followed by a name on the same line or on the very next line.
//   2. A run of capitalised words (Title Case or ALL CAPS) with no label, judged by what each word is:
//        strong = a known given name/surname, or a word that is not ordinary English
//                 (Shaham, Ammar, Zainab, Rewa ...)
//        word   = an ordinary English word (Hijab, Express ...)
//        weak   = a short ALL-CAPS token that is probably an acronym (TID, STAN)
//      A run needs at least one strong word. If it contains ordinary English words it must be the
//      whole line (a standalone name line), so "Ali Express arrived" is not flagged.
// Stop-words (banks, cities, brands, receipt vocabulary, greetings...) never count as names.
// ---------------------------------------------------------------------------
const NAME_STOPWORDS = new Set((
  "transaction successful transfer transferred transferring via raast account payment purpose amount fee free others " +
  "reference number type date time bank limited ltd pvt private microfinance branch pkr rs rupees tid stan from to the " +
  "and for with your you our this that thank thanks hello hey dear sir madam customer valued user team all everyone " +
  "friend friends guest salam assalam alaikum aoa good morning evening night bye okay please sorry welcome " +
  "id cnic phone mobile email address city country pakistan punjab sindh balochistan khyber lahore karachi " +
  "islamabad faisalabad rawalpindi multan peshawar quetta hyderabad sialkot gujranwala sargodha jhang sahiwal okara " +
  "bahawalpur gujrat kasur sheikhupura mardan abbottabad mingora sukkur larkana nawabshah mirpur muzaffarabad gilgit " +
  "skardu chitral swat murree hafizabad jhelum attock chakwal mianwali bhakkar layyah dera " +
  "meezan hbl ubl mcb alfalah faysal askari allied habib standard chartered jazzcash easypaisa sadapay nayapay " +
  "upaisa whatsapp instagram facebook twitter google youtube tiktok snapchat telegram linkedin amazon daraz " +
  "foodpanda careem uber sent received paid credited debited success failed pending completed status details " +
  "summary receipt invoice online banking app title name holder beneficiary sender receiver recipient payee payer " +
  "remitter depositor january february march april may june july august september october november december " +
  "monday tuesday wednesday thursday friday saturday sunday today yesterday tomorrow share download save done " +
  "close back next continue confirm cancel yes new more total balance available current savings visa mastercard " +
  "securely send pay"
).split(" "));

const NAME_LEXICON = new Set((
  "muhammad mohammad mohammed muhammed mohd ahmed ahmad ali hassan hasan hussain husain hussein usman uthman umar omar " +
  "bilal hamza ibrahim ismail ishaq yousaf yusuf yousuf zain zaid zayd faisal farhan fahad fawad imran irfan kamran " +
  "kashif nadeem naveed nauman noman rizwan saad saeed sajid salman shahid shahzad shoaib tariq talha waqar waseem wasim " +
  "zahid zubair asad adnan arslan awais danish junaid haider hashim hamid haris harris jawad khalid majid mansoor " +
  "mubashir qasim rehman rahman raza riaz sohail sultan abbas abdullah abdul adil afzal akbar akram amir ammar anas ayaz " +
  "ayub babar basit daniyal ejaz faheem fahim fraz ghulam hafiz haroon ihsan iqbal jamil kabir mudassar moin murtaza " +
  "nasir naseer owais qaiser rafay rauf rehan shafiq shakeel shehzad sheraz taimoor tahir taha umair wahab yasir zeeshan " +
  "zohaib fatima ayesha aisha aysha maryam mariam zainab khadija khadeeja sara sarah sana saba hira iqra noor nida nimra " +
  "rabia rida rimsha rukhsar sadia saima samina shaista sidra sumaira tahira uzma zara areeba aneeqa amna anum asma " +
  "bushra farah fiza huma laiba mahnoor maham mehwish misbah mishal moona nabila naima rafia rehana sehrish shazia sobia " +
  "sonia tooba urooj warda yumna zoya khan malik shah butt chaudhry choudhry chaudhary cheema sheikh shaikh siddiqui " +
  "qureshi ansari hashmi mirza baig bhatti awan rajput jutt mughal niazi lodhi abbasi memon"
).split(" "));

const LABEL_NAME_CUE = /(?:\b(?:transferred|transfer|sent|send|paid|pay|credited|deposited|remitted)\s+to|\b(?:received|recieved|transferred|sent|paid|debited)\s+from|\bpaid\s+by|\b(?:from|to)\s+account|\baccount\s+(?:title|name|holder)|\b(?:beneficiary|sender|receiver|recipient|payee|payer|remitter|cardholder|depositor)(?:\s+name)?|\b(?:name|from|to)(?=\s*:))\s*[:\-]?\s*/gi;
const TITLE_NAME_CUE = /(?:\b(?:Mr|Mrs|Ms|Miss|Dr|Prof|Engr|Dear)\b\.?\s+|\b(?:my\s+name\s+is|name\s+is)\s+)/g;

type TokenKind = "strong" | "weak" | "word";

function cleanNameToken(text: string) {
  return text.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
}

// null means the token cannot be part of a name at all.
function tokenKind(text: string): TokenKind | null {
  if (/[0-9@/\\_:]/.test(text)) return null;
  const t = cleanNameToken(text);
  if (t.length < 2 || t.length > 20) return null;
  const allCaps = /^[A-Z'’-]+$/.test(t);
  if (!(/^[A-Z][a-z'’-]*$/.test(t) || allCaps)) return null; // Title Case or ALL CAPS only
  if (/(.)\1{3,}/i.test(t)) return null; // OCR junk like "KKKKKK"
  const lower = t.toLowerCase();
  if (NAME_STOPWORDS.has(lower)) return null;
  if (NAME_LEXICON.has(lower)) return "strong";
  if (t.length < 3) return null;
  if (COMMON_ENGLISH.has(lower)) return "word";
  if (allCaps && t.length <= 4) return "weak";
  return "strong";
}

function nameRuns(line: OCRWord[]): OCRWord[][] {
  const runs: OCRWord[][] = [];
  let current: OCRWord[] = [];
  const flush = () => { if (current.length) runs.push(current); current = []; };
  for (const word of line) {
    if (!tokenKind(word.text)) { flush(); continue; }
    const previous = current[current.length - 1];
    if (previous) {
      const height = Math.max(1, word.bbox.y1 - word.bbox.y0);
      if (word.bbox.x0 - previous.bbox.x1 > height * 1.6) flush(); // words far apart are not one name
    }
    current.push(word);
  }
  flush();
  return runs;
}

function kindCounts(run: OCRWord[]) {
  const counts = { strong: 0, weak: 0, word: 0 };
  for (const word of run) counts[tokenKind(word.text)!]++;
  return counts;
}

// Drop ordinary English words from the edges ("Hello Ayesha Khan" -> "Ayesha Khan") while 2+ tokens remain.
function trimEdges(run: OCRWord[]): OCRWord[] {
  let out = run;
  while (out.length > 2 && tokenKind(out[0].text) === "word") out = out.slice(1);
  while (out.length > 2 && tokenKind(out[out.length - 1].text) === "word") out = out.slice(0, -1);
  return out;
}

// A run that follows a label or title cue.
function cuedRunIsName(run: OCRWord[], allowSingle: boolean): boolean {
  if (run.length > 5) return false;
  const counts = kindCounts(run);
  if (run.length >= 2) return true; // a label right before 2+ capitalised words is strong evidence on its own
  return allowSingle || counts.strong === 1;
}

function wordsAfter(line: OCRWord[], offset: number): OCRWord[] {
  let cursor = 0;
  return line.filter((word) => {
    const finish = cursor + word.text.length;
    cursor = finish + 1;
    return finish > offset;
  });
}

function nameDetections(words: OCRWord[], existing: Detection[]): Detection[] {
  const lines = lineGroups(words);
  const accepted: OCRWord[][] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const text = line.map((word) => word.text).join(" ");
    let handled = false;

    for (const [cue, allowSingle] of [[LABEL_NAME_CUE, false], [TITLE_NAME_CUE, true]] as const) {
      cue.lastIndex = 0;
      for (const match of text.matchAll(cue)) {
        const remainder = wordsAfter(line, (match.index ?? 0) + match[0].length);
        const sameLine = nameRuns(remainder).map(trimEdges).find((run) => cuedRunIsName(run, allowSingle));
        if (sameLine) { accepted.push(sameLine); handled = true; continue; }

        // Label at the end of the line ("From Account:") -> the name is on the next line.
        const labelEndsLine = remainder.every((word) => cleanNameToken(word.text).length < 3);
        const nextLine = lines[index + 1];
        if (!labelEndsLine || !nextLine || allowSingle) continue;
        const here = union(line);
        const below = union(nextLine);
        if (below.y - (here.y + here.height) > here.height * 2.5) continue; // too far below to belong to the label
        const anchorX = union(wordsAfter(line, match.index ?? 0).slice(0, 1)).x;
        const candidates = nameRuns(nextLine).map(trimEdges).filter((run) => cuedRunIsName(run, false));
        candidates.sort((a, b) => b.length - a.length || Math.abs(union(a).x - anchorX) - Math.abs(union(b).x - anchorX));
        if (candidates[0]) { accepted.push(candidates[0]); handled = true; }
      }
    }
    if (handled) continue;

    // No label. Never on lines that look like addresses ("Faisal Town", "Muhammad Ali Jinnah Road").
    if (STRONG_ADDRESS_CUE.test(text)) continue;
    const meaningful = line.filter((word) => cleanNameToken(word.text).length >= 3);
    for (const raw of nameRuns(line)) {
      const run = trimEdges(raw);
      if (run.length < 2 || run.length > 4) continue;
      const counts = kindCounts(run);
      if (counts.strong === 0) continue;
      if ((counts.strong + counts.weak) * 2 < run.length) continue;
      // Ordinary English words are allowed only when the name stands alone on its line.
      const standalone = meaningful.every((word) => run.includes(word));
      if (counts.word === 0 || standalone) accepted.push(run);
    }
  }

  const chosen: OCRWord[][] = [];
  for (const run of accepted) {
    const ids = new Set(run);
    if (chosen.some((other) => other.filter((word) => ids.has(word)).length > 0)) continue;
    chosen.push(run);
  }

  return chosen
    .map((run, index) => ({
      id: `Person name-${index}-${run[0].bbox.y0}`,
      category: "Person name" as const,
      text: run.map((word) => cleanNameToken(word.text)).join(" "),
      confidence: "Heuristic" as const,
      rect: union(run),
      selected: true,
    }))
    .filter((item) => !existing.some((d) => mostlyInside(item.rect, d.rect, 0.5)));
}

export function detectPatterns(words: OCRWord[]): Detection[] {
  const usable = words.filter((word) => word.text.trim());
  const text = usable.map((word) => word.text).join(" ");
  const detections: Detection[] = [];
  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    for (const match of text.matchAll(rule.regex)) {
      const value = match[0];
      if (rule.validate && !rule.validate(value)) continue;
      const start = match.index ?? 0;
      const end = start + value.length;
      let cursor = 0;
      const matchedWords = usable.filter((word) => {
        const wordStart = cursor;
        const wordEnd = cursor + word.text.length;
        cursor = wordEnd + 1;
        return wordEnd > start && wordStart < end;
      });
      if (!matchedWords.length) continue;
      const rect = union(matchedWords);
      const duplicate = detections.some((d) => d.category === rule.category && d.text.toLowerCase() === value.toLowerCase());
      if (duplicate) continue;
      // Skip a match that sits (almost) entirely inside a box we already have, so two rules
      // firing on the same text never produce stacked or extra redaction boxes.
      if (detections.some((d) => mostlyInside(rect, d.rect))) continue;
      detections.push({
        id: `${rule.category}-${start}-${detections.length}`,
        category: rule.category,
        text: value,
        confidence: rule.confidence,
        rect,
        selected: true,
      });
    }
  }
  // Layout-based masked account numbers: replace any smaller partial matches the regexes made.
  const masked = maskedAccountDetections(usable, []);
  for (let i = detections.length - 1; i >= 0; i--) {
    if (detections[i].category === "Bank account" && masked.some((m) => mostlyInside(detections[i].rect, m.rect))) detections.splice(i, 1);
  }
  detections.push(...masked.filter((m) => !detections.some((d) => mostlyInside(m.rect, d.rect))));
  detections.push(...addressDetections(usable, detections));
  detections.push(...nameDetections(usable, detections));
  return detections;
}

export function createManualDetection(rect: Rect): Detection {
  return {
    id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    category: "Possible secret",
    text: "Manual redaction",
    confidence: "Heuristic",
    rect,
    selected: true,
  };
}
