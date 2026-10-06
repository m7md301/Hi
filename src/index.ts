import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = { XKIRO_API_KEY?: string };
const XKIRO_API = "https://api.xkiro.com";

async function callXkiro(env: Env, path: string, init?: RequestInit): Promise<unknown> {
  const apiKey = env.XKIRO_API_KEY;
  if (!apiKey) throw new Error("Missing XKIRO_API_KEY secret");

  const response = await fetch(`${XKIRO_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...init?.headers
    }
  });
  const text = await response.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`xKiro returned HTTP ${response.status}`);
  return data;
}

function createServer(env: Env) {
  const server = new McpServer({ name: "xkiro-mcp", version: "1.0.0" });

  server.registerTool(
    "generate_image",
    {
      description: "Submit an image-generation job to xKiro.",
      inputSchema: { model: z.string(), prompt: z.string() }
    },
    async ({ model, prompt }) => ({
      content: [{
        type: "text",
        text: JSON.stringify(await callXkiro(env, "/v1/images/generations", {
          method: "POST",
          body: JSON.stringify({ model, prompt })
        }))
      }]
    })
  );

  server.registerTool(
    "get_image_job",
    {
      description: "Retrieve an xKiro image-generation job by id.",
      inputSchema: { id: z.string() }
    },
    async ({ id }) => ({
      content: [{
        type: "text",
        text: JSON.stringify(await callXkiro(env, `/v1/images/generations/${encodeURIComponent(id)}`))
      }]
    })
  );

  server.registerTool(
    "list_image_jobs",
    {
      description: "List recent xKiro image-generation jobs.",
      inputSchema: { cursor: z.string().optional() }
    },
    async ({ cursor }) => ({
      content: [{
        type: "text",
        text: JSON.stringify(await callXkiro(env, `/v1/images/generations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`))
      }]
    })
  );

  return server;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/health") return new Response("ok");
    if (pathname !== "/mcp") return new Response("xKiro MCP server");

    // The factory is deliberate: Agents SDK v2 requires a function returning McpServer.
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
