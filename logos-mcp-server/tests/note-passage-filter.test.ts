import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getUserNotesFromDatabase } from "../src/services/sqlite-reader.js";

describe("getUserNotesFromDatabase passage filtering", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE Notes (
        NoteId INTEGER PRIMARY KEY,
        ExternalId TEXT NOT NULL,
        ContentRichText TEXT,
        CreatedDate TEXT NOT NULL,
        ModifiedDate TEXT,
        IsDeleted INTEGER NOT NULL DEFAULT 0,
        IsTrashed INTEGER NOT NULL DEFAULT 0,
        NotebookExternalId TEXT,
        AnchorsJson TEXT,
        TagsJson TEXT
      );
      CREATE TABLE Notebooks (
        ExternalId TEXT PRIMARY KEY,
        Title TEXT,
        IsDeleted INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO Notes (NoteId, ExternalId, ContentRichText, CreatedDate, ModifiedDate, AnchorsJson)
      VALUES
        (1, 'fixture-1', 'new unrelated note', '2026-01-01', '2026-01-04', '[{"reference":{"raw":"bible.1.1.1"}}]'),
        (2, 'fixture-2', 'new unrelated note', '2026-01-01', '2026-01-03', '[{"reference":{"raw":"bible.19.1.1"}}]'),
        (3, 'fixture-3', 'new unrelated note', '2026-01-01', '2026-01-02', '[{"reference":{"raw":"bible.39.1.1"}}]'),
        (4, 'fixture-4', 'older matching note', '2025-01-01', '2025-01-01', '[{"reference":{"raw":"bible+esv.64.3.16"}}]'),
        (5, 'fixture-5', 'different verse', '2024-01-01', '2024-01-01', '[{"reference":{"raw":"bible.64.3.18"}}]');
    `);
  });

  afterEach(() => db.close());

  it("filters passage candidates before applying the final result limit", () => {
    const result = getUserNotesFromDatabase(db, { passage: "John 3:16", limit: 1 });
    expect(result.items.map((note) => note.noteId)).toEqual([4]);
    expect(result.items[0].anchorReference).toBe("John 3:16");
    expect(result.completeness).toBe("complete");
    expect(result.scanned).toBe(5);
  });

  it("keeps the final result limit and reports truncation when more matches exist", () => {
    db.prepare(`INSERT INTO Notes (NoteId, ExternalId, ContentRichText, CreatedDate, ModifiedDate, AnchorsJson)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      6,
      "fixture-6",
      "another matching note",
      "2023-01-01",
      "2023-01-01",
      '[{"reference":{"raw":"bible.64.3.16-64.3.17"}}]',
    );

    const result = getUserNotesFromDatabase(db, { passage: "John 3:16", limit: 1 });
    expect(result.items).toHaveLength(1);
    expect(result.completeness).toBe("partial");
    expect(result.warnings).toContain("result_limit_reached");
  });

  it("fails closed and reports unresolved passage input", () => {
    const result = getUserNotesFromDatabase(db, { passage: "Unknown 9:9", limit: 2 });
    expect(result.items).toEqual([]);
    expect(result.completeness).toBe("unknown");
    expect(result.warnings).toContain("reference_unresolved");
  });

  it("marks coverage partial when a candidate note has an unresolved Logos anchor", () => {
    db.prepare(`INSERT INTO Notes (NoteId, ExternalId, ContentRichText, CreatedDate, ModifiedDate, AnchorsJson)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      6,
      "fixture-unknown-anchor",
      "note with unverified anchor",
      "2023-01-01",
      "2023-01-01",
      '[{"reference":{"raw":"bible.40.1.1"}}]',
    );

    const result = getUserNotesFromDatabase(db, { passage: "John 3:16", limit: 10 });
    expect(result.warnings).toContain("reference_unresolved");
    expect(result.completeness).toBe("partial");
  });
});
