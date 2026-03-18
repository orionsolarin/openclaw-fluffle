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
): Promise<FluffleSendResult> {
  if (!target?.trim()) {
    return { ok: false, error: "No target (groupId) provided" };
  }
  if (!text?.trim()) {
    return { ok: false, error: "No text provided" };
  }
  if (!_cachedApi) {
    return { ok: false, error: "Fluffle API not initialized — account not started" };
  }

  try {
    await _cachedApi.sendMessage(target.trim(), text);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
