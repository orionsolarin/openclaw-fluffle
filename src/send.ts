import type { ResolvedFluffleAccount } from "./types.js";
import { FluffleApi } from "./api.js";

export type FluffleSendResult = {
  ok: boolean;
  error?: string;
};

let _cachedApi: FluffleApi | null = null;
let _cachedAccountId: string | null = null;

export function initFluffleSendApi(account: ResolvedFluffleAccount): void {
  _cachedApi = new FluffleApi(account);
  _cachedAccountId = account.accountId;
}

export async function sendMessageFluffle(
  target: string,
  text: string,
  mediaUrl?: string,
  mediaType?: string,
): Promise<FluffleSendResult> {
  if (!target?.trim()) {
    return { ok: false, error: "No target (groupId) provided" };
  }
  if (!text?.trim() && !mediaUrl) {
    return { ok: false, error: "No text or media provided" };
  }
  if (!_cachedApi) {
    return { ok: false, error: "Fluffle API not initialized — account not started" };
  }

  const groupId = target.trim();

  try {
    if (mediaUrl) {
      let buffer: Buffer;
      let mimeType: string;
      let filename: string;

      if (mediaUrl.startsWith("data:")) {
        const match = mediaUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) {
          return { ok: false, error: "Invalid data URL format" };
        }
        mimeType = match[1];
        buffer = Buffer.from(match[2], "base64");
      } else {
        const resp = await fetch(mediaUrl);
        if (!resp.ok) {
          return { ok: false, error: `Failed to fetch media URL: ${resp.status}` };
        }
        mimeType = resp.headers.get("content-type") || mediaType || "application/octet-stream";
        buffer = Buffer.from(await resp.arrayBuffer());
      }

      mimeType = mediaType || mimeType;
      const ext = mimeType.split("/")[1]?.split(";")[0] ?? "bin";
      filename = `upload.${ext}`;

      const { fileId } = await _cachedApi.uploadFile(groupId, buffer, filename, mimeType);
      await _cachedApi.sendMessage(groupId, text || "", fileId);
    } else {
      await _cachedApi.sendMessage(groupId, text);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
