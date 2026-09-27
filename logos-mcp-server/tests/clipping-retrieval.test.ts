import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getClippingsFromDatabase } from "../src/services/sqlite-reader.js";

function blob(text: string): Buffer {
  return Buffer.concat([Buffer.from([0x02, 0, 0, 0]), Buffer.from(`<Span><Run Text='${text}' /></Span>`, "utf8")]);
}

describe("getClippingsFromDatabase", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE Clippings (
        RowId INTEGER PRIMARY KEY,
        ResourceId TEXT NOT NULL,
        CreatedDate TEXT NOT NULL,
        Title BLOB NOT NULL,
        Content BLOB NOT NULL,
        Notes BLOB,
        Tags TEXT,
        DocumentRowId INTEGER
      );
      CREATE TABLE ClippingsDocuments (RowId INTEGER PRIMARY KEY, Title TEXT, IsDeleted INTEGER);
    `);
  });

  afterEach(() => db.close());

  it("searches live clipping fields and scopes passage matches before final limit", () => {
    const insert = db.prepare(`INSERT INTO Clippings
      (RowId, ResourceId, CreatedDate, Title, Content, Notes, Tags, DocumentRowId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run(1, "LLS:FIXTURE", "2026-04-04", blob("Other"), blob("Unrelated"), null, "Genesis 1:1", null);
    insert.run(2, "LLS:FIXTURE", "2026-04-03", blob("Other"), blob("Unrelated"), null, "Psalms 23", null);
    insert.run(3, "LLS:FIXTURE", "2025-01-01", blob("Study"), blob("Grace in trials"), blob("review"), "Jas 1:2-4", null);

    const scoped = getClippingsFromDatabase(db, { passage: "James 1:3", query: "grace", limit: 1 });
    expect(scoped.items.map((item) => item.rowId)).toEqual([3]);
    expect(scoped.items[0].content).toBe("Grace in trials");
    expect(scoped.completeness).toBe("complete");
    expect(scoped.scanned).toBe(3);
  });

  it("reports unresolved references in clippings when passage scope cannot be established", () => {
    db.prepare(`INSERT INTO Clippings (RowId, ResourceId, CreatedDate, Title, Content, Tags)
      VALUES (?, ?, ?, ?, ?, ?)`).run(1, "LLS:FIXTURE", "2026-01-01", blob("Title"), blob("Content"), null);
    const result = getClippingsFromDatabase(db, { passage: "John 3:16", limit: 5 });
    expect(result.items).toEqual([]);
    expect(result.completeness).toBe("partial");
    expect(result.warnings).toContain("reference_unresolved");
  });
});
