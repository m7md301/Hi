import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = { XKIRO_API_KEY?: string; MCP_ACCESS_TOKEN?: string };
const XKIRO_API = "https://api.xkiro.com";
const DEFAULT_MODEL = "sensenova/sensenova-u1.5-lite";

function equal(a: string, b: string) { if (a.length !== b.length) return false; let difference = 0; for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i); return difference === 0; }
function authorized(request: Request, env: Env) {
  const expected = env.MCP_ACCESS_TOKEN?.trim(); if (!expected) return false;
  const direct = [request.headers.get("x-api-key"), request.headers.get("X-MCP-Password"), request.headers.get("MCP-Access-Token")];
  if (direct.some(value => !!value && equal(value.trim(), expected))) return true;
  const auth = request.headers.get("Authorization") ?? "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]; if (bearer && equal(bearer.trim(), expected)) return true;
  const basic = auth.match(/^Basic\s+(.+)$/i)?.[1];
  if (basic) { try { const decoded = atob(basic); const password = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : decoded; return equal(password.trim(), expected) || equal(decoded.trim(), expected); } catch { return false; } }
  return false;
}
async function xKiroJson(env: Env, path: string, init?: RequestInit): Promise<unknown> {
  if (!env.XKIRO_API_KEY) throw new Error("XKIRO_API_KEY is not configured");
  const response = await fetch(`${XKIRO_API}${path}`, { ...init, headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${env.XKIRO_API_KEY}`, ...init?.headers } });
  const text = await response.text(); let data: unknown; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`xKiro HTTP ${response.status}: ${JSON.stringify(data)}`); return data;
}
async function editImage(env: Env, args: { image_url: string; prompt: string; model?: string; size?: string; n?: number }): Promise<unknown> {
  const source = await fetch(args.image_url); if (!source.ok) throw new Error(`Could not fetch source image: HTTP ${source.status}`);
  const contentType = source.headers.get("content-type")?.split(";")[0].toLowerCase() ?? ""; if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(contentType)) throw new Error("source URL did not return a supported image");
  const extension = contentType === "image/jpeg" ? "jpg" : contentType.split("/")[1]; const form = new FormData();
  form.append("image", new Blob([await source.arrayBuffer()], { type: contentType }), `source.${extension}`); form.append("prompt", args.prompt); form.append("model", args.model ?? DEFAULT_MODEL); if (args.size) form.append("size", args.size); if (args.n !== undefined) form.append("n", String(args.n));
  if (!env.XKIRO_API_KEY) throw new Error("XKIRO_API_KEY is not configured"); const response = await fetch(`${XKIRO_API}/v1/images/edits`, { method: "POST", headers: { Authorization: `Bearer ${env.XKIRO_API_KEY}`, Accept: "application/json" }, body: form });
  const text = await response.text(); let data: unknown; try { data = JSON.parse(text); } catch { data = { raw: text }; } if (!response.ok) throw new Error(`xKiro edit HTTP ${response.status}: ${JSON.stringify(data)}`); return data;
}
function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "xkiro-mcp", version: "2.0.1" });
  server.registerTool("generate_image", { description: "Submit an asynchronous image-generation job to xKiro.", inputSchema: { prompt: z.string().min(1), model: z.string().optional(), n: z.number().optional(), size: z.string().optional(), style: z.string().optional() } }, async ({ prompt, model, n, size, style }) => ({ content: [{ type: "text", text: JSON.stringify(await xKiroJson(env, "/v1/images/generations", { method: "POST", body: JSON.stringify({ prompt, model: model ?? DEFAULT_MODEL, n, size, style }) })) }] }));
  server.registerTool("edit_image", { description: "Edit an existing image from an HTTPS image URL.", inputSchema: { image_url: z.string().url(), prompt: z.string().min(1), model: z.string().optional(), size: z.string().optional(), n: z.number().optional() } }, async args => ({ content: [{ type: "text", text: JSON.stringify(await editImage(env, args)) }] }));
  server.registerTool("get_image_job", { description: "Retrieve an xKiro image-generation job by id.", inputSchema: { id: z.string().min(1) } }, async ({ id }) => ({ content: [{ type: "text", text: JSON.stringify(await xKiroJson(env, `/v1/images/generations/${encodeURIComponent(id)}`)) }] }));
  server.registerTool("list_image_jobs", { description: "List recent xKiro image-generation jobs.", inputSchema: { before: z.string().optional() } }, async ({ before }) => ({ content: [{ type: "text", text: JSON.stringify(await xKiroJson(env, `/v1/images/generations${before ? `?before=${encodeURIComponent(before)}` : ""}`)) }] }));
  return server;
}
export default { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const pathname = new URL(request.url).pathname; if (pathname === "/health") return Promise.resolve(new Response(JSON.stringify({ status: "ok", version: "2.0.1" }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }));
  if (pathname !== "/mcp" && pathname !== "/mcp/") return Promise.resolve(new Response("Not found", { status: 404 }));
  if (!env.MCP_ACCESS_TOKEN) return Promise.resolve(new Response(JSON.stringify({ error: "MCP_ACCESS_TOKEN is not configured" }), { status: 503, headers: { "Content-Type": "application/json" } }));
  if (request.method !== "OPTIONS" && !authorized(request, env)) return Promise.resolve(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" } }));
  return createMcpHandler(() => createServer(env))(request, env, ctx);
} } satisfies ExportedHandler<Env>;
