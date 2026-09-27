import Database from "better-sqlite3";
import { existsSync } from "fs";
import { DB_PATHS } from "../config.js";
import { formatCanonicalReference, parseLogosAnchorJson, parseLogosRawReference, referencesOverlap } from "../domain/logos-reference.js";
import { stripRichText } from "../utils/strip-markup.js";
import { decodeClippingBlob, extractClippingText } from "../utils/clippings.js";
import { getResourceTitles } from "./catalog-reader.js";
import { extractBibleReferences } from "./reference-parser.js";
import type {
  ClippingResult,
  HighlightResult,
  FavoriteResult,
  WorkflowTemplate,
  WorkflowInstance,
  ReadingListStatus,
  ReadingListItem,
  ReadingProgress,
} from "../types.js";

function openDb(path: string): Database.Database {
  if (!existsSync(path)) {
    throw new Error(`Database not found: ${path}`);
  }
  return new Database(path, { readonly: true, fileMustExist: true });
}

// Escape LIKE wildcards in user input so "%" and "_" match literally.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

// ─── Highlights ──────────────────────────────────────────────────────────────

export interface HighlightRetrievalResult {
  items: HighlightResult[];
  completeness: "complete" | "partial" | "unknown";
  warnings: string[];
  scanned: number;
}

const HIGHLIGHT_SCAN_LIMIT = 10_000;

export function getUserHighlights(options: {
  resourceId?: string;
  styleName?: string;
  query?: string;
  passage?: string;
  limit?: number;
} = {}): HighlightResult[] {
  return getUserHighlightsWithStatus(options).items;
}

export function getUserHighlightsWithStatus(options: {
  resourceId?: string;
  styleName?: string;
  query?: string;
  passage?: string;
  limit?: number;
} = {}): HighlightRetrievalResult {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  if (options.passage && !referencesOverlap(options.passage, options.passage)) {
    return { items: [], completeness: "unknown", warnings: ["reference_unresolved"], scanned: 0 };
  }

  const scoped = Boolean(options.passage || options.query);
  const candidateLimit = scoped ? Math.ceil(HIGHLIGHT_SCAN_LIMIT / 2) : limit + 1;
  const warnings = new Set<string>();
  let availableSources = 0;
  const sourceResults: HighlightResult[][] = [];
  const sourceTables = [
    {
      path: DB_PATHS.visualMarkup,
      query: queryVisualMarkupHighlightsFromDatabase,
      name: "visual_markup",
    },
    {
      path: DB_PATHS.notes,
      query: getHighlightsFromNotesDatabase,
      name: "notes",
    },
  ] as const;
  for (const source of sourceTables) {
    if (!existsSync(source.path)) continue;
    try {
      const db = openDb(source.path);
      try {
        const rows = source.query(db, { ...options, limit: candidateLimit });
        availableSources++;
        sourceResults.push(rows);
      } finally {
        db.close();
      }
    } catch {
      warnings.add(`${source.name}_highlight_source_unavailable`);
    }
  }
  if (availableSources === 0) {
    return {
      items: [],
      completeness: "unknown",
      warnings: warnings.size > 0 ? [...warnings] : ["logos_database_unavailable"],
      scanned: 0,
    };
  }

  let results = sourceResults.flat().sort((left, right) =>
    (right.syncDate ?? "").localeCompare(left.syncDate ?? ""),
  );
  const scanned = results.length;
  if (scoped && sourceResults.some((rows) => rows.length >= candidateLimit)) {
    warnings.add("candidate_scan_limit");
  }
  if (options.passage) {
    results = results.filter((highlight) => {
      const reference = highlight.anchorReference ?? parseAnchorReference(highlight.textRange);
      if (!reference) {
        warnings.add("reference_unresolved");
        return false;
      }
      return referencesOverlap(reference, options.passage!);
    });
  }
  if (options.query) {
    const needle = options.query.toLocaleLowerCase();
    results = results.filter((highlight) =>
      highlight.styleName.toLocaleLowerCase().includes(needle) ||
      highlight.annotation?.toLocaleLowerCase().includes(needle) === true,
    );
    if (results.some((highlight) => !highlight.annotation)) warnings.add("highlight_text_unavailable");
  }

  if (results.length > limit) warnings.add("result_limit_reached");
  if (results.some((highlight) => !highlight.anchorReference)) warnings.add("reference_unresolved");
  if (results.some((highlight) => !highlight.annotation)) warnings.add("highlight_text_unavailable");

  const items = withResourceTitles(results.slice(0, limit));
  return {
    items,
    completeness: warnings.size > 0 ? "partial" : "complete",
    warnings: [...warnings],
    scanned,
  };
}

export function queryVisualMarkupHighlightsFromDatabase(
  db: Database.Database,
  options: { resourceId?: string; styleName?: string; query?: string; limit?: number },
): HighlightResult[] {
  let sql = "SELECT SyncId, ResourceId, SavedTextRange, MarkupStyleName, SyncDate FROM Markup WHERE IsDeleted = 0";
  const params: unknown[] = [];
  if (options.resourceId) {
    sql += " AND ResourceId = ?";
    params.push(options.resourceId);
  }
  const styleQuery = options.styleName ?? options.query;
  if (styleQuery) {
    sql += " AND MarkupStyleName LIKE ? ESCAPE '\\'";
    params.push(`%${escapeLike(styleQuery)}%`);
  }
  sql += " ORDER BY SyncDate DESC";
  if (options.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    SyncId: string | null;
    ResourceId: string;
    SavedTextRange: string;
    MarkupStyleName: string;
    SyncDate: string | null;
  }>;
  return rows.map((row) => ({
    sourceId: row.SyncId ?? undefined,
    resourceId: row.ResourceId,
    textRange: row.SavedTextRange,
    styleName: row.MarkupStyleName,
    syncDate: row.SyncDate,
    anchorReference: parseAnchorReference(row.SavedTextRange),
    annotation: null,
    resourceTitle: null,
  }));
}

export function getHighlightsFromNotesDatabase(
  db: Database.Database,
  options: { resourceId?: string; styleName?: string; query?: string; limit?: number },
): HighlightResult[] {
  const hasFacetReferences = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'NoteAnchorFacetReferences'",
  ).get());
  let sql = `
    SELECT n.NoteId, n.ExternalId, n.ContentRichText, n.AnchorsJson,
           ${hasFacetReferences ? "f.Reference" : "NULL"} AS FacetReference,
           r.ResourceId,
           s.Name AS StyleName, n.ModifiedDate
    FROM Notes n
    LEFT JOIN NoteStyles s ON n.NoteStyleId = s.NoteStyleId
    LEFT JOIN ResourceIds r ON n.AnchorResourceIdId = r.ResourceIdId
    ${hasFacetReferences ? "LEFT JOIN NoteAnchorFacetReferences f ON f.NoteId = n.NoteId AND f.BibleBook IS NOT NULL" : ""}
    WHERE n.Kind = 1 AND n.IsDeleted = 0 AND n.IsTrashed = 0
  `;
  const params: unknown[] = [];
  if (options.resourceId) {
    sql += " AND r.ResourceId = ?";
    params.push(options.resourceId);
  }
  const styleQuery = options.styleName ?? options.query;
  if (styleQuery) {
    const pattern = `%${escapeLike(styleQuery)}%`;
    sql += " AND (s.Name LIKE ? ESCAPE '\\' OR n.ContentRichText LIKE ? ESCAPE '\\')";
    params.push(pattern, pattern);
  }
  sql += " ORDER BY n.ModifiedDate DESC, n.NoteId DESC";
  if (options.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    NoteId: number;
    ExternalId: string | null;
    ContentRichText: string | null;
    AnchorsJson: string | null;
    FacetReference: string | null;
    ResourceId: string | null;
    StyleName: string | null;
    ModifiedDate: string | null;
  }>;
  return rows.map((row) => {
    const facetReference = row.FacetReference ? parseLogosRawReference(row.FacetReference) : null;
    return {
      sourceId: row.ExternalId ?? String(row.NoteId),
      resourceId: row.ResourceId ?? "",
      textRange: row.FacetReference ?? row.AnchorsJson ?? "",
      styleName: row.StyleName ?? "",
      syncDate: row.ModifiedDate,
      anchorReference: facetReference
        ? formatCanonicalReference(facetReference)
        : parseAnchorReference(row.AnchorsJson),
      annotation: stripRichText(row.ContentRichText),
      resourceTitle: null,
    };
  });
}

// Resolve resource titles lazily and batched: one catalog lookup per distinct
// resourceId (cached), null on any failure (catalog.db may be missing).
function withResourceTitles(results: HighlightResult[]): HighlightResult[] {
  if (results.length === 0) return results;
  const ids = [...new Set(results.map((h) => h.resourceId).filter(Boolean))];
  const titles = getResourceTitles(ids);
  return results.map((h) => ({
    ...h,
    resourceTitle: h.resourceId ? titles.get(h.resourceId) ?? null : null,
  }));
}

// ─── Favorites ───────────────────────────────────────────────────────────────

export function getFavorites(limit?: number): FavoriteResult[] {
  const db = openDb(DB_PATHS.favorites);
  try {
    let sql = `
      SELECT f.Id, f.Title, f.Rank, i.AppCommand, i.ResourceId
      FROM Favorites f
      JOIN Items i ON f.Id = i.FavoriteId
      WHERE f.IsDeleted = 0
      ORDER BY f.Rank ASC
    `;
    const params: unknown[] = [];
    if (limit) {
      sql += " LIMIT ?";
      params.push(limit);
    }

    const rows = db.prepare(sql).all(...params) as Array<{
      Id: string;
      Title: string;
      Rank: number;
      AppCommand: string;
      ResourceId: string | null;
    }>;

    return rows.map((r) => ({
      id: r.Id,
      title: r.Title,
      appCommand: r.AppCommand,
      resourceId: r.ResourceId,
      rank: r.Rank,
    }));
  } finally {
    db.close();
  }
}

// ─── Workflows ───────────────────────────────────────────────────────────────

export function getWorkflowTemplates(): WorkflowTemplate[] {
  const db = openDb(DB_PATHS.workflows);
  try {
    const rows = db.prepare(`
      SELECT TemplateId, ExternalId, TemplateJson, Author, CreatedDate
      FROM Templates WHERE IsDeleted = 0
    `).all() as Array<{
      TemplateId: number;
      ExternalId: string;
      TemplateJson: string | null;
      Author: string | null;
      CreatedDate: string;
    }>;

    return rows.map((r) => {
      let parsed: Record<string, unknown> | null = null;
      if (r.TemplateJson) {
        try {
          parsed = JSON.parse(r.TemplateJson);
        } catch { /* ignore parse errors */ }
      }
      return {
        templateId: r.TemplateId,
        externalId: r.ExternalId,
        title: (parsed as Record<string, string>)?.title ?? r.ExternalId,
        author: r.Author,
        templateJson: parsed,
        createdDate: r.CreatedDate,
      };
    });
  } finally {
    db.close();
  }
}

export function getWorkflowInstances(limit: number = 20): WorkflowInstance[] {
  const db = openDb(DB_PATHS.workflows);
  try {
    const rows = db.prepare(`
      SELECT InstanceId, ExternalId, TemplateId, Key, Title,
             CurrentStep, CompletedStepsJson, SkippedStepsJson,
             CreatedDate, CompletedDate, ModifiedDate
      FROM Instances WHERE IsDeleted = 0
      ORDER BY ModifiedDate DESC LIMIT ?
    `).all(limit) as Array<{
      InstanceId: number;
      ExternalId: string;
      TemplateId: string;
      Key: string;
      Title: string;
      CurrentStep: string | null;
      CompletedStepsJson: string | null;
      SkippedStepsJson: string | null;
      CreatedDate: string;
      CompletedDate: string | null;
      ModifiedDate: string | null;
    }>;

    return rows.map((r) => ({
      instanceId: r.InstanceId,
      externalId: r.ExternalId,
      templateId: r.TemplateId,
      key: r.Key,
      title: r.Title,
      currentStep: r.CurrentStep,
      completedSteps: safeParseArray(r.CompletedStepsJson),
      skippedSteps: safeParseArray(r.SkippedStepsJson),
      createdDate: r.CreatedDate,
      completedDate: r.CompletedDate,
      modifiedDate: r.ModifiedDate,
    }));
  } finally {
    db.close();
  }
}

// ─── Reading Progress ────────────────────────────────────────────────────────

function statusLabel(status: number): string {
  switch (status) {
    case 1:
      return "Active";
    case 2:
      return "Completed";
    default:
      return `Unknown (code ${status})`;
  }
}

export function getReadingProgress(): ReadingProgress {
  const db = openDb(DB_PATHS.readingLists);
  try {
    const statuses = db.prepare(`
      SELECT Title, Author, Path, Status, ModifiedDate
      FROM ReadingListStatuses WHERE IsDeleted = 0
    `).all() as Array<{
      Title: string;
      Author: string;
      Path: string;
      Status: number;
      ModifiedDate: string | null;
    }>;

    const items = db.prepare(`
      SELECT ItemId, ReadingListPathNormalized, IsRead, ModifiedDate
      FROM Items
    `).all() as Array<{
      ItemId: string;
      ReadingListPathNormalized: string;
      IsRead: number;
      ModifiedDate: string | null;
    }>;

    const totalItems = items.length;
    const completedItems = items.filter((i) => i.IsRead === 1).length;

    return {
      statuses: statuses.map((s) => ({
        title: s.Title,
        author: s.Author,
        path: s.Path,
        status: s.Status,
        statusLabel: statusLabel(s.Status),
        modifiedDate: s.ModifiedDate,
      })),
      items: items.map((i) => ({
        itemId: i.ItemId,
        readingListPath: i.ReadingListPathNormalized,
        isRead: i.IsRead === 1,
        modifiedDate: i.ModifiedDate,
      })),
      totalItems,
      completedItems,
      percentComplete: totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0,
    };
  } finally {
    db.close();
  }
}

// ─── Clippings ───────────────────────────────────────────────────────────────

export function getClippings(options: {
  resourceId?: string;
  tag?: string;
  query?: string;
  passage?: string;
  limit?: number;
} = {}): ClippingResult[] {
  return getClippingsWithStatus(options).items;
}

export function getClippingsWithStatus(options: {
  resourceId?: string;
  tag?: string;
  query?: string;
  passage?: string;
  limit?: number;
} = {}): ClippingRetrievalResult {
  const db = openDb(DB_PATHS.clippings);
  try {
    return getClippingsFromDatabase(db, options);
  } finally {
    db.close();
  }
}

export interface ClippingRetrievalResult {
  items: ClippingResult[];
  completeness: "complete" | "partial" | "unknown";
  warnings: string[];
  scanned: number;
}

const CLIPPING_PAGE_SIZE = 200;
const CLIPPING_SCAN_LIMIT = 10_000;

/** Query a caller-owned database for fixture tests; the production opener is read-only. */
export function getClippingsFromDatabase(
  db: Database.Database,
  options: {
    resourceId?: string;
    tag?: string;
    query?: string;
    passage?: string;
    limit?: number;
  } = {},
): ClippingRetrievalResult {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
  if (options.passage && !referencesOverlap(options.passage, options.passage)) {
    return { items: [], completeness: "unknown", warnings: ["reference_unresolved"], scanned: 0 };
  }

  let sql = `
      SELECT c.RowId, c.ResourceId, c.CreatedDate, c.Title as TitleBlob,
             c.Content as ContentBlob, c.Notes as NotesBlob, c.Tags,
             cd.Title as CollectionTitle
      FROM Clippings c
      LEFT JOIN ClippingsDocuments cd ON c.DocumentRowId = cd.RowId
      WHERE (cd.IsDeleted = 0 OR cd.IsDeleted IS NULL)
    `;
  const params: unknown[] = [];

  if (options.resourceId) {
    sql += " AND c.ResourceId = ?";
    params.push(options.resourceId);
  }

  if (options.tag) {
    sql += " AND c.Tags LIKE ? ESCAPE '\\'";
    params.push(`%${escapeLike(options.tag)}%`);
  }

  sql += " ORDER BY c.CreatedDate DESC, c.RowId DESC";

  const pageQuery = db.prepare(`${sql} LIMIT ? OFFSET ?`);
  const result: ClippingResult[] = [];
  const warnings = new Set<string>();
  let scanned = 0;
  let offset = 0;
  let hasMoreRows = false;

  while (scanned < CLIPPING_SCAN_LIMIT) {
    const currentPageSize = Math.min(CLIPPING_PAGE_SIZE, CLIPPING_SCAN_LIMIT - scanned);
    const rows = pageQuery.all(...params, currentPageSize, offset) as Array<{
      RowId: number;
      ResourceId: string;
      CreatedDate: string;
      TitleBlob: Buffer;
      ContentBlob: Buffer;
      NotesBlob: Buffer | null;
      Tags: string | null;
      CollectionTitle: string | null;
    }>;

    if (rows.length === 0) {
      hasMoreRows = false;
      break;
    }

    const mapped = rows.map((r) => ({
      rowId: r.RowId,
      resourceId: r.ResourceId,
      createdDate: r.CreatedDate,
      collectionTitle: r.CollectionTitle,
      title: extractClippingText(decodeClippingBlob(r.TitleBlob)),
      content: extractClippingText(decodeClippingBlob(r.ContentBlob)),
      notes: extractClippingText(decodeClippingBlob(r.NotesBlob)),
      tags: r.Tags,
    }));
    let matches = mapped;
    if (options.query) {
      const needle = options.query.toLocaleLowerCase();
      matches = matches.filter((item) => [item.title, item.content, item.notes, item.tags, item.collectionTitle, item.resourceId]
        .some((value) => value?.toLocaleLowerCase().includes(needle)));
    }
    if (options.passage) {
      matches = matches.filter((item) => {
        const references = extractBibleReferences(`${item.tags ?? ""}\n${item.title ?? ""}\n${item.content ?? ""}`);
        if (references.length === 0) {
          warnings.add("reference_unresolved");
          return false;
        }
        return references.some((reference) => referencesOverlap(reference, options.passage!));
      });
    }

    result.push(...matches);
    scanned += rows.length;
    offset += rows.length;
    if (result.length > limit) {
      hasMoreRows = true;
      break;
    }
    if (rows.length < currentPageSize) {
      hasMoreRows = false;
      break;
    }
    hasMoreRows = true;
  }

  if (result.length > limit) warnings.add("result_limit_reached");
  if (scanned >= CLIPPING_SCAN_LIMIT && hasMoreRows && result.length <= limit) {
    warnings.add("candidate_scan_limit");
  }

  return {
    items: result.slice(0, limit),
    completeness: warnings.size > 0 ? "partial" : "complete",
    warnings: [...warnings],
    scanned,
  };
}

// ─── Notes ───────────────────────────────────────────────────────────────────

export interface NoteResult {
  noteId: number;
  externalId: string;
  content: string | null;
  createdDate: string;
  modifiedDate: string | null;
  notebookTitle: string | null;
  anchorsJson: string | null;
  tagsJson: string | null;
  /** Best-effort human-readable Bible reference parsed from anchorsJson (null when not parseable). */
  anchorReference: string | null;
  /** Tags parsed from tagsJson (empty array on parse failure). */
  tags: string[];
}

export interface NoteRetrievalResult {
  items: NoteResult[];
  completeness: "complete" | "partial" | "unknown";
  warnings: string[];
  scanned: number;
}

const NOTE_PAGE_SIZE = 250;
const NOTE_SCAN_LIMIT = 10_000;
const MAX_NOTE_RESULTS = 100;

function boundedNoteLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 20;
  return Math.max(1, Math.min(MAX_NOTE_RESULTS, Math.floor(limit)));
}

export function getUserNotes(options: {
  notebookTitle?: string;
  limit?: number;
  query?: string;
  passage?: string;
} = {}): NoteResult[] {
  return getUserNotesWithStatus(options).items;
}

export function getUserNotesWithStatus(options: {
  notebookTitle?: string;
  limit?: number;
  query?: string;
  passage?: string;
} = {}): NoteRetrievalResult {
  const db = openDb(DB_PATHS.notes);
  try {
    return getUserNotesFromDatabase(db, options);
  } finally {
    db.close();
  }
}

/** Query a caller-owned database; exported so the SQL and filtering contract can be fixture-tested. */
export function getUserNotesFromDatabase(
  db: Database.Database,
  options: {
    notebookTitle?: string;
    limit?: number;
    query?: string;
    passage?: string;
  } = {},
): NoteRetrievalResult {
  const limit = boundedNoteLimit(options.limit);
  if (options.passage && !referencesOverlap(options.passage, options.passage)) {
    return {
      items: [],
      completeness: "unknown",
      warnings: ["reference_unresolved"],
      scanned: 0,
    };
  }

  let sql = `
      SELECT n.NoteId, n.ExternalId, n.ContentRichText, n.CreatedDate,
             n.ModifiedDate, nb.Title as NotebookTitle,
             n.AnchorsJson, n.TagsJson
      FROM Notes n
      LEFT JOIN Notebooks nb ON n.NotebookExternalId = nb.ExternalId AND nb.IsDeleted = 0
      WHERE n.IsDeleted = 0 AND n.IsTrashed = 0
        AND n.ContentRichText IS NOT NULL
    `;
  const params: unknown[] = [];

  if (options.notebookTitle) {
    sql += " AND nb.Title LIKE ? ESCAPE '\\'";
    params.push(`%${escapeLike(options.notebookTitle)}%`);
  }

  if (options.query) {
    sql += " AND (n.ContentRichText LIKE ? ESCAPE '\\' OR nb.Title LIKE ? ESCAPE '\\' OR n.TagsJson LIKE ? ESCAPE '\\')";
    const query = `%${escapeLike(options.query)}%`;
    params.push(query, query, query);
  }

  sql += " ORDER BY n.ModifiedDate DESC, n.NoteId DESC";

  const pageSize = options.passage ? NOTE_PAGE_SIZE : limit + 1;
  const scanLimit = options.passage ? NOTE_SCAN_LIMIT : limit + 1;
  const pageQuery = db.prepare(`${sql} LIMIT ? OFFSET ?`);
  const results: NoteResult[] = [];
  const warnings = new Set<string>();
  let scanned = 0;
  let offset = 0;
  let hasMoreRows = false;

  while (scanned < scanLimit) {
    const currentPageSize = Math.min(pageSize, scanLimit - scanned);
    const rows = pageQuery.all(...params, currentPageSize, offset) as Array<{
      NoteId: number;
      ExternalId: string;
      ContentRichText: string | null;
      CreatedDate: string;
      ModifiedDate: string | null;
      NotebookTitle: string | null;
      AnchorsJson: string | null;
      TagsJson: string | null;
    }>;
    if (rows.length === 0) {
      hasMoreRows = false;
      break;
    }

    const notes = rows
      .map((r) => ({
        noteId: r.NoteId,
        externalId: r.ExternalId,
        content: stripRichText(r.ContentRichText),
        createdDate: r.CreatedDate,
        modifiedDate: r.ModifiedDate,
        notebookTitle: r.NotebookTitle,
        anchorsJson: r.AnchorsJson,
        tagsJson: r.TagsJson,
        anchorReference: parseAnchorReference(r.AnchorsJson),
        tags: parseTagsJson(r.TagsJson),
      }))
      .filter((n) => n.content !== null);

    let matches = notes;
    if (options.passage) {
      matches = notes.filter((note) => {
        if (!note.anchorReference) {
          warnings.add("reference_unresolved");
          return false;
        }
        return referencesOverlap(note.anchorReference, options.passage!);
      });
    }
    results.push(...matches);
    scanned += rows.length;
    offset += rows.length;

    if (results.length > limit) {
      hasMoreRows = true;
      break;
    }
    if (rows.length < currentPageSize) {
      hasMoreRows = false;
      break;
    }
    hasMoreRows = true;
  }

  const items = results.slice(0, limit);
  if (results.length > limit || (!options.passage && hasMoreRows)) {
    warnings.add("result_limit_reached");
  }
  if (options.passage && scanned >= scanLimit && hasMoreRows && results.length <= limit) {
    warnings.add("candidate_scan_limit");
  }

  return {
    items,
    completeness: warnings.size > 0 ? "partial" : "complete",
    warnings: [...warnings],
    scanned,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeParseArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Best-effort human-readable Bible reference from a note's AnchorsJson.
// Returns null when the JSON is missing/malformed or no bible reference anchor
// is found. Never throws.
export function parseAnchorReference(anchorsJson: string | null): string | null {
  return parseLogosAnchorJson(anchorsJson);
}

// ─── Anchor / Tag JSON parsing ───────────────────────────────────────────────

// Tags from a note's TagsJson, e.g. [{"plain":{"text":"faith"}}] -> ["faith"].
// Returns an empty array when the JSON is missing/malformed. Never throws.
export function parseTagsJson(tagsJson: string | null): string[] {
  if (!tagsJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(tagsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const tags: string[] = [];
  for (const entry of parsed) {
    if (typeof entry === "string") {
      if (entry.length > 0) tags.push(entry);
    } else if (typeof entry === "object" && entry !== null) {
      const plain = (entry as Record<string, unknown>).plain;
      if (typeof plain === "object" && plain !== null) {
        const text = (plain as Record<string, unknown>).text;
        if (typeof text === "string" && text.length > 0) tags.push(text);
      }
    }
  }
  return tags;
}
