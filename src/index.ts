type Env = { XKIRO_API_KEY?: string };
const XKIRO_API = "https://api.xkiro.com";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const tools = [
  {
    name: "generate_image",
    description: "Submit an image-generation job to xKiro.",
    inputSchema: {
      type: "object",
      properties: { model: { type: "string" }, prompt: { type: "string" } },
      required: ["model", "prompt"]
    }
  },
  {
    name: "get_image_job",
    description: "Retrieve an xKiro image-generation job by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    }
  },
  {
    name: "list_image_jobs",
    description: "List recent xKiro image-generation jobs.",
    inputSchema: {
      type: "object",
      properties: { cursor: { type: "string" } }
    }
  }
];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, mcp-session-id",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Expose-Headers": "MCP-Protocol-Version, mcp-session-id"
    }
  });
}

async function callXkiro(env: Env, path: string, init?: RequestInit): Promise<unknown> {
  if (!env.XKIRO_API_KEY) throw new Error("Missing XKIRO_API_KEY secret");
  const response = await fetch(`${XKIRO_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.XKIRO_API_KEY}`,
      ...init?.headers
    }
  });
  const text = await response.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`xKiro HTTP ${response.status}`);
  return data;
}

function result(id: JsonRpcRequest["id"], value: unknown) {
  return json({ jsonrpc: "2.0", id: id ?? null, result: value });
}

function error(id: JsonRpcRequest["id"], code: number, message: string) {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return json(null, 204);
  if (request.method !== "POST") return error(null, -32000, "Method not allowed.");

  let rpc: JsonRpcRequest;
  try { rpc = await request.json() as JsonRpcRequest; }
  catch { return error(null, -32700, "Parse error"); }

  const id = rpc.id ?? null;
  try {
    switch (rpc.method) {
      case "initialize":
        return result(id, {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "xkiro-mcp", version: "1.0.0" }
        });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "ping":
        return result(id, {});
      case "tools/list":
        return result(id, { tools });
      case "tools/call": {
        const params = rpc.params ?? {};
        const name = params.name;
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        let data: unknown;
        if (name === "generate_image") {
          if (typeof args.model !== "string" || typeof args.prompt !== "string") return error(id, -32602, "model and prompt are required");
          data = await callXkiro(env, "/v1/images/generations", { method: "POST", body: JSON.stringify({ model: args.model, prompt: args.prompt }) });
        } else if (name === "get_image_job") {
          if (typeof args.id !== "string") return error(id, -32602, "id is required");
          data = await callXkiro(env, `/v1/images/generations/${encodeURIComponent(args.id)}`);
        } else if (name === "list_image_jobs") {
          const cursor = typeof args.cursor === "string" ? `?cursor=${encodeURIComponent(args.cursor)}` : "";
          data = await callXkiro(env, `/v1/images/generations${cursor}`);
        } else return error(id, -32602, `Unknown tool: ${String(name)}`);
        return result(id, { content: [{ type: "text", text: JSON.stringify(data) }] });
      }
      default:
        return error(id, -32601, `Method not found: ${String(rpc.method)}`);
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Internal server error";
    return result(id, { content: [{ type: "text", text: message }], isError: true });
  }
}

export default {
  fetch(request: Request, env: Env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/health") return new Response("ok");
    if (pathname !== "/mcp") return new Response("xKiro MCP server");
    return handleMcp(request, env);
  }
} satisfies ExportedHandler<Env>;
