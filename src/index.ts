import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = {
  XKIRO_API_KEY?: string;
  MCP_ACCESS_TOKEN?: string;
};

const XKIRO_API = "https://api.xkiro.com";
const DEFAULT_MODEL = "sensenova/sensenova-u1.5-lite";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function isAuthorized(request: Request, env: Env): boolean {
  const expected = env.MCP_ACCESS_TOKEN?.trim();
  if (!expected) return false;

  const directValues = [
    request.headers.get("x-api-key"),
    request.headers.get("X-MCP-Password"),
    request.headers.get("MCP-Access-Token"),
  ];
  if (directValues.some((value) => value && constantTimeEqual(value.trim(), expected))) return true;

  const authorization = request.headers.get("Authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer && constantTimeEqual(bearer.trim(), expected)) return true;

  const basic = authorization.match(/^Basic\s+(.+)$/i)?.[1];
  if (basic) {
    try {
      const decoded = atob(basic);
      const password = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : decoded;
      if (constantTimeEqual(password.trim(), expected) || constantTimeEqual(decoded.trim(), expected)) return true;
    } catch {
      return false;
    }
  }

  return false;
}

async function xKiroJson(env: Env, path: string, init?: RequestInit): Promise<unknown> {
  if (!env.XKIRO_API_KEY) throw new Error("XKIRO_API_KEY is not configured");
  const response = await fetch(`${XKIRO_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.XKIRO_API_KEY}`,
      ...init?.headers,
    },
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok) throw new Error(`xKiro HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function editImage(env: Env, args: { image_url: string; prompt: string; model?: string; size?: string; n?: number }): Promise<unknown> {
  const source = await fetch(args.image_url);
  if (!source.ok) throw new Error(`Could not fetch source image: HTTP ${source.status}`);
  const contentType = source.headers.get("content-type")?.split(";")[0].toLowerCase() ?? "";
  if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(contentType)) {
    throw new Error("source URL did not return a supported image");
  }
  const extension = contentType === "image/jpeg" ? "jpg" : contentType.split("/")[1];
  const form = new FormData();
  form.append("image", new Blob([await source.arrayBuffer()], { type: contentType }), `source.${extension}`);
  form.append("prompt", args.prompt);
  form.append("model", args.model ?? DEFAULT_MODEL);
  if (args.size) form.append("size", args.size);
  if (args.n !== undefined) form.append("n", String(args.n));

  if (!env.XKIRO_API_KEY) throw new Error("XKIRO_API_KEY is not configured");
  const response = await fetch(`${XKIRO_API}/v1/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.XKIRO_API_KEY}`, Accept: "application/json" },
    body: form,
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok) throw new Error(`xKiro edit HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "xkiro-mcp", version: "2.0.0" });

  server.registerTool(
    "generate_image",
    {
      description: "Submit an asynchronous image-generation job to xKiro.",
      inputSchema: {
        prompt: z.string().min(1),
        model: z.string().optional(),
        n: z.number().optional(),
        size: z.string().optional(),
        style: z.string().optional(),
      },
    },
    async ({ prompt, model, n, size, style }) => {
      const data = await xKiroJson(env, "/v1/images/generations", {
        method: "POST",
        body: JSON.stringify({ prompt, model: model ?? DEFAULT_MODEL, n, size, style }),
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    },
  );

  server.registerTool(
    "edit_image",
    {
      description: "Edit an existing image from an HTTPS image URL.",
      inputSchema: {
        image_url: z.string().url(),
        prompt: z.string().min(1),
        model: z.string().optional(),
        size: z.string().optional(),
        n: z.number().optional(),
      },
    },
    async (args) => {
      const data = await editImage(env, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    },
  );

  server.registerTool(
    "get_image_job",
    {
      description: "Retrieve an xKiro image-generation job by id.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      const data = await xKiroJson(env, `/v1/images/generations/${encodeURIComponent(id)}`);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    },
  );

  server.registerTool(
    "list_image_jobs",
    {
      description: "List recent xKiro image-generation jobs.",
      inputSchema: { before: z.string().optional() },
    },
    async ({ before }) => {
      const query = before ? `?before=${encodeURIComponent(before)}` : "";
      const data = await xKiroJson(env, `/v1/images/generations${query}`);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    },
  );

  return server;
}

const mcpHandler = createMcpHandler((context) => {
  const env = (context.requestInfo as Request & { env?: Env })?.env;
  return createServer(env ?? {});
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Promise.resolve(new Response(JSON.stringify({ status: "ok", version: "2.0.0" }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      }));
    }
    if (url.pathname !== "/mcp" && url.pathname !== "/mcp/") {
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }
    if (request.method === "OPTIONS") return mcpHandler(request, env, ctx);
    if (!env.MCP_ACCESS_TOKEN) {
      return Promise.resolve(new Response(JSON.stringify({ error: "MCP_ACCESS_TOKEN is not configured" }), { status: 503, headers: { "Content-Type": "application/json" } }));
    }
    if (!isAuthorized(request, env)) {
      return Promise.resolve(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" } }));
    }
    return mcpHandler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
