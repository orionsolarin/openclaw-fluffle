# Plan: Image Support in Fluffle Plugin

## What
Fix image/file sharing in both directions:
1. **Inbound** (user sends image in Fluffle → OpenClaw agent can see it)
2. **Outbound** (agent sends image → appears in Fluffle chat as an image)

## Why
When someone shares an image in a Fluffle group chat, the plugin passes a `MediaUrl` pointing to `/api/files/{id}` — but OpenClaw fetches it WITHOUT the API key, so it gets a 401. The agent sees a broken/missing image.

For outbound, `send.ts` only supports text, so agents can never send images back.

## How

### Fix 1: Inbound — fetch file data in plugin, pass as data URL
In `src/monitor.ts`, when `message.fileId` is present:
- Fetch `${account.config.baseUrl}/api/files/${fileId}` with `Authorization: Bearer ${apiKey}` header
- Get the raw bytes + Content-Type from response
- Convert to base64 data URL: `data:${mimeType};base64,${base64}`
- Pass this as `MediaUrl` instead of the API URL (so OpenClaw gets actual bytes)
- Also pass `MediaType` = the mime type

### Fix 2: Outbound — add uploadFile to FluffleApi + use in send.ts
In `src/api.ts`:
- Add `uploadFile(groupId: string, buffer: Buffer, filename: string, mimeType: string): Promise<{ fileId: string }>` 
- POST to `/api/groups/${groupId}/files` as multipart/form-data
- Returns the file ID

In `src/send.ts`:
- Add `sendMessageFluffle(target, text, mediaUrl?, mediaType?)` signature
- If mediaUrl is a `data:` URL, decode it, upload it via `uploadFile`, then send message with `file_id` 
- If mediaUrl is a regular URL, fetch it first then upload

In `src/channel.ts`:
- Update the `send` handler to pass `media` fields: `send: async ({ target, text, mediaUrl, mediaType })`

## Files to Change
- `src/monitor.ts` — fetch file data inbound, pass data URL
- `src/api.ts` — add `uploadFile` method
- `src/send.ts` — handle mediaUrl, upload files outbound
- `src/channel.ts` — pass mediaUrl/mediaType in send handler

## Definition of Done
- User shares image in Fluffle → agent receives it and can see/analyze it (data URL in MediaUrl)
- Agent sends a message with an image → file is uploaded to Fluffle and appears as image in chat
- No auth errors (401) when fetching file content
- Existing text message flow unaffected
