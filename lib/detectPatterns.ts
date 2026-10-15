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
      if (distance <= Math.max(h, lineH) * 0.65 && distance < bestDistance) {
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
  detections.push(...addressDetections(usable, detections));
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
