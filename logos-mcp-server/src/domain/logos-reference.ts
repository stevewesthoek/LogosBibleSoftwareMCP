import type { ParsedReference } from "../types.js";
import { parseReference, resolveBookName } from "../services/reference-parser.js";

const OLD_TESTAMENT_BOOKS = [
  "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy", "Joshua",
  "Judges", "Ruth", "1 Samuel", "2 Samuel", "1 Kings", "2 Kings",
  "1 Chronicles", "2 Chronicles", "Ezra", "Nehemiah", "Esther", "Job",
  "Psalms", "Proverbs", "Ecclesiastes", "Song of Solomon", "Isaiah",
  "Jeremiah", "Lamentations", "Ezekiel", "Daniel", "Hosea", "Joel",
  "Amos", "Obadiah", "Jonah", "Micah", "Nahum", "Habakkuk", "Zephaniah",
  "Haggai", "Zechariah", "Malachi",
] as const;

// Logos issue #10 confirms the New Testament range is 61–87, with examples
// cross-checked against NoteAnchorFacetReferences. The 40–60 range is left
// unmapped until its per-install versification is verified.
const NEW_TESTAMENT_BOOKS = [
  "Matthew", "Mark", "Luke", "John", "Acts", "Romans", "1 Corinthians",
  "2 Corinthians", "Galatians", "Ephesians", "Philippians", "Colossians",
  "1 Thessalonians", "2 Thessalonians", "1 Timothy", "2 Timothy", "Titus",
  "Philemon", "Hebrews", "James", "1 Peter", "2 Peter", "1 John", "2 John",
  "3 John", "Jude", "Revelation",
] as const;

const CANONICAL_BOOKS = [...OLD_TESTAMENT_BOOKS, ...NEW_TESTAMENT_BOOKS];
const BOOK_ORDER = new Map<string, number>(CANONICAL_BOOKS.map((book, index) => [book, index]));

const BIBLE_RAW_RE =
  /^bible(?:\+[a-z0-9_-]+)?\.(\d+)\.(\d+)(?:\.(\d+))?(?:-(\d+)\.(\d+)(?:\.(\d+))?)?$/i;

export interface LogosParsedReference extends ParsedReference {
  endBook?: string;
}

function bookForLogosNumber(bookNumber: number): string | null {
  if (bookNumber >= 1 && bookNumber <= OLD_TESTAMENT_BOOKS.length) {
    return OLD_TESTAMENT_BOOKS[bookNumber - 1];
  }
  if (bookNumber >= 61 && bookNumber <= 87) {
    return NEW_TESTAMENT_BOOKS[bookNumber - 61];
  }
  return null;
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Parse a Logos Bible anchor without guessing unsupported book numbering. */
export function parseLogosRawReference(raw: string): LogosParsedReference | null {
  const match = raw.match(BIBLE_RAW_RE);
  if (!match) return null;

  const bookNumber = Number(match[1]);
  const chapter = Number(match[2]);
  const verse = match[3] === undefined ? undefined : Number(match[3]);
  const endBookNumber = match[4] === undefined ? undefined : Number(match[4]);
  const endChapter = match[5] === undefined ? undefined : Number(match[5]);
  const endVerse = match[6] === undefined ? undefined : Number(match[6]);

  const book = bookForLogosNumber(bookNumber);
  if (!book || !isPositiveInteger(chapter)) return null;
  if (verse !== undefined && !isPositiveInteger(verse)) return null;
  if (endChapter !== undefined && !isPositiveInteger(endChapter)) return null;
  if (endVerse !== undefined && !isPositiveInteger(endVerse)) return null;

  let endBook: string | undefined;
  if (endBookNumber !== undefined) {
    endBook = bookForLogosNumber(endBookNumber) ?? undefined;
    if (!endBook) return null;
  }

  if (endChapter === undefined && (endBookNumber !== undefined || endVerse !== undefined)) {
    return null;
  }

  return {
    book,
    chapter,
    ...(endBook === undefined ? {} : { endBook }),
    ...(verse === undefined ? {} : { verse }),
    ...(endChapter === undefined ? {} : { endChapter }),
    ...(endVerse === undefined ? {} : { endVerse }),
  };
}

/** Convert parsed fields into the stable, full-name consumer representation. */
export function formatCanonicalReference(reference: ParsedReference): string {
  let result = `${reference.book} ${reference.chapter}`;
  if (reference.verse !== undefined) result += `:${reference.verse}`;
  if (reference.endChapter !== undefined) {
    const endBook = "endBook" in reference && typeof reference.endBook === "string"
      ? reference.endBook
      : reference.book;
    if (endBook !== reference.book) {
      result += `-${endBook} ${reference.endChapter}`;
      if (reference.endVerse !== undefined) result += `:${reference.endVerse}`;
    } else if (reference.endVerse !== undefined) {
      result += reference.endChapter === reference.chapter
        ? `-${reference.endVerse}`
        : `-${reference.endChapter}:${reference.endVerse}`;
    } else {
      result += `-${reference.endChapter}`;
    }
  }
  return result;
}

/** Parse Logos' AnchorsJson and return its first supported Bible reference. */
export function parseLogosAnchorJson(anchorsJson: string | null): string | null {
  if (!anchorsJson) return null;

  let anchors: unknown;
  try {
    anchors = JSON.parse(anchorsJson);
  } catch {
    return null;
  }
  if (!Array.isArray(anchors)) return null;

  for (const anchor of anchors) {
    if (typeof anchor !== "object" || anchor === null) continue;
    const reference = (anchor as Record<string, unknown>).reference;
    if (typeof reference !== "object" || reference === null) continue;
    const raw = (reference as Record<string, unknown>).raw;
    if (typeof raw !== "string") continue;
    const parsed = parseLogosRawReference(raw);
    if (parsed) return formatCanonicalReference(parsed);
  }
  return null;
}

function interval(reference: ParsedReference): {
  startBook: number;
  startChapter: number;
  startVerse: number;
  endBook: number;
  endChapter: number;
  endVerse: number;
} {
  const startBook = BOOK_ORDER.get(reference.book);
  const endBookName = "endBook" in reference && typeof reference.endBook === "string"
    ? reference.endBook
    : reference.book;
  const endBook = BOOK_ORDER.get(endBookName);
  if (startBook === undefined || endBook === undefined) {
    throw new Error("Reference book is outside the supported Protestant canon");
  }
  const endChapter = reference.endChapter ?? reference.chapter;
  const endVerse = reference.endVerse ??
    (reference.endChapter !== undefined || reference.verse === undefined
      ? Number.POSITIVE_INFINITY
      : reference.verse);
  return {
    startBook,
    startChapter: reference.chapter,
    startVerse: reference.verse ?? 1,
    endBook,
    endChapter,
    endVerse,
  };
}

function comparePosition(
  left: { book: number; chapter: number; verse: number },
  right: { book: number; chapter: number; verse: number },
): number {
  if (left.book !== right.book) return left.book - right.book;
  if (left.chapter !== right.chapter) return left.chapter - right.chapter;
  return left.verse - right.verse;
}

export function parseCanonicalReference(input: string): LogosParsedReference | null {
  try {
    return parseReference(input);
  } catch {
    // Continue to support a whole-book scope and cross-book ranges below.
  }

  const wholeBook = resolveBookName(input);
  if (wholeBook) return { book: wholeBook, chapter: 1, endChapter: Number.MAX_SAFE_INTEGER };

  const crossBook = input.match(/^(.+?)\s+(\d+)(?::(\d+))?\s*[-–]\s*(.+?)\s+(\d+)(?::(\d+))?$/);
  if (!crossBook) return null;

  try {
    const start = parseReference(`${crossBook[1]} ${crossBook[2]}${crossBook[3] ? `:${crossBook[3]}` : ""}`);
    const end = parseReference(`${crossBook[4]} ${crossBook[5]}${crossBook[6] ? `:${crossBook[6]}` : ""}`);
    return {
      ...start,
      endBook: end.book,
      endChapter: end.chapter,
      ...(end.verse === undefined ? {} : { endVerse: end.verse }),
    };
  } catch {
    return null;
  }
}

/** True only when two parseable canonical Bible references overlap. */
export function referencesOverlap(left: string, right: string): boolean {
  const a = parseCanonicalReference(left);
  const b = parseCanonicalReference(right);
  if (!a || !b) return false;

  let ai: ReturnType<typeof interval>;
  let bi: ReturnType<typeof interval>;
  try {
    ai = interval(a);
    bi = interval(b);
  } catch {
    return false;
  }
  const aStartsBeforeBEnds = comparePosition(
    { book: ai.startBook, chapter: ai.startChapter, verse: ai.startVerse },
    { book: bi.endBook, chapter: bi.endChapter, verse: bi.endVerse },
  ) <= 0;
  const bStartsBeforeAEnds = comparePosition(
    { book: bi.startBook, chapter: bi.startChapter, verse: bi.startVerse },
    { book: ai.endBook, chapter: ai.endChapter, verse: ai.endVerse },
  ) <= 0;
  return aStartsBeforeBEnds && bStartsBeforeAEnds;
}
