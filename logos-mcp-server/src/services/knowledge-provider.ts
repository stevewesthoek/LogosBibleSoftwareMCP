import { BIBLIA_API_KEY } from "../config.js";
import { formatCanonicalReference, parseCanonicalReference } from "../domain/logos-reference.js";
import {
  referenceDetails,
  type LogosStudyItem,
  type LogosStudyKind,
  type RetrievalCompleteness,
  type RetrievalEnvelope,
  type RetrievalWarning,
} from "../domain/study-item.js";
import type { CatalogResource, ClippingResult, HighlightResult } from "../types.js";
import { getBibleText, searchBible } from "./biblia-api.js";
import { searchCatalog } from "./catalog-reader.js";
import { extractBibleReferences } from "./reference-parser.js";
import {
  getClippingsWithStatus,
  getUserHighlightsWithStatus,
  getUserNotesWithStatus,
  type ClippingRetrievalResult,
  type HighlightRetrievalResult,
  type NoteRetrievalResult,
} from "./sqlite-reader.js";

export type StudyContextInclude = "notes" | "highlights" | "clippings" | "bible" | "library";
export type PersonalStudySource = "notes" | "highlights" | "clippings";

const PERSONAL_STUDY_KIND: Record<PersonalStudySource, LogosStudyKind> = {
  notes: "note",
  highlights: "highlight",
  clippings: "clipping",
};

export interface StudyContextInput {
  passage?: string;
  query?: string;
  include?: StudyContextInclude[];
  limit?: number;
  bible?: string;
}

export interface SearchPersonalStudiesInput {
  query: string;
  passage?: string;
  sources?: PersonalStudySource[];
  limit?: number;
}

export interface KnowledgeProviderSources {
  notes: (options: { query?: string; passage?: string; limit: number }) => NoteRetrievalResult;
  highlights: (options: { query?: string; passage?: string; limit: number }) => HighlightRetrievalResult;
  clippings: (options: { query?: string; passage?: string; limit: number }) => ClippingRetrievalResult;
  catalog: (options: { query: string; limit: number }) => CatalogResource[];
  bibleText: (passage: string, bible?: string) => Promise<{ passage: string; text: string; bible: string }>;
  bibleSearch: (query: string, options: { bible?: string; limit: number }) => Promise<{
    query: string;
    resultCount: number;
    results: Array<{ title: string; preview: string }>;
  }>;
  bibleConfigured: boolean;
}

const DEFAULT_SOURCES: KnowledgeProviderSources = {
  notes: getUserNotesWithStatus,
  highlights: getUserHighlightsWithStatus,
  clippings: getClippingsWithStatus,
  catalog: searchCatalog,
  bibleText: getBibleText,
  bibleSearch: searchBible,
  bibleConfigured: Boolean(BIBLIA_API_KEY),
};

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 50;
const MAX_ITEM_CHARS = 4_000;
const MAX_BIBLE_CHARS = 16_000;

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function normalizePassage(passage: string | undefined): string | undefined {
  if (!passage) return undefined;
  const parsed = parseCanonicalReference(passage);
  if (!parsed) throw new Error("Passage could not be normalized to a supported Bible reference.");
  if (parsed.endChapter === Number.MAX_SAFE_INTEGER) return parsed.book;
  return formatCanonicalReference(parsed);
}

function bounded(text: string | null | undefined, max = MAX_ITEM_CHARS): { value?: string; truncated: boolean } {
  if (!text) return { truncated: false };
  if (text.length <= max) return { value: text, truncated: false };
  return { value: text.slice(0, max), truncated: true };
}

function makeItem(
  kind: LogosStudyKind,
  sourceId: string | undefined,
  mechanism: LogosStudyItem["provenance"]["mechanism"],
  fields: Omit<Partial<LogosStudyItem>, "provider" | "kind" | "sourceId" | "retrievedAt" | "provenance"> & {
    resourceId?: string;
  },
  retrievedAt: string,
): LogosStudyItem {
  const { resourceId, ...itemFields } = fields;
  return {
    provider: "logos",
    kind,
    ...(sourceId ? { sourceId } : {}),
    ...itemFields,
    retrievedAt,
    provenance: {
      provider: "logos",
      mechanism,
      sourceType: kind,
      ...(sourceId ? { sourceId } : {}),
      ...(resourceId ? { resourceId } : {}),
    },
  };
}

function toNoteItem(note: NoteRetrievalResult["items"][number], now: string): LogosStudyItem {
  const content = bounded(note.content);
  return makeItem("note", note.externalId || String(note.noteId), "sqlite", {
    ...(referenceDetails(note.anchorReference) ? { reference: referenceDetails(note.anchorReference) } : {}),
    title: note.notebookTitle ?? undefined,
    content: content.value,
    createdAt: note.createdDate,
    modifiedAt: note.modifiedDate ?? undefined,
  }, now);
}

function toHighlightItem(highlight: HighlightResult, now: string): LogosStudyItem {
  const annotation = bounded(highlight.annotation);
  return makeItem("highlight", highlight.sourceId, "sqlite", {
    ...(referenceDetails(highlight.anchorReference) ? { reference: referenceDetails(highlight.anchorReference) } : {}),
    resource: {
      ...(highlight.resourceId ? { id: highlight.resourceId } : {}),
      ...(highlight.resourceTitle ? { title: highlight.resourceTitle } : {}),
    },
    annotation: annotation.value,
    highlightStyle: highlight.styleName || undefined,
    modifiedAt: highlight.syncDate ?? undefined,
    resourceId: highlight.resourceId || undefined,
  }, now);
}

function toClippingItem(clipping: ClippingResult, now: string): LogosStudyItem {
  const content = bounded(clipping.content);
  const annotation = bounded(clipping.notes);
  const tagRefs = extractBibleReferences(`${clipping.tags ?? ""}\n${clipping.title ?? ""}\n${clipping.content ?? ""}`);
  const reference = tagRefs[0];
  return makeItem("clipping", String(clipping.rowId), "sqlite", {
    ...(referenceDetails(reference) ? { reference: referenceDetails(reference) } : {}),
    resource: { id: clipping.resourceId || undefined },
    title: clipping.title ?? clipping.collectionTitle ?? undefined,
    content: content.value,
    annotation: annotation.value,
    createdAt: clipping.createdDate,
    resourceId: clipping.resourceId || undefined,
  }, now);
}

function addSourceWarnings(
  warnings: RetrievalWarning[],
  source: LogosStudyKind,
  result: { completeness: RetrievalCompleteness; warnings: string[] },
): void {
  for (const code of result.warnings) warnings.push({ code, source });
  if (result.completeness !== "complete" && result.warnings.length === 0) {
    warnings.push({ code: result.completeness === "unknown" ? "source_completeness_unknown" : "source_partial", source });
  }
}

function roundRobin<T>(groups: T[][], limit: number): T[] {
  const result: T[] = [];
  for (let index = 0; result.length < limit; index++) {
    let appended = false;
    for (const group of groups) {
      const item = group[index];
      if (item !== undefined) {
        result.push(item);
        appended = true;
        if (result.length >= limit) break;
      }
    }
    if (!appended) break;
  }
  return result;
}

function envelope<Query>(
  query: Query,
  groups: LogosStudyItem[][],
  limit: number,
  successfulSources: number,
  sourceFailure: boolean,
  warnings: RetrievalWarning[],
): RetrievalEnvelope<Query> {
  const allItems = groups.flat();
  const items = roundRobin(groups, limit);
  if (allItems.length > limit) warnings.push({ code: "result_limit_reached" });
  const uniqueWarnings = [...new Map(warnings.map((warning) => [`${warning.code}:${warning.source ?? ""}`, warning])).values()];
  let completeness: RetrievalCompleteness = "complete";
  if (successfulSources === 0) completeness = "unknown";
  else if (sourceFailure || uniqueWarnings.length > 0) completeness = "partial";
  return { query, items, completeness, warnings: uniqueWarnings };
}

export async function getStudyContext(
  input: StudyContextInput,
  sources: KnowledgeProviderSources = DEFAULT_SOURCES,
): Promise<RetrievalEnvelope<{ passage?: string; query?: string; include: StudyContextInclude[] }>> {
  const query = input.query?.trim();
  const passage = normalizePassage(input.passage?.trim());
  if (!query && !passage) throw new Error("Provide a passage, a query, or both.");
  if (query && query.length > 300) throw new Error("Query must be 300 characters or fewer.");

  const include: StudyContextInclude[] = [...new Set<StudyContextInclude>(input.include ?? ["notes", "highlights", "clippings"])];
  const limit = normalizeLimit(input.limit);
  const now = new Date().toISOString();
  const groups: LogosStudyItem[][] = [];
  const warnings: RetrievalWarning[] = [];
  let successfulSources = 0;
  let sourceFailure = false;
  const sourceLimit = limit;

  if (include.includes("notes")) {
    try {
      const result = sources.notes({ query, passage, limit: sourceLimit });
      successfulSources++;
      addSourceWarnings(warnings, "note", result);
      const items = result.items.map((note) => toNoteItem(note, now));
      if (result.items.some((note) => (note.content?.length ?? 0) > MAX_ITEM_CHARS)) warnings.push({ code: "content_truncated", source: "note" });
      groups.push(items);
    } catch {
      sourceFailure = true;
      warnings.push({ code: "logos_database_unavailable", source: "note" });
      groups.push([]);
    }
  }

  if (include.includes("highlights")) {
    try {
      const result = sources.highlights({ query, passage, limit: sourceLimit });
      successfulSources++;
      addSourceWarnings(warnings, "highlight", result);
      const items = result.items.map((highlight) => toHighlightItem(highlight, now));
      if (result.items.some((highlight) => !highlight.annotation)) warnings.push({ code: "highlight_text_unavailable", source: "highlight" });
      if (result.items.some((highlight) => (highlight.annotation?.length ?? 0) > MAX_ITEM_CHARS)) warnings.push({ code: "content_truncated", source: "highlight" });
      groups.push(items);
    } catch {
      sourceFailure = true;
      warnings.push({ code: "logos_database_unavailable", source: "highlight" });
      groups.push([]);
    }
  }

  if (include.includes("clippings")) {
    try {
      const result = sources.clippings({ query, passage, limit: sourceLimit });
      successfulSources++;
      addSourceWarnings(warnings, "clipping", result);
      const items = result.items.map((clipping) => toClippingItem(clipping, now));
      if (result.items.some((clipping) => (clipping.content?.length ?? 0) > MAX_ITEM_CHARS || (clipping.notes?.length ?? 0) > MAX_ITEM_CHARS)) warnings.push({ code: "content_truncated", source: "clipping" });
      if (passage && result.items.some((clipping) => !clipping.tags && !clipping.content)) warnings.push({ code: "reference_unresolved", source: "clipping" });
      groups.push(items);
    } catch {
      sourceFailure = true;
      warnings.push({ code: "logos_database_unavailable", source: "clipping" });
      groups.push([]);
    }
  }

  if (include.includes("library")) {
    try {
      const libraryQuery = query ?? referenceDetails(passage)?.book ?? passage ?? "";
      const catalogItems = sources.catalog({ query: libraryQuery, limit: sourceLimit });
      successfulSources++;
      const items = catalogItems.map((resource) => toLibraryItem(resource, now));
      if (catalogItems.length >= sourceLimit) warnings.push({ code: "result_limit_reached", source: "library_metadata" });
      groups.push(items);
    } catch {
      sourceFailure = true;
      warnings.push({ code: "library_catalog_unavailable", source: "library_metadata" });
      groups.push([]);
    }
  }

  if (include.includes("bible")) {
    if (!sources.bibleConfigured) {
      warnings.push({ code: "biblia_api_not_configured", source: "bible" });
      sourceFailure = true;
      groups.push([]);
    } else {
      try {
        if (passage) {
          const result = await sources.bibleText(passage, input.bible);
          successfulSources++;
          const content = bounded(result.text, MAX_BIBLE_CHARS);
          if (content.truncated) warnings.push({ code: "content_truncated", source: "bible" });
          groups.push([makeItem("bible", `biblia:${result.bible}:${result.passage}`, "biblia", {
            reference: referenceDetails(result.passage),
            resource: { id: result.bible, title: result.bible, type: "Bible translation" },
            content: content.value,
          }, now)]);
        } else if (query) {
          const result = await sources.bibleSearch(query, { bible: input.bible, limit: sourceLimit });
          successfulSources++;
          if (result.results.length >= sourceLimit) warnings.push({ code: "result_limit_reached", source: "bible" });
          groups.push(result.results.map((hit) => makeItem("bible", `biblia:${input.bible ?? "LEB"}:${hit.title}`, "biblia", {
            reference: referenceDetails(hit.title),
            resource: { id: input.bible ?? "LEB", title: input.bible ?? "LEB", type: "Bible translation" },
            title: hit.title,
            content: bounded(hit.preview).value,
          }, now)));
        }
      } catch (error) {
        sourceFailure = true;
        warnings.push({ code: error instanceof Error && error.message.includes("BIBLIA_API_KEY") ? "biblia_api_not_configured" : "biblia_api_unavailable", source: "bible" });
        groups.push([]);
      }
    }
  }

  return envelope({ passage, query, include }, groups, limit, successfulSources, sourceFailure, warnings);
}

export async function searchPersonalStudies(
  input: SearchPersonalStudiesInput,
  sources: KnowledgeProviderSources = DEFAULT_SOURCES,
): Promise<RetrievalEnvelope<{ query: string; passage?: string; sources: PersonalStudySource[] }>> {
  const query = input.query.trim();
  if (query.length === 0 || query.length > 300) throw new Error("Query must contain 1–300 characters.");
  const passage = normalizePassage(input.passage?.trim());
  const sourcesToSearch = [...new Set(input.sources ?? ["notes", "highlights", "clippings"])] as PersonalStudySource[];
  const limit = normalizeLimit(input.limit);
  const now = new Date().toISOString();
  const groups: LogosStudyItem[][] = [];
  const warnings: RetrievalWarning[] = [];
  let successfulSources = 0;
  let sourceFailure = false;

  for (const source of sourcesToSearch) {
    const kind = PERSONAL_STUDY_KIND[source];
    try {
      if (source === "notes") {
        const result = sources.notes({ query, passage, limit });
        successfulSources++;
        addSourceWarnings(warnings, kind, result);
        if (result.items.some((note) => (note.content?.length ?? 0) > MAX_ITEM_CHARS)) warnings.push({ code: "content_truncated", source: kind });
        groups.push(result.items.map((note) => toNoteItem(note, now)));
      } else if (source === "highlights") {
        const result = sources.highlights({ query, passage, limit });
        successfulSources++;
        addSourceWarnings(warnings, kind, result);
        if (result.items.some((highlight) => !highlight.annotation)) warnings.push({ code: "highlight_text_unavailable", source: "highlight" });
        if (result.items.some((highlight) => (highlight.annotation?.length ?? 0) > MAX_ITEM_CHARS)) warnings.push({ code: "content_truncated", source: kind });
        groups.push(result.items.map((highlight) => toHighlightItem(highlight, now)));
      } else {
        const result = sources.clippings({ query, passage, limit });
        successfulSources++;
        addSourceWarnings(warnings, kind, result);
        if (result.items.some((clipping) => (clipping.content?.length ?? 0) > MAX_ITEM_CHARS || (clipping.notes?.length ?? 0) > MAX_ITEM_CHARS)) warnings.push({ code: "content_truncated", source: kind });
        groups.push(result.items.map((clipping) => toClippingItem(clipping, now)));
      }
    } catch {
      sourceFailure = true;
      warnings.push({ code: "logos_database_unavailable", source: kind });
      groups.push([]);
    }
  }

  return envelope({ query, passage, sources: sourcesToSearch }, groups, limit, successfulSources, sourceFailure, warnings);
}

function toLibraryItem(resource: CatalogResource, now: string): LogosStudyItem {
  return makeItem("library_metadata", resource.resourceId, "sqlite", {
    resource: {
      id: resource.resourceId,
      title: resource.title,
      author: resource.authors ?? undefined,
      type: resource.type,
    },
    title: resource.title,
  }, now);
}
