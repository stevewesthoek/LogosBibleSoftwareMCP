import { describe, expect, it } from "vitest";
import {
  formatCanonicalReference,
  parseLogosRawReference,
  referencesOverlap,
} from "../src/domain/logos-reference.js";

describe("Logos Bible anchor normalization", () => {
  it.each([
    ["bible.1.1.1", "Genesis 1:1"],
    ["bible.19.98", "Psalms 98"],
    ["bible.39.4.5", "Malachi 4:5"],
    ["bible.61.1.1", "Matthew 1:1"],
    ["bible.63.1.1", "Luke 1:1"],
    ["bible+esv.64.1.1", "John 1:1"],
    ["bible.66.8.28", "Romans 8:28"],
    ["bible.67.13.4", "1 Corinthians 13:4"],
    ["bible.68.5.11-68.5.21", "2 Corinthians 5:11-21"],
    ["bible.70.1.4-70.1.14", "Ephesians 1:4-14"],
    ["bible.79.4.12", "Hebrews 4:12"],
    ["bible+esv.80.1.2", "James 1:2"],
    ["bible.87.22.21", "Revelation 22:21"],
  ])("maps %s to %s", (raw, expected) => {
    const parsed = parseLogosRawReference(raw);
    expect(parsed).not.toBeNull();
    expect(formatCanonicalReference(parsed!)).toBe(expected);
  });

  it("normalizes cross-book ranges using Logos book numbers", () => {
    const parsed = parseLogosRawReference("bible.65.3.21-66.4.5");
    expect(parsed && formatCanonicalReference(parsed)).toBe("Acts 3:21-Romans 4:5");
  });

  it.each([40, 41, 60, 88, 999])(
    "does not guess a mapping for unverified or out-of-range Logos book %i",
    (book) => {
      expect(parseLogosRawReference(`bible.${book}.1.1`)).toBeNull();
    },
  );

  it.each([
    "bible.0.1.1",
    "bible.64.0.1",
    "bible.64.1.0",
    "bible.64.1.1-40.1.2",
    "bible.64.1.1-64.0.2",
    "bible.64.1.1-64.1.0",
    "not-a-bible-anchor",
  ])("rejects malformed or partially unknown anchor %s", (raw) => {
    expect(parseLogosRawReference(raw)).toBeNull();
  });
});

describe("Bible reference overlap", () => {
  it("matches a verse inside an anchored range", () => {
    expect(referencesOverlap("2 Corinthians 5:11-21", "2 Corinthians 5:15")).toBe(true);
  });

  it("rejects a non-overlapping verse in the same chapter", () => {
    expect(referencesOverlap("John 3:16", "John 3:17")).toBe(false);
  });

  it("matches a chapter-scoped query to a verse anchor in that chapter", () => {
    expect(referencesOverlap("James 1:2", "Jas 1")).toBe(true);
  });

  it("does not match a same-numbered reference in a different book", () => {
    expect(referencesOverlap("John 3:16", "1 John 3:16")).toBe(false);
  });

  it("fails closed for unparseable references", () => {
    expect(referencesOverlap("unknown 1:1", "John 1:1")).toBe(false);
  });
});
