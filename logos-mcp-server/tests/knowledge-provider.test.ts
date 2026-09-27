import { describe, expect, it } from "vitest";
import {
  getStudyContext,
  searchPersonalStudies,
  type KnowledgeProviderSources,
} from "../src/services/knowledge-provider.js";
import type { NoteResult } from "../src/services/sqlite-reader.js";
import type { ClippingResult, HighlightResult } from "../src/types.js";

const note: NoteResult = {
  noteId: 7,
  externalId: "note-external-7",
  content: "John 3:16 is central to this note.",
  createdDate: "2025-01-01T00:00:00.000Z",
  modifiedDate: "2025-01-02T00:00:00.000Z",
  notebookTitle: "Gospel Study",
  anchorsJson: null,
  tagsJson: null,
  anchorReference: "John 3:16",
  tags: [],
};

const highlight: HighlightResult = {
  sourceId: "highlight-8",
  resourceId: "LLS:1.0.1",
  textRange: "John 3:16",
  styleName: "Blue",
  syncDate: "2025-01-03T00:00:00.000Z",
  anchorReference: "John 3:16",
  annotation: "Promise",
  resourceTitle: "Study Bible",
};

const clipping: ClippingResult = {
  rowId: 9,
  resourceId: "LLS:1.0.2",
  createdDate: "2025-01-04T00:00:00.000Z",
  collectionTitle: "Saved Passages",
  title: "John 3:16",
  content: "For God so loved the world",
  notes: "A clipping annotation",
  tags: "John 3:16",
};

function makeSources(overrides: Partial<KnowledgeProviderSources> = {}): KnowledgeProviderSources {
  return {
    notes: () => ({ items: [note], completeness: "complete", warnings: [], scanned: 1 }),
    highlights: () => ({ items: [highlight], completeness: "complete", warnings: [], scanned: 1 }),
    clippings: () => ({ items: [clipping], completeness: "complete", warnings: [], scanned: 1 }),
    catalog: () => [],
    bibleText: async (passage, bible = "LEB") => ({ passage, bible, text: "Bible text" }),
    bibleSearch: async (query) => ({ query, resultCount: 0, results: [] }),
    bibleConfigured: true,
    ...overrides,
  };
}

describe("getStudyContext", () => {
  it("normalizes the passage and combines provenance-preserving personal study items", async () => {
    const result = await getStudyContext({ passage: "Jn 3:16", limit: 3 }, makeSources());

    expect(result.query.passage).toBe("John 3:16");
    expect(result.completeness).toBe("complete");
    expect(result.items.map((item) => item.kind)).toEqual(["note", "highlight", "clipping"]);
    expect(result.items[0]).toMatchObject({
      provider: "logos",
      sourceId: "note-external-7",
      reference: { canonical: "John 3:16", book: "John", chapter: 3, verseStart: 16 },
      provenance: { provider: "logos", mechanism: "sqlite", sourceType: "note", sourceId: "note-external-7" },
    });
    expect(result.items[1].resource).toMatchObject({ id: "LLS:1.0.1", title: "Study Bible" });
    expect(result.items[1].annotation).toBe("Promise");
  });

  it("marks partial data and unavailable highlight text explicitly", async () => {
    const result = await getStudyContext({ passage: "John 3:16" }, makeSources({
      notes: () => ({ items: [note], completeness: "partial", warnings: ["candidate_scan_limit"], scanned: 10_000 }),
      highlights: () => ({ items: [{ ...highlight, annotation: null }], completeness: "complete", warnings: [], scanned: 1 }),
      clippings: () => ({ items: [], completeness: "complete", warnings: [], scanned: 1 }),
    }));

    expect(result.completeness).toBe("partial");
    expect(result.warnings).toContainEqual({ code: "candidate_scan_limit", source: "note" });
    expect(result.warnings).toContainEqual({ code: "highlight_text_unavailable", source: "highlight" });
  });

  it("bounds content and warns when it truncates", async () => {
    const longNote = { ...note, content: "x".repeat(4_001) };
    const result = await getStudyContext({ passage: "John 3:16", include: ["notes"] }, makeSources({
      notes: () => ({ items: [longNote], completeness: "complete", warnings: [], scanned: 1 }),
    }));

    expect(result.items[0].content).toHaveLength(4_000);
    expect(result.warnings).toContainEqual({ code: "content_truncated", source: "note" });
    expect(result.completeness).toBe("partial");
  });

  it("rejects an unparseable passage and empty scope", async () => {
    await expect(getStudyContext({ passage: "not a Bible reference" }, makeSources())).rejects.toThrow("Passage could not be normalized");
    await expect(getStudyContext({}, makeSources())).rejects.toThrow("Provide a passage");
  });
});

describe("searchPersonalStudies", () => {
  it("queries only requested sources and retains the normalized source kind", async () => {
    let highlightCalls = 0;
    const result = await searchPersonalStudies({ query: "promise", sources: ["notes"] }, makeSources({
      highlights: () => {
        highlightCalls++;
        return { items: [highlight], completeness: "complete", warnings: [], scanned: 1 };
      },
    }));

    expect(highlightCalls).toBe(0);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].kind).toBe("note");
    expect(result.items[0].provenance.sourceType).toBe("note");
    expect(result.completeness).toBe("complete");
  });

  it("reports database and source failures without returning raw errors", async () => {
    const result = await searchPersonalStudies({ query: "promise", sources: ["notes"] }, makeSources({
      notes: () => { throw new Error("/private/path/to/notestool.db is unavailable"); },
    }));

    expect(result.completeness).toBe("unknown");
    expect(result.warnings).toContainEqual({ code: "logos_database_unavailable", source: "note" });
    expect(JSON.stringify(result)).not.toContain("/private/path");
  });
});
