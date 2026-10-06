type Env = { XKIRO_API_KEY?: string; MCP_ACCESS_TOKEN?: string };
const XKIRO_API = "https://api.xkiro.com";
type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const tools = [
  { name: "generate_image", description: "Submit an image-generation job to xKiro.", inputSchema: { type: "object", properties: { model: { type: "string" }, prompt: { type: "string" }, n: { type: "number" }, size: { type: "string" }, style: { type: "string" } }, required: ["model", "prompt"] } },
  { name: "edit_image", description: "Edit an existing image using an image URL and an instruction.", inputSchema: { type: "object", properties: { image_url: { type: "string" }, prompt: { type: "string" }, model: { type: "string" }, size: { type: "string" }, n: { type: "number" } }, required: ["image_url", "prompt", "model"] } },
  { name: "get_image_job", description: "Retrieve an xKiro image-generation job by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "list_image_jobs", description: "List recent xKiro image-generation jobs.", inputSchema: { type: "object", properties: { before: { type: "string" } } } }
];
function headers() { return { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Expose-Headers": "MCP-Protocol-Version, mcp-session-id", "MCP-Protocol-Version": "2025-03-26" }; }
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: headers() }); }
function error(id: JsonRpcRequest["id"], code: number, message: string) { return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }); }
function equal(a: string, b: string) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function authorized(request: Request, env: Env) {
  const expected = env.MCP_ACCESS_TOKEN; if (!expected) return false;
  const url = new URL(request.url); const values = [request.headers.get("x-api-key"), request.headers.get("X-MCP-Password"), request.headers.get("MCP-Access-Token"), url.searchParams.get("token"), url.searchParams.get("password"), url.searchParams.get("api_key"), url.searchParams.get("access_token"), url.searchParams.get("key")];
  if (values.some(v => !!v && equal(v.trim(), expected.trim()))) return true;
  const auth = request.headers.get("Authorization") ?? "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] ?? auth.match(/^Token\s+(.+)$/i)?.[1];
  if (bearer && equal(bearer.trim(), expected.trim())) return true;
  const basic = auth.match(/^Basic\s+(.+)$/i)?.[1];
  if (basic) { try { const decoded = atob(basic); const password = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : decoded; if (equal(password.trim(), expected.trim()) || equal(decoded.trim(), expected.trim())) return true; } catch {} }
  return false;
}
async function callXkiro(env: Env, path: string, init?: RequestInit): Promise<unknown> { if (!env.XKIRO_API_KEY) throw new Error("MCP is missing XKIRO_API_KEY"); const response = await fetch(`${XKIRO_API}${path}`, { ...init, headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${env.XKIRO_API_KEY}`, ...init?.headers } }); const text = await response.text(); let data: unknown; try { data = JSON.parse(text); } catch { data = { raw: text }; } if (!response.ok) throw new Error(`xKiro HTTP ${response.status}`); return data; }
async function editImage(env: Env, args: Record<string, unknown>) { const imageUrl = args.image_url, prompt = args.prompt, model = args.model; if (typeof imageUrl !== "string" || !/^https?:\/\//i.test(imageUrl)) throw new Error("image_url must be an http(s) URL"); if (typeof prompt !== "string" || !prompt) throw new Error("prompt is required"); if (typeof model !== "string" || !model) throw new Error("model is required"); const source = await fetch(imageUrl); if (!source.ok) throw new Error(`Could not fetch source image: HTTP ${source.status}`); const contentType = source.headers.get("content-type")?.split(";")[0].toLowerCase() ?? ""; if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(contentType)) throw new Error("source URL did not return a supported image"); const extension = contentType.split("/")[1] === "jpeg" ? "jpg" : contentType.split("/")[1]; const form = new FormData(); form.append("image", new Blob([await source.arrayBuffer()], { type: contentType }), `source.${extension}`); form.append("prompt", prompt); form.append("model", model); if (typeof args.size === "string") form.append("size", args.size); if (typeof args.n === "number") form.append("n", String(args.n)); const response = await fetch(`${XKIRO_API}/v1/images/edits`, { method: "POST", headers: { Authorization: `Bearer ${env.XKIRO_API_KEY}` }, body: form }); const text = await response.text(); let data: unknown; try { data = JSON.parse(text); } catch { data = { raw: text }; } if (!response.ok) throw new Error(`xKiro edit HTTP ${response.status}`); return data; }
function result(id: JsonRpcRequest["id"], value: unknown) { return json({ jsonrpc: "2.0", id: id ?? null, result: value }); }
async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers() });
  if (request.method === "GET") return new Response("MCP endpoint ready", { status: 200, headers: { ...headers(), "Content-Type": "text/plain" } });
  if (request.method !== "POST") return error(null, -32000, "MCP endpoint accepts POST requests.");
  if (!env.MCP_ACCESS_TOKEN) return json({ error: "MCP_ACCESS_TOKEN is not configured" }, 503);
  if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
  let rpc: JsonRpcRequest; try { rpc = await request.json() as JsonRpcRequest; } catch { return error(null, -32700, "Parse error"); }
  const id = rpc.id ?? null;
  try { switch (rpc.method) {
    case "initialize": return result(id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "xkiro-mcp", version: "1.4.0" } });
    case "notifications/initialized": return new Response(null, { status: 202, headers: headers() });
    case "ping": return result(id, {});
    case "tools/list": return result(id, { tools });
    case "tools/call": { const params = rpc.params ?? {}, name = params.name, args = (params.arguments ?? {}) as Record<string, unknown>; let data: unknown; if (name === "generate_image") { if (typeof args.model !== "string" || typeof args.prompt !== "string") return error(id, -32602, "model and prompt are required"); data = await callXkiro(env, "/v1/images/generations", { method: "POST", body: JSON.stringify(Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))) }); } else if (name === "edit_image") data = await editImage(env, args); else if (name === "get_image_job") { if (typeof args.id !== "string") return error(id, -32602, "id is required"); data = await callXkiro(env, `/v1/images/generations/${encodeURIComponent(args.id)}`); } else if (name === "list_image_jobs") { const before = typeof args.before === "string" ? `?before=${encodeURIComponent(args.before)}` : ""; data = await callXkiro(env, `/v1/images/generations${before}`); } else return error(id, -32602, `Unknown tool: ${String(name)}`); return result(id, { content: [{ type: "text", text: JSON.stringify(data) }] }); }
    default: return error(id, -32601, `Method not found: ${String(rpc.method)}`);
  } } catch (cause) { return result(id, { content: [{ type: "text", text: cause instanceof Error ? cause.message : "Tool error" }], isError: true }); }
}
export default { fetch(request: Request, env: Env) { const pathname = new URL(request.url).pathname.replace(/\/$/, "") || "/"; if (pathname === "/health") return new Response("ok"); if (pathname !== "/mcp") return new Response("xKiro MCP server"); return handleMcp(request, env); } } satisfies ExportedHandler<Env>;
