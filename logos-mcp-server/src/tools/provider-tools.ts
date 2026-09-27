import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BIBLIA_API_KEY, DB_PATHS, LOGOS_CATALOG_DIR, LOGOS_DATA_DIR } from "../config.js";
import { getStudyContext, searchPersonalStudies } from "../services/knowledge-provider.js";

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function jsonError(error: unknown) {
  const message = error instanceof Error ? error.message : "The provider request failed.";
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true as const,
  };
}

export function getProviderHealthReport() {
  const databases = {
    notes: existsSync(DB_PATHS.notes),
    visualMarkup: existsSync(DB_PATHS.visualMarkup),
    clippings: existsSync(DB_PATHS.clippings),
    catalog: existsSync(DB_PATHS.catalog),
  };
  const readableDatabase = Object.values(DB_PATHS).find((path) => existsSync(path));
  let sqliteReadable = false;
  if (readableDatabase) {
    try {
      const db = new Database(readableDatabase, { readonly: true, fileMustExist: true });
      try {
        db.prepare("SELECT 1").get();
        sqliteReadable = true;
      } finally {
        db.close();
      }
    } catch {
      sqliteReadable = false;
    }
  }

  const warnings: string[] = [];
  if (!databases.notes) warnings.push("notes_database_unavailable");
  if (!databases.clippings) warnings.push("clippings_database_unavailable");
  if (!databases.catalog) warnings.push("library_catalog_unavailable");
  if (!sqliteReadable && readableDatabase) warnings.push("sqlite_unreadable");
  if (!BIBLIA_API_KEY) warnings.push("biblia_api_not_configured");

  return {
    status: sqliteReadable && databases.notes ? "ok" : "degraded",
    provider: "logos-knowledge-provider",
    readOnly: true,
    platform: process.platform,
    capabilities: {
      stdio: true,
      streamableHttp: true,
      logosDataDirectoryAvailable: existsSync(LOGOS_DATA_DIR),
      logosCatalogDirectoryAvailable: existsSync(LOGOS_CATALOG_DIR),
      notes: databases.notes,
      highlights: databases.visualMarkup || databases.notes,
      clippings: databases.clippings,
      libraryCatalog: databases.catalog,
      sqliteReadable,
      bibliaApiConfigured: Boolean(BIBLIA_API_KEY),
      uiAutomationSupported: process.platform === "darwin" || process.platform === "win32",
      screenCaptureSupported: process.platform === "darwin",
    },
    warnings,
  };
}

export function registerProviderTools(server: McpServer): void {
  server.tool(
    "get_study_context",
    "Retrieve a bounded, provenance-preserving study context from Logos personal study data, library metadata, and optionally Biblia-backed Bible text. Provide a passage, a query, or both.",
    {
      passage: z.string().max(120).optional().describe("Canonical Bible reference or passage range"),
      query: z.string().max(300).optional().describe("Topic or terms to search in Logos study data"),
      include: z.array(z.enum(["notes", "highlights", "clippings", "bible", "library"])).max(5).optional()
        .describe("Sources to include; defaults to personal notes, highlights, and clippings"),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum combined study items (default 24)"),
      bible: z.string().max(30).optional().describe("Biblia translation code when bible is included"),
    },
    async ({ passage, query, include, limit, bible }) => {
      try {
        return jsonResult(await getStudyContext({ passage, query, include, limit, bible }));
      } catch (error) {
        return jsonError(error);
      }
    },
  );

  server.tool(
    "search_personal_studies",
    "Search Logos notes, highlights, and clippings with optional canonical passage scope. Results retain source IDs, resource identity, provenance, completeness, and warnings.",
    {
      query: z.string().min(1).max(300).describe("Words or phrase to search"),
      passage: z.string().max(120).optional().describe("Optionally scope results to a canonical Bible passage"),
      sources: z.array(z.enum(["notes", "highlights", "clippings"])).min(1).max(3).optional()
        .describe("Personal study sources to search; defaults to all three"),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum combined study items (default 24)"),
    },
    async ({ query, passage, sources, limit }) => {
      try {
        return jsonResult(await searchPersonalStudies({ query, passage, sources, limit }));
      } catch (error) {
        return jsonError(error);
      }
    },
  );

  server.tool(
    "health",
    "Report path-free provider capabilities and read-only data-source availability.",
    {},
    async () => jsonResult(getProviderHealthReport()),
  );
}
