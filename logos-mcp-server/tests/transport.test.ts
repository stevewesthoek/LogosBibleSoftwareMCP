import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { request, type Server as HttpServer } from "node:http";
import { createMcpServer } from "../src/index.js";
import { startHttpTransport } from "../src/transports/start.js";
import { createRemoteReadOnlyMcpServer } from "../src/tools/remote-profile.js";
import { getProviderHealthReport, type ProviderToolHandlers } from "../src/tools/provider-tools.js";

const servers: HttpServer[] = [];

function withoutRetrievalTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutRetrievalTimes);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "retrievedAt")
      .map(([key, child]) => [key, withoutRetrievalTimes(child)]));
  }
  return value;
}

function getStatus(url: URL, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port: Number(url.port),
      path: url.pathname,
      method: "GET",
      headers,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end();
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("MCP transports", () => {
  it("starts the same provider through stdio and preserves all upstream tools", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/index.ts"],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "logos-provider-stdio-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toHaveLength(27);
      expect(names).toContain("get_study_context");
      expect(names).toContain("search_personal_studies");
      expect(names).toContain("health");
    } finally {
      await client.close();
    }
  });

  it("exposes exactly the read-only consumer allowlist over Streamable HTTP", async () => {
    const server = await startHttpTransport(createRemoteReadOnlyMcpServer, { port: 0 });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP server did not bind to a TCP port.");

    const client = new Client({ name: "logos-provider-remote-profile-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "get_study_context",
        "health",
        "search_personal_studies",
      ]);
      expect(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);

      const health = await client.callTool({ name: "health", arguments: {} });
      const serializedHealth = JSON.stringify(health);
      expect(health.structuredContent).toMatchObject({ provider: "logos-knowledge-provider", readOnly: true });
      expect(serializedHealth).not.toMatch(/\/Users\/|\/home\/|\/Library\/Application Support\/|BIBLIA_API_KEY|LOGOS_DATA_DIR/);

      const result = await client.callTool({
        name: "search_personal_studies",
        arguments: { query: "codex-remote-profile-test-sentinel-9a6c2c" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toHaveProperty("completeness");
      expect(result.structuredContent).toHaveProperty("warnings");
      expect(JSON.stringify(result)).not.toMatch(/\/Users\/|\/home\/|\/Library\/Application Support\/|BIBLIA_API_KEY|LOGOS_DATA_DIR/);

      const stdio = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "src/index.ts"],
        cwd: process.cwd(),
        env: { ...process.env, LOGOS_MCP_PROFILE: "remote-read-only" },
        stderr: "pipe",
      });
      const stdioClient = new Client({ name: "logos-provider-equivalence-test", version: "1.0.0" });
      try {
        await stdioClient.connect(stdio);
        const stdioResult = await stdioClient.callTool({
          name: "search_personal_studies",
          arguments: { query: "codex-remote-profile-test-sentinel-9a6c2c" },
        });
        expect(withoutRetrievalTimes(stdioResult.structuredContent)).toEqual(withoutRetrievalTimes(result.structuredContent));
      } finally {
        await stdioClient.close();
      }
    } finally {
      await client.close();
    }
  });

  it("preserves partial and unknown completeness warnings in remote responses", async () => {
    const handlers: ProviderToolHandlers = {
      getStudyContext: async (input) => ({
        query: input.query,
        items: [],
        completeness: "unknown",
        warnings: [{ code: "fixture_context_unknown", source: "note" }],
      }),
      searchPersonalStudies: async (input) => ({
        query: input.query,
        items: [],
        completeness: input.query.includes("unknown") ? "unknown" : "partial",
        warnings: [{ code: input.query.includes("unknown") ? "fixture_unknown" : "fixture_partial", source: "note" }],
      }),
      getHealthReport: getProviderHealthReport,
    };
    const server = await startHttpTransport(() => createRemoteReadOnlyMcpServer(handlers), { port: 0 });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP server did not bind to a TCP port.");

    const client = new Client({ name: "logos-provider-completeness-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      for (const [query, completeness, code] of [
        ["fixture partial", "partial", "fixture_partial"],
        ["fixture unknown", "unknown", "fixture_unknown"],
      ] as const) {
        const response = await client.callTool({ name: "search_personal_studies", arguments: { query } });
        expect(response.structuredContent).toEqual({
          query,
          items: [],
          completeness,
          warnings: [{ code, source: "note" }],
        });
      }
    } finally {
      await client.close();
    }
  });

  it("selects the restricted profile for stdio without changing the default full profile", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/index.ts"],
      cwd: process.cwd(),
      env: { ...process.env, LOGOS_MCP_PROFILE: "remote-read-only" },
      stderr: "pipe",
    });
    const client = new Client({ name: "logos-provider-remote-stdio-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "get_study_context",
        "health",
        "search_personal_studies",
      ]);
    } finally {
      await client.close();
    }
  });

  it("serves all upstream tools and provider tools through stateless Streamable HTTP", async () => {
    const server = await startHttpTransport(createMcpServer, { port: 0 });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP server did not bind to a TCP port.");

    const client = new Client({ name: "logos-provider-transport-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);

      expect(names).toHaveLength(27);
      expect(names).toContain("get_user_notes");
      expect(names).toContain("get_user_highlights");
      expect(names).toContain("get_clippings");
      expect(names).toContain("get_study_context");
      expect(names).toContain("search_personal_studies");
      expect(names).toContain("health");

      const health = await client.callTool({ name: "health", arguments: {} });
      expect(health.structuredContent).toMatchObject({ provider: "logos-knowledge-provider", readOnly: true });
      expect(JSON.stringify(health)).not.toContain("/Users/");
      const diagnostic = await client.callTool({ name: "diagnose", arguments: {} });
      expect(JSON.stringify(diagnostic)).not.toContain("/Users/");
      expect(JSON.stringify(diagnostic)).not.toContain("/Library/Application Support/");
    } finally {
      await client.close();
    }
  });

  it("refuses to bind the HTTP MCP server outside loopback", async () => {
    await expect(startHttpTransport(createMcpServer, { host: "0.0.0.0", port: 3123 }))
      .rejects.toThrow("must bind to a loopback address");
  });

  it("rejects forged Host and non-loopback Origin headers", async () => {
    const server = await startHttpTransport(createMcpServer, { port: 0 });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP server did not bind to a TCP port.");
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);

    expect(await getStatus(endpoint, { host: "attacker.example" })).toBe(403);
    expect(await getStatus(endpoint, { host: `127.0.0.1:${address.port}`, origin: "https://attacker.example" })).toBe(403);
  });
});
