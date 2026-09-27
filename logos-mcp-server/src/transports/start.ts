import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { isIP } from "node:net";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type McpServerFactory = () => McpServer;

function isAllowedLoopbackAuthority(authority: string | undefined, port: number, allowedHosts: Set<string>): boolean {
  if (!authority) return false;
  try {
    const parsed = new URL(`http://${authority}`);
    const effectivePort = parsed.port || "80";
    return !parsed.username && !parsed.password && allowedHosts.has(parsed.hostname.toLowerCase()) && effectivePort === String(port) && parsed.pathname === "/";
  } catch {
    return false;
  }
}

export async function startHttpTransport(
  createMcpServer: McpServerFactory,
  options: { host?: string; port?: number; path?: string } = {},
): Promise<HttpServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3123;
  const path = options.path ?? "/mcp";
  const loopback = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  if (!loopback) throw new Error("Streamable HTTP must bind to a loopback address; use an approved tunnel for remote access.");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("HTTP port must be between 0 and 65535.");
  if (!path.startsWith("/") || path.includes("?")) throw new Error("HTTP MCP path must be an absolute URL path.");
  const allowedHosts = new Set([host.toLowerCase(), "localhost", "127.0.0.1", "[::1]"]);

  const httpServer = createHttpServer(async (request, response) => {
    if (request.url?.split("?", 1)[0] !== path) {
      response.writeHead(404).end();
      return;
    }
    const address = httpServer.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    if (!isAllowedLoopbackAuthority(request.headers.host, actualPort, allowedHosts)) {
      response.writeHead(403).end();
      return;
    }
    const origin = request.headers.origin;
    if (origin) {
      let originAuthority: string | undefined;
      try {
        const parsedOrigin = new URL(origin);
        if (parsedOrigin.protocol !== "http:") throw new Error("Unsupported origin scheme");
        originAuthority = parsedOrigin.host;
      } catch {
        response.writeHead(403).end();
        return;
      }
      if (!isAllowedLoopbackAuthority(originAuthority, actualPort, allowedHosts)) {
        response.writeHead(403).end();
        return;
      }
    }
    if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
      response.writeHead(405, { Allow: "GET, POST, DELETE" }).end();
      return;
    }

    const mcpServer = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let closed = false;
    const closeRequest = () => {
      if (closed) return;
      closed = true;
      void transport.close();
      void mcpServer.close();
    };
    response.once("close", closeRequest);

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      closeRequest();
      if (!response.headersSent) response.writeHead(500).end("MCP request failed");
      else response.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  return httpServer;
}

export async function startConfiguredTransport(createMcpServer: McpServerFactory): Promise<void> {
  const mode = process.env.LOGOS_MCP_TRANSPORT ?? "stdio";
  if (mode === "stdio") {
    await createMcpServer().connect(new StdioServerTransport());
    return;
  }
  if (mode === "http") {
    const portValue = Number(process.env.LOGOS_MCP_HTTP_PORT ?? 3123);
    const httpServer = await startHttpTransport(createMcpServer, {
      host: process.env.LOGOS_MCP_HTTP_HOST ?? "127.0.0.1",
      port: portValue,
      path: process.env.LOGOS_MCP_HTTP_PATH ?? "/mcp",
    });
    const address = httpServer.address();
    const actualPort = typeof address === "object" && address ? address.port : portValue;
    console.error(`Logos MCP Streamable HTTP listening at http://${process.env.LOGOS_MCP_HTTP_HOST ?? "127.0.0.1"}:${actualPort}${process.env.LOGOS_MCP_HTTP_PATH ?? "/mcp"}`);
    return;
  }
  throw new Error("LOGOS_MCP_TRANSPORT must be 'stdio' or 'http'.");
}
