import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { request, type Server as HttpServer } from "node:http";
import { createMcpServer } from "../src/index.js";
import { startHttpTransport } from "../src/transports/start.js";

const servers: HttpServer[] = [];

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
