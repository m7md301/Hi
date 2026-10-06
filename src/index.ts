import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = { XKIRO_API_KEY?: string };
const API = "https://api.xkiro.com";

async function xkiro(path: string, env: Env, init?: RequestInit): Promise<unknown> {
  if (!env.XKIRO_API_KEY) throw new Error("Missing XKIRO_API_KEY secret");
  const response = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.XKIRO_API_KEY}`,
      "Content-Type": "application/json",
      ...(init && init.headers ? init.headers : {})
    }
  });
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`xKiro HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function createServer(env: Env) {
  const server = new McpServer({ name: "xkiro-mcp", version: "1.0.0" });
  server.registerTool("generate_image", {
    description: "Submit an image-generation job to xKiro.",
    inputSchema: { model: z.string(), prompt: z.string() }
  }, async ({ model, prompt }) => {
    const result = await xkiro("/v1/images/generations", env, {
      method: "POST",
      body: JSON.stringify({ model, prompt })
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  server.registerTool("get_image_job", {
    description: "Retrieve an xKiro image-generation job by id.",
    inputSchema: { id: z.string() }
  }, async ({ id }) => ({
    content: [{ type: "text", text: JSON.stringify(await xkiro(`/v1/images/generations/${encodeURIComponent(id)}`, env)) }]
  }));
  server.registerTool("list_image_jobs", {
    description: "List recent xKiro image-generation jobs.",
    inputSchema: { cursor: z.string().optional() }
  }, async ({ cursor }) => ({
    content: [{ type: "text", text: JSON.stringify(await xkiro(`/v1/images/generations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, env)) }]
  }));
  return server;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname !== "/mcp") return new Response("xKiro MCP server", { status: 200 });
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  }
};
