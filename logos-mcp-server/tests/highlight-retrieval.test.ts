import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getHighlightsFromNotesDatabase,
  queryVisualMarkupHighlightsFromDatabase,
} from "../src/services/sqlite-reader.js";

describe("highlight database adapters", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => db.close());

  it("normalizes modern note-backed highlight references, IDs, style, and annotation", () => {
    db.exec(`
      CREATE TABLE Notes (
        NoteId INTEGER PRIMARY KEY, ExternalId TEXT, ContentRichText TEXT, AnchorsJson TEXT,
        AnchorResourceIdId INTEGER, NoteStyleId INTEGER, ModifiedDate TEXT,
        Kind INTEGER, IsDeleted INTEGER, IsTrashed INTEGER
      );
      CREATE TABLE NoteAnchorFacetReferences (
        NoteAnchorFacetReferenceId INTEGER PRIMARY KEY, NoteId INTEGER, AnchorIndex INTEGER,
        DataTypeId INTEGER, BibleBook INTEGER, SortKey BLOB, Reference TEXT
      );
      CREATE TABLE NoteStyles (NoteStyleId INTEGER PRIMARY KEY, Name TEXT);
      CREATE TABLE ResourceIds (ResourceIdId INTEGER PRIMARY KEY, ResourceId TEXT);
      INSERT INTO NoteStyles VALUES (1, 'Blue Highlight');
      INSERT INTO ResourceIds VALUES (10, 'LLS:FIXTURE');
      INSERT INTO Notes VALUES (
        5, 'fixture-highlight-5', 'Safe fixture annotation',
        '[]', 10, 1, '2026-01-02', 1, 0, 0
      );
      INSERT INTO NoteAnchorFacetReferences VALUES (
        1, 5, 0, 1, 80, X'00', 'bible+esv.80.1.2'
      );
    `);

    const result = getHighlightsFromNotesDatabase(db, { query: "fixture annotation", limit: 10 });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sourceId: "fixture-highlight-5",
      resourceId: "LLS:FIXTURE",
      anchorReference: "James 1:2",
      annotation: "Safe fixture annotation",
      styleName: "Blue Highlight",
      syncDate: "2026-01-02",
    });
  });

  it("falls back to AnchorsJson when an older Logos schema has no facet table", () => {
    db.exec(`
      CREATE TABLE Notes (
        NoteId INTEGER PRIMARY KEY, ExternalId TEXT, ContentRichText TEXT, AnchorsJson TEXT,
        AnchorResourceIdId INTEGER, NoteStyleId INTEGER, ModifiedDate TEXT,
        Kind INTEGER, IsDeleted INTEGER, IsTrashed INTEGER
      );
      CREATE TABLE NoteStyles (NoteStyleId INTEGER PRIMARY KEY, Name TEXT);
      CREATE TABLE ResourceIds (ResourceIdId INTEGER PRIMARY KEY, ResourceId TEXT);
      INSERT INTO Notes VALUES (
        6, 'legacy-highlight-6', 'Legacy fixture annotation',
        '[{"reference":{"raw":"bible.68.5.11-68.5.21"}}]', NULL, NULL, '2026-01-03', 1, 0, 0
      );
    `);

    const result = getHighlightsFromNotesDatabase(db, { limit: 10 });
    expect(result[0]).toMatchObject({
      sourceId: "legacy-highlight-6",
      anchorReference: "2 Corinthians 5:11-21",
      annotation: "Legacy fixture annotation",
    });
  });

  it("normalizes legacy visual markup reference and keeps unavailable text explicit", () => {
    db.exec(`
      CREATE TABLE Markup (
        SyncId TEXT, ResourceId TEXT, SavedTextRange TEXT, MarkupStyleName TEXT,
        SyncDate TEXT, IsDeleted INTEGER
      );
      INSERT INTO Markup VALUES (
        'fixture-sync-1', 'LLS:FIXTURE',
        '[{"reference":{"raw":"bible.68.5.11-68.5.21"}}]',
        'Yellow', '2026-01-03', 0
      );
    `);

    const result = queryVisualMarkupHighlightsFromDatabase(db, { limit: 10 });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sourceId: "fixture-sync-1",
      resourceId: "LLS:FIXTURE",
      anchorReference: "2 Corinthians 5:11-21",
      annotation: null,
      styleName: "Yellow",
      syncDate: "2026-01-03",
    });
  });
});
