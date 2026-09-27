import { formatCanonicalReference, parseCanonicalReference } from "./logos-reference.js";

export type LogosStudyKind =
  | "note"
  | "highlight"
  | "clipping"
  | "bible"
  | "library_metadata"
  | "other";

export type RetrievalCompleteness = "complete" | "partial" | "unknown";

export type LogosRetrievalMechanism = "sqlite" | "biblia" | "logos-ui" | "screen-capture" | "other";

export interface LogosReference {
  canonical: string;
  book: string;
  chapter: number;
  verseStart?: number;
  verseEnd?: number;
  endBook?: string;
  endChapter?: number;
}

export interface LogosResourceIdentity {
  id?: string;
  title?: string;
  author?: string;
  type?: string;
}

export interface LogosStudyItem {
  provider: "logos";
  kind: LogosStudyKind;
  sourceId?: string;
  reference?: LogosReference;
  resource?: LogosResourceIdentity;
  title?: string;
  content?: string;
  annotation?: string;
  highlightStyle?: string;
  createdAt?: string;
  modifiedAt?: string;
  retrievedAt: string;
  provenance: {
    provider: "logos";
    mechanism: LogosRetrievalMechanism;
    sourceType: LogosStudyKind;
    sourceId?: string;
    resourceId?: string;
  };
}

export interface RetrievalWarning {
  code: string;
  source?: LogosStudyKind;
}

export interface RetrievalEnvelope<Query> {
  query: Query;
  items: LogosStudyItem[];
  completeness: RetrievalCompleteness;
  warnings: RetrievalWarning[];
}

export function referenceDetails(reference: string | null | undefined): LogosReference | undefined {
  if (!reference) return undefined;
  const parsed = parseCanonicalReference(reference);
  if (!parsed) return undefined;

  return {
    canonical: formatCanonicalReference(parsed),
    book: parsed.book,
    chapter: parsed.chapter,
    ...(parsed.verse === undefined ? {} : { verseStart: parsed.verse }),
    ...(parsed.endVerse === undefined ? {} : { verseEnd: parsed.endVerse }),
    ...(parsed.endBook === undefined ? {} : { endBook: parsed.endBook }),
    ...(parsed.endChapter === undefined ? {} : { endChapter: parsed.endChapter }),
  };
}
