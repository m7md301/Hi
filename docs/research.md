# Research record

## VERIFIED: Cloudflare
- Stateless MCP on Workers uses Streamable HTTP.
- Current docs show `createMcpHandler` from `agents/mcp/server` with `@modelcontextprotocol/server` and `zod` for new servers.
- Sources:
  - https://developers.cloudflare.com/agents/guides/remote-mcp-server
  - https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
  - https://github.com/cloudflare/agents/tree/main/examples/mcp-worker

## VERIFIED: xKiro
- Base URL: `https://api.xkiro.com`
- Authentication: `Authorization: Bearer <key>` or `x-api-key: <key>`.
- Image generation: `POST /v1/images/generations`.
- Image edits: `POST /v1/images/edits` (multipart).
- Retrieve job: `GET /v1/images/generations/{id}`.
- List jobs: `GET /v1/images/generations`.
- Image generation is asynchronous and returns a job to poll.
- Source: https://docs.xkiro.com/api/overview/

## UNVERIFIED
- The dedicated xKiro pages for image generation/edit/retrieve currently resolve to 404 from the documentation site, so exact image payload and response schemas could not be independently verified.
- This implementation therefore exposes documented endpoints and passes extra generation fields through `options`; it does not claim support for image edits until the multipart schema is available.
