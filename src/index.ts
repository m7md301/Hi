import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = { XKIRO_API_KEY?: string; MCP_ACCESS_TOKEN?: string; UPLOADS?: any };
const XKIRO_API = "https://api.xkiro.com";
const DEFAULT_MODEL = "sensenova/sensenova-u1.5-lite";
const SUPPORTED_MODELS = ["sensenova/sensenova-u1.5-lite", "openai/gpt-image-2.5"] as const;
const modelField = z.enum(SUPPORTED_MODELS).optional().describe("Model to use: sensenova/sensenova-u1.5-lite (default, fast) or openai/gpt-image-2.5 (higher quality)");

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
  const server = new McpServer({ name: "xkiro-mcp", version: "2.1.0" });
  server.registerTool("generate_image", { description: "Submit an asynchronous image-generation job to xKiro. Model selectable: sensenova/sensenova-u1.5-lite (default) or openai/gpt-image-2.5.", inputSchema: { prompt: z.string().min(1), model: modelField, n: z.number().optional(), size: z.string().optional(), style: z.string().optional() } }, async ({ prompt, model, n, size, style }) => ({ content: [{ type: "text", text: JSON.stringify(await xKiroJson(env, "/v1/images/generations", { method: "POST", body: JSON.stringify({ prompt, model: model ?? DEFAULT_MODEL, n, size, style }) })) }] }));
  server.registerTool("edit_image", { description: "Edit an existing image from an HTTPS image URL. Model selectable: sensenova/sensenova-u1.5-lite (default) or openai/gpt-image-2.5.", inputSchema: { image_url: z.string().url(), prompt: z.string().min(1), model: modelField, size: z.string().optional(), n: z.number().optional() } }, async args => ({ content: [{ type: "text", text: JSON.stringify(await editImage(env, args)) }] }));
  server.registerTool("get_image_job", { description: "Retrieve an xKiro image-generation job by id.", inputSchema: { id: z.string().min(1) } }, async ({ id }) => ({ content: [{ type: "text", text: JSON.stringify(await xKiroJson(env, `/v1/images/generations/${encodeURIComponent(id)}`)) }] }));
  server.registerTool("list_image_jobs", { description: "List recent xKiro image-generation jobs.", inputSchema: { before: z.string().optional() } }, async ({ before }) => ({ content: [{ type: "text", text: JSON.stringify(await xKiroJson(env, `/v1/images/generations${before ? `?before=${encodeURIComponent(before)}` : ""}`)) }] }));
  server.registerTool("get_upload_slot", { description: "Get same-domain upload slot for temporary image hosting. Use when user has local image without public URL.", inputSchema: { note: z.string().optional() } }, async () => ({ content: [{ type: "text", text: JSON.stringify({ upload_page: "/upload", uploads_base: "/uploads/", how_to_use: "Open https://<worker-host>/upload, upload with MCP token, then paste returned url into edit_image", mcp_ok: true }) }] }));
  return server;
}
// ---- isolated sidecar: same-domain upload, no effect on /mcp if missing/broken ----
function uploadFormHtml(): string {
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>upload</title><body style="font-family:system-ui;padding:24px;max-width:520px;margin:auto"><h3>upload temp</h3><p>Upload then paste https://.../uploads/... into edit_image.</p><form method="post" enctype="multipart/form-data"><input type="file" name="file" accept="image/jpeg,image/png,image/webp,image/gif" required><br><br><button type="submit">upload</button></form></body></html>`;
}
async function handleSidecar(request: Request, env: Env, url: URL): Promise<Response> {
  const pathname = url.pathname;
  if (pathname === "/upload" || pathname === "/upload/") {
    if (request.method === "GET") return new Response(uploadFormHtml(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, X-MCP-Password, MCP-Access-Token" } });
    if (request.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed, use POST" }), { status: 405, headers: { "Content-Type": "application/json" } });
    if (!authorized(request, env)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    if (!env.UPLOADS) return new Response(JSON.stringify({ error: "UPLOADS R2 not bound yet. /mcp still works. Create R2 bucket hi-uploads and bind UPLOADS to enable.", mcp_ok: true }), { status: 503, headers: { "Content-Type": "application/json" } });
    let form: FormData; try { form = await request.formData(); } catch { return new Response(JSON.stringify({ error: "Expected multipart/form-data with field file" }), { status: 400, headers: { "Content-Type": "application/json" } }); }
    const f = form.get("file") ?? form.get("image");
    if (!(f instanceof File)) return new Response(JSON.stringify({ error: "Missing file field named file" }), { status: 400, headers: { "Content-Type": "application/json" } });
    const ct = (f.type || "").split(";")[0].toLowerCase();
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(ct)) return new Response(JSON.stringify({ error: "Unsupported content-type, use jpeg/png/webp/gif" }), { status: 400, headers: { "Content-Type": "application/json" } });
    if (f.size <= 0 || f.size > 20 * 1024 * 1024) return new Response(JSON.stringify({ error: "File size must be 1B..20MB" }), { status: 400, headers: { "Content-Type": "application/json" } });
    const ext = ct === "image/jpeg" ? "jpg" : ct.split("/")[1];
    const now = new Date(); const ym = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const rand = Math.random().toString(16).slice(2, 10);
    const key = `${ym}/${Date.now()}-${rand}.${ext}`;
    await env.UPLOADS.put(key, f.stream(), { httpMetadata: { contentType: ct }, customMetadata: { uploadedAt: new Date().toISOString() } });
    const publicUrl = `https://${url.host}/uploads/${key}`;
    return new Response(JSON.stringify({ url: publicUrl, key, contentType: ct, size: f.size, usage: "Paste url into edit_image image_url" }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  if (pathname.startsWith("/uploads/")) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    if (!env.UPLOADS) return new Response("Uploads not enabled yet", { status: 503 });
    const key = pathname.slice("/uploads/".length);
    if (!key || key.includes("..") || key.length > 512) return new Response("Not found", { status: 404 });
    const obj = await env.UPLOADS.get(key);
    if (!obj) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    headers.set("Content-Type", obj.httpMetadata?.contentType ?? "application/octet-stream");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("Access-Control-Allow-Origin", "*");
    if (request.method === "HEAD") return new Response(null, { headers });
    return new Response(obj.body, { headers });
  }
  return new Response("Not found", { status: 404 });
}
export default { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/upload" || pathname === "/upload/" || pathname.startsWith("/uploads/")) {
    try { return handleSidecar(request, env, new URL(request.url)); } catch (e) { return Promise.resolve(new Response(JSON.stringify({ error: String((e as Error)?.message ?? e), mcp_ok: true }), { status: 500, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })); }
  }
  if (pathname === "/health") return Promise.resolve(new Response(JSON.stringify({ status: "ok", version: "2.1.0" }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }));
  if (pathname !== "/mcp" && pathname !== "/mcp/") return Promise.resolve(new Response("Not found", { status: 404 }));
  if (!env.MCP_ACCESS_TOKEN) return Promise.resolve(new Response(JSON.stringify({ error: "MCP_ACCESS_TOKEN is not configured" }), { status: 503, headers: { "Content-Type": "application/json" } }));
  if (request.method !== "OPTIONS" && !authorized(request, env)) return Promise.resolve(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" } }));
  return createMcpHandler(() => createServer(env))(request, env, ctx);
} } satisfies ExportedHandler<Env>;
