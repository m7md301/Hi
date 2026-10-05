# xKiro MCP Worker

Stateless Streamable HTTP MCP server for Cloudflare Workers.

## Secret

Add a Cloudflare Worker Secret named `XKIRO_API_KEY`. Never commit the key.

## MCP endpoint

`/mcp`

## Tools

- `generate_image`
- `get_image_job`
- `list_image_jobs`

## Sources

- Cloudflare Remote MCP: https://developers.cloudflare.com/agents/guides/remote-mcp-server
- Cloudflare handler API: https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
- xKiro API overview: https://docs.xkiro.com/api/overview/

The xKiro documentation confirms the image endpoints and asynchronous job model. The exact image payload fields beyond `model` and `prompt` are intentionally passed through `options` until the provider publishes an accessible schema page.
