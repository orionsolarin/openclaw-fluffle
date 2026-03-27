import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  OpenClawConfig,
  OutboundReplyPayload,
  RuntimeEnv,
} from "openclaw/plugin-sdk";
import {
  createScopedPairingAccess,
  createReplyPrefixOptions,
  resolveOutboundMediaUrls,
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveSenderCommandAuthorization,
  sendMediaWithLeadingCaption,
} from "openclaw/plugin-sdk";
import { getFluffleRuntime } from "./runtime.js";
import { FluffleApi } from "./api.js";
import { sendMessageFluffle, initFluffleSendApi } from "./send.js";
import type {
  ResolvedFluffleAccount,
  WebhookPayload,
  FluffleInboundMessage,
} from "./types.js";

const TEXT_LIMIT = 4096;
const MAX_TIMESTAMP_AGE_SECONDS = 300;

// Per-team playbook cache (module-level, persists across messages)
const playbookCache = new Map<string, { version: number; content: string }>();

// Global deduplication for processMessage — prevents double-processing from
// both agent-channel and group-channel delivering the same message
const processedMessageIds = new Set<string>();
const MAX_PROCESSED_IDS = 1000;

function markMessageProcessed(id: string): boolean {
  if (!id) return false; // no id = can't dedup, allow through
  if (processedMessageIds.has(id)) return true; // already processed
  processedMessageIds.add(id);
  // Trim oldest entries when too large
  if (processedMessageIds.size > MAX_PROCESSED_IDS) {
    const iter = processedMessageIds.values();
    for (let i = 0; i < 200; i++) iter.next();
    // Keep only the newest entries
    const arr = Array.from(processedMessageIds);
    processedMessageIds.clear();
    for (const v of arr.slice(-MAX_PROCESSED_IDS + 200)) processedMessageIds.add(v);
  }
  return false; // first time seeing this message
}

// Cache sender info from streaming message:new events (empty content)
// so we can match them when stream:end arrives with the final content
const streamingSenderCache = new Map<string, { senderId: string; senderName: string; senderType: string; teamId: string; groupId: string; createdAt: string }>();
const MAX_STREAMING_CACHE = 200;

// Per-team context cache (channel digest + project state)
const contextCache = new Map<string, { fetchedAt: number; digest: string }>();
const CONTEXT_CACHE_TTL_MS = 300_000; // 5min

// Group/team name cache (populated from getGroups on startup + refreshes)
const groupNameCache = new Map<string, { title: string; teamId: string; teamName: string }>();

export type FluffleMonitorOptions = {
  account: ResolvedFluffleAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type FluffleMonitorResult = {
  stop: () => void;
};

// ─── Signature verification ─────────────────────────────────────────────────

function verifyWebhookSignature(
  payload: string,
  signature: string,
  timestamp: string,
  secret: string,
): boolean {
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_TIMESTAMP_AGE_SECONDS) return false;

  const signedContent = `${timestamp}.${payload}`;
  const expected = createHmac("sha256", secret).update(signedContent).digest("hex");

  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

// ─── Cycle message detection ────────────────────────────────────────────────

export function detectCycleMessage(content: string): { type: "plan" | "tldr" | null; cycleNumber?: number } {
  if (!content) return { type: null };
  const cycleMatch = content.match(/\[Cycle #(\d+)/);
  const cycleNumber = cycleMatch ? parseInt(cycleMatch[1], 10) : undefined;
  if (content.startsWith("[Cycle #") && content.includes("Plan]")) {
    return { type: "plan", cycleNumber };
  }
  if (content.includes("[Cycle #") && content.includes("TLDR]")) {
    return { type: "tldr", cycleNumber };
  }
  return { type: null };
}

// ─── Allow-from helpers ─────────────────────────────────────────────────────

function isSenderAllowed(senderId: string, allowFrom: Array<string | number>): boolean {
  const entries = allowFrom.map((e) => String(e));
  if (entries.includes("*")) return true;
  return entries.some((entry) => {
    const normalized = entry.replace(/^fluffle:/i, "");
    return normalized === senderId;
  });
}

function isGroupAllowed(params: {
  groupId: string;
  groups: Record<string, { allow?: boolean; enabled?: boolean }>;
}): boolean {
  const { groups, groupId } = params;
  const keys = Object.keys(groups);
  if (keys.length === 0) return false;

  const entry = groups[groupId];
  if (entry) return entry.allow !== false && entry.enabled !== false;
  const wildcard = groups["*"];
  if (wildcard) return wildcard.allow !== false && wildcard.enabled !== false;
  return false;
}

// ─── Parse webhook payload into normalized message ──────────────────────────

function parseWebhookPayload(payload: WebhookPayload): FluffleInboundMessage {
  return {
    id: payload.message.id,
    groupId: payload.group_id,
    teamId: payload.team_id,
    senderId: payload.message.sender.id ?? "",
    senderName: payload.message.sender.name ?? "",
    senderType: payload.message.sender.type,
    content: payload.message.content,
    messageType: payload.message.message_type,
    createdAt: payload.message.created_at,
    replyTo: payload.message.reply_to
      ? {
          id: payload.message.reply_to.id,
          content: payload.message.reply_to.content,
          senderName: payload.message.reply_to.sender_name,
        }
      : null,
    fileId: payload.message.file_id ?? null,
    fileName: payload.message.file_name ?? null,
    fileMimeType: payload.message.file_mime_type ?? null,
    playbook: payload.playbook,
    targetAgentIds: payload.target_agent_ids,
    targetAgentNames: payload.target_agent_names,
    recipientAgent: payload.recipient_agent
      ? { id: payload.recipient_agent.id, name: payload.recipient_agent.name, role: payload.recipient_agent.role }
      : undefined,
    teammates: payload.teammates,
  };
}

// ─── Process inbound message (shared by webhook + pusher) ───────────────────

async function processMessage(
  message: FluffleInboundMessage,
  account: ResolvedFluffleAccount,
  config: OpenClawConfig,
  core: ReturnType<typeof getFluffleRuntime>,
  runtime: RuntimeEnv,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
): Promise<void> {
  // Deduplication — same message may arrive via both agent-channel and group-channel
  if (markMessageProcessed(message.id)) {
    runtime.log?.(`[fluffle] processMessage: dedup skip id=${message.id}`);
    return;
  }

  // Skip messages from our own agent
  if (message.senderType === "agent" && message.senderId === account.config.agentId) return;

  // Skip activity messages (e.g. "X shared a file", "X joined") — these are system echoes
  if (message.messageType === "activity") {
    runtime.log?.(`[fluffle] processMessage: skipping activity message: "${message.content?.slice(0, 50)}"`);
    return;
  }

  // ── Cycle message detection ────────────────────────────────────────────────
  // Intercept cycle-marker messages from other agents before normal processing.
  if (message.senderType === "agent" && message.content?.trim()) {
    const cycleEvent = detectCycleMessage(message.content.trim());
    if (cycleEvent.type === "plan") {
      runtime.log?.(`[fluffle] Cycle plan detected (cycle #${cycleEvent.cycleNumber}) from ${message.senderName} — triggering Agent 2`);
      (core.channel as any).injectSystemEvent?.(message.content.trim());
      return;
    }
    if (cycleEvent.type === "tldr") {
      runtime.log?.(`[fluffle] Cycle TLDR detected (cycle #${cycleEvent.cycleNumber}) from ${message.senderName} — closing cycle`);
      const cycleApi = new FluffleApi(account);
      cycleApi.closeCycle(message.teamId, message.content.trim(), cycleEvent.cycleNumber).catch((err) => {
        runtime.error?.(`[fluffle] Failed to close cycle via API: ${String(err)}`);
      });
      return;
    }
  }

  // Note: target_agent_ids is informational context — the server controls delivery
  // via agent-specific channels. On group channels, we process all messages so the
  // orchestrator sees everything. The server decides who to notify, not the plugin.

  runtime.log?.(`[fluffle] processMessage: from=${message.senderName} content="${message.content?.slice(0, 50)}" groupId=${message.groupId} fileId=${message.fileId ?? "none"} fileName=${message.fileName ?? "none"}`);

  const pairing = createScopedPairingAccess({
    core,
    channel: "fluffle",
    accountId: account.accountId,
  });

  if (!message.content?.trim()) {
    // Cache sender info for streaming messages — stream:end will use this
    if (message.messageType === "streaming" && message.id) {
      streamingSenderCache.set(message.id, {
        senderId: message.senderId,
        senderName: message.senderName,
        senderType: message.senderType,
        teamId: message.teamId,
        groupId: message.groupId,
        createdAt: message.createdAt,
      });
      // Trim cache
      if (streamingSenderCache.size > MAX_STREAMING_CACHE) {
        const keys = Array.from(streamingSenderCache.keys());
        for (let i = 0; i < 50; i++) streamingSenderCache.delete(keys[i]);
      }
      runtime.log?.(`[fluffle] processMessage: cached streaming sender for ${message.id} (${message.senderName})`);
    } else {
      runtime.log?.(`[fluffle] processMessage: empty content, skipping`);
    }
    return;
  }

  // Fluffle groups are always group chats; DMs are 1:1 groups
  // We treat all messages as group context since Fluffle is group-based
  const isGroup = true;
  const rawBody = message.content.trim();

  // ── Playbook cache: fetch if version changed ────────────────────────────
  let playbookContent: string | undefined;
  if (message.playbook?.version !== undefined) {
    const cached = playbookCache.get(message.teamId);
    if (!cached || cached.version !== message.playbook.version) {
      try {
        const playbookApi = new FluffleApi(account);
        const pb = await playbookApi.getPlaybook(message.teamId);
        if (pb) {
          playbookCache.set(message.teamId, pb);
          playbookContent = pb.content;
        }
      } catch (err) {
        runtime.log?.(`[fluffle] Failed to fetch playbook: ${String(err)}`);
      }
    } else {
      playbookContent = cached.content;
    }
  } else {
    // No version in message — use cached content if available
    const cached = playbookCache.get(message.teamId);
    if (cached) playbookContent = cached.content;
  }

  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  // Fluffle is a plugin, not a built-in channel — config lives in plugins.entries.fluffle
  // so we always treat it as "configured" when the monitor is running
  const providerConfigPresent = true;
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent,
    groupPolicy: account.config.groupPolicy,
    defaultGroupPolicy,
  });

  runtime.log?.(`[fluffle] processMessage: groupPolicy=${groupPolicy} providerConfigPresent=${providerConfigPresent} accountGroupPolicy=${account.config.groupPolicy} defaultGroupPolicy=${defaultGroupPolicy}`);

  const groups = account.config.groups ?? {};
  if (isGroup) {
    if (groupPolicy === "disabled") { runtime.log?.(`[fluffle] processMessage: groupPolicy=disabled, dropping`); return; }
    if (groupPolicy === "allowlist") {
      if (!isGroupAllowed({ groupId: message.groupId, groups })) { runtime.log?.(`[fluffle] processMessage: group not in allowlist, dropping`); return; }
    }
  }

  const dmPolicy = account.config.dmPolicy ?? "open";
  const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));
  const { senderAllowedForCommands, commandAuthorized } = await resolveSenderCommandAuthorization({
    cfg: config,
    rawBody,
    isGroup,
    dmPolicy,
    configuredAllowFrom: configAllowFrom,
    senderId: message.senderId,
    isSenderAllowed: (sid: string, af: string[]) => isSenderAllowed(sid, af),
    readAllowFromStore: pairing.readAllowFromStore,
    shouldComputeCommandAuthorized: (body, cfg) =>
      core.channel.commands.shouldComputeCommandAuthorized(body, cfg),
    resolveCommandAuthorizedFromAuthorizers: (params) =>
      core.channel.commands.resolveCommandAuthorizedFromAuthorizers(params),
  });

  if (isGroup && core.channel.commands.isControlCommandMessage(rawBody, config) && commandAuthorized !== true) {
    return;
  }

  const peer = { kind: "group" as const, id: message.groupId };

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "fluffle",
    accountId: account.accountId,
    peer,
  });

  const fromLabel = `group:${message.groupId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  // Fetch team context (channel digest + project state) — cached 60s
  let teamContextBlock = "";
  if (message.teamId) {
    const cached = contextCache.get(message.teamId);
    if (cached && Date.now() - cached.fetchedAt < CONTEXT_CACHE_TTL_MS) {
      teamContextBlock = cached.digest;
    } else {
      try {
        const contextApi = new FluffleApi(account);
        const ctx = await contextApi.getTeamContext(message.teamId);
        if (ctx) {
          const parts: string[] = [];
          // Channel digest
          if (ctx.channelDigest?.length) {
            parts.push("[Team Context — Channel Digest]");
            for (const ch of ctx.channelDigest.slice(0, 2)) {
              if (!ch.recentMessages?.length) continue;
              parts.push(`#${ch.channelName} (${ch.channelType}):`);
              for (const m of ch.recentMessages.slice(-3)) {
                parts.push(`  ${m.senderName}: ${m.content.slice(0, 150)}`);
              }
            }
            parts.push("[End Channel Digest]");
          }
          // Playbook from context (may be newer than cached)
          if (ctx.playbook?.version && ctx.playbook.content) {
            const existing = playbookCache.get(message.teamId);
            if (!existing || existing.version < ctx.playbook.version) {
              playbookCache.set(message.teamId, ctx.playbook);
              playbookContent = ctx.playbook.content;
            }
          }
          teamContextBlock = parts.join("\n").slice(0, 500);
          contextCache.set(message.teamId, { fetchedAt: Date.now(), digest: teamContextBlock });
        }
      } catch (err) {
        runtime.log?.(`[fluffle] Failed to fetch team context: ${String(err)}`);
      }
    }
  }

  // Resolve team + group names for context
  const groupInfo = groupNameCache.get(message.groupId);
  const teamName = groupInfo?.teamName ?? message.teamId;
  const groupName = groupInfo?.title ?? message.groupId;

  // Build agent identity context (teammates only — no roles in v2)
  const agentContextParts: string[] = [];
  if (message.teammates?.length) {
    const teammateList = message.teammates
      .map(t => `  - ${t.name}`)
      .join('\n');
    agentContextParts.push(`[Team Members]\n${teammateList}`);
  }
  const agentContext = agentContextParts.length ? agentContextParts.join('\n') + '\n\n' : '';

  // Prepend playbook + context if available
  const cachedPlaybook = playbookCache.get(message.teamId);
  const contextPrefix = [
    `[Fluffle Context] Team: "${teamName}" | Channel: #${groupName}`,
    agentContext,
    teamContextBlock,
    playbookContent ? `[Team Playbook - v${cachedPlaybook?.version ?? '?'}]\n${playbookContent}\n[End Playbook]` : "",
  ].filter(Boolean).join("\n\n");
  const effectiveBody = contextPrefix ? `${contextPrefix}\n\n${rawBody}` : rawBody;

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Fluffle",
    from: message.senderName || `${message.senderType}:${message.senderId}`,
    timestamp: new Date(message.createdAt).getTime(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: effectiveBody,
  });

  // Resolve file attachment media URL if present
  const fileMediaUrl = message.fileId
    ? `${account.config.baseUrl}/api/files/${message.fileId}`
    : undefined;
  const fileMediaType = message.fileMimeType || undefined;

  if (message.fileId) {
    runtime.log?.(`[fluffle] File attachment detected: fileId=${message.fileId} fileName=${message.fileName} mediaUrl=${fileMediaUrl}`);
  }

  let resolvedMediaUrl = fileMediaUrl;
  let resolvedMediaType = fileMediaType;
  if (message.fileId && fileMediaUrl) {
    try {
      const resp = await fetch(fileMediaUrl, { headers: { Authorization: `Bearer ${account.config.apiKey}` } });
      if (resp.ok) {
        const ct = resp.headers.get("content-type") || fileMediaType || "application/octet-stream";
        const buf = await resp.arrayBuffer();
        const b64 = Buffer.from(buf).toString("base64");
        resolvedMediaUrl = `data:${ct};base64,${b64}`;
        resolvedMediaType = ct;
      }
    } catch {}
  }

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `fluffle:group:${message.groupId}`,
    To: `fluffle:${message.groupId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "group",
    ConversationLabel: fromLabel,
    SenderName: message.senderName || undefined,
    SenderId: message.senderId,
    CommandAuthorized: commandAuthorized,
    Provider: "fluffle",
    Surface: "fluffle",
    MessageSid: message.id,
    OriginatingChannel: "fluffle",
    OriginatingTo: `fluffle:${message.groupId}`,
    ...(resolvedMediaUrl ? { MediaUrl: resolvedMediaUrl, NumMedia: "1" } : {}),
    ...(resolvedMediaType ? { MediaType: resolvedMediaType } : {}),
  });

  // Send typing indicator — we got the message and are working on a reply
  const typingApi = new FluffleApi(account);
  typingApi.sendTyping(message.groupId).catch(() => {});

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`fluffle: failed updating session meta: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "fluffle",
    accountId: account.accountId,
  });

  // ── Typing heartbeat while LLM is processing ──────────────────────────────
  const streamApi = new FluffleApi(account);
  let typingInterval: ReturnType<typeof setInterval> | null = null;

  // Keep "..." visible while thinking/processing
  typingInterval = setInterval(() => {
    streamApi.sendTyping(message.groupId).catch(() => {});
  }, 3000);
  streamApi.sendTyping(message.groupId).catch(() => {});

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload) => {
        // Stop typing heartbeat on delivery
        if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }

        await deliverReply({
          payload: payload as OutboundReplyPayload,
          groupId: message.groupId,
          runtime,
          core,
          config,
          accountId: account.accountId,
          statusSink,
          streamApi,
        });
      },
      onError: (err, info) => {
        runtime.error(`[fluffle] ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: { onModelSelected },
  });

  // Cleanup typing interval
  if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
}

// ─── Deliver outbound reply ─────────────────────────────────────────────────

async function deliverReply(params: {
  payload: OutboundReplyPayload;
  groupId: string;
  runtime: RuntimeEnv;
  core: ReturnType<typeof getFluffleRuntime>;
  config: OpenClawConfig;
  accountId?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  streamApi?: FluffleApi;
}): Promise<void> {
  const { payload, groupId, runtime, core, config, accountId, statusSink, streamApi } = params;
  const text = payload.text ?? "";

  const sentMedia = await sendMediaWithLeadingCaption({
    mediaUrls: resolveOutboundMediaUrls(payload),
    caption: text,
    send: async ({ caption }) => {
      if (caption) {
        await sendMessageFluffle(groupId, caption);
        statusSink?.({ lastOutboundAt: Date.now() });
      }
    },
    onError: (error) => {
      runtime.error(`fluffle media send failed: ${String(error)}`);
    },
  });
  if (sentMedia) return;

  if (text && streamApi) {
    // Stream the final response text via Fluffle's streaming API
    try {
      const { id: msgId } = await streamApi.createStreamingMessage(groupId);
      // Send the text in small chunks for a streaming effect
      const CHUNK_SIZE = 80; // ~80 chars per chunk
      for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        const chunk = text.slice(i, i + CHUNK_SIZE);
        await streamApi.sendStreamChunk(groupId, msgId, chunk);
        // Small delay between chunks for visual effect
        if (i + CHUNK_SIZE < text.length) {
          await new Promise(r => setTimeout(r, 50));
        }
      }
      await streamApi.finalizeStream(groupId, msgId);
      statusSink?.({ lastOutboundAt: Date.now() });
    } catch (err) {
      runtime.error?.(`[fluffle] streaming delivery failed, falling back: ${String(err)}`);
      // Fallback: send as regular message
      try {
        await sendMessageFluffle(groupId, text);
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (e2) {
        runtime.error(`fluffle message send failed: ${String(e2)}`);
      }
    }
  } else if (text) {
    const chunkMode = core.channel.text.resolveChunkMode(config, "fluffle", accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(text, TEXT_LIMIT, chunkMode);
    for (const chunk of chunks) {
      try {
        await sendMessageFluffle(groupId, chunk);
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error(`fluffle message send failed: ${String(err)}`);
      }
    }
  }
}

// ─── Webhook transport ──────────────────────────────────────────────────────

function startWebhookListener(
  account: ResolvedFluffleAccount,
  config: OpenClawConfig,
  core: ReturnType<typeof getFluffleRuntime>,
  runtime: RuntimeEnv,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
): void {
  (core as any).http.registerHttpRoute({
    method: "POST",
    path: "/channels/fluffle/webhook",
    handler: async (req: any) => {
      const signature = req.headers["x-fluffle-signature"] as string;
      const timestamp = req.headers["x-fluffle-timestamp"] as string;
      const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);

      if (!signature || !timestamp) {
        return { status: 401, body: { error: "Missing signature headers" } };
      }

      if (!verifyWebhookSignature(rawBody, signature, timestamp, account.config.signingSecret)) {
        return { status: 401, body: { error: "Invalid signature" } };
      }

      const payload = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as WebhookPayload;
      if (payload.event !== "message.new") {
        return { status: 200, body: { ok: true, skipped: true } };
      }

      const message = parseWebhookPayload(payload);
      statusSink?.({ lastInboundAt: Date.now() });

      processMessage(message, account, config, core, runtime, statusSink).catch((err) => {
        runtime.error(`[fluffle] Failed to process webhook message: ${String(err)}`);
      });

      return { status: 200, body: { ok: true } };
    },
  });

  runtime.log?.(`[fluffle] Webhook listener registered at /channels/fluffle/webhook`);
}

// ─── Pusher transport ───────────────────────────────────────────────────────

async function startPusherListener(
  account: ResolvedFluffleAccount,
  config: OpenClawConfig,
  core: ReturnType<typeof getFluffleRuntime>,
  runtime: RuntimeEnv,
  abortSignal: AbortSignal,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
): Promise<void> {
  const pusherConfig = account.config.pusher;
  if (!pusherConfig?.key || !pusherConfig?.cluster) {
    throw new Error("[fluffle] Pusher transport selected but pusher.key/cluster not configured");
  }

  const api = new FluffleApi(account);

  // Track last-seen message time for catch-up polling on reconnect
  let lastMessageAt: string = new Date().toISOString();
  const seenMessageIds = new Set<string>();
  const MAX_SEEN_IDS = 500;
  let isReconnect = false;

  function trackMessage(id: string, createdAt?: string) {
    if (id) {
      seenMessageIds.add(id);
      if (seenMessageIds.size > MAX_SEEN_IDS) {
        const iter = seenMessageIds.values();
        for (let i = 0; i < 100; i++) iter.next();
        // trim oldest 100
        const keep = new Set<string>();
        for (const v of seenMessageIds) {
          if (keep.size >= MAX_SEEN_IDS - 100) break;
          keep.add(v);
        }
        seenMessageIds.clear();
        for (const v of keep) seenMessageIds.add(v);
      }
    }
    if (createdAt && createdAt > lastMessageAt) {
      lastMessageAt = createdAt;
    }
  }

  async function catchUpMissedMessages() {
    try {
      runtime.log?.(`[fluffle] Catching up missed messages since ${lastMessageAt}`);
      const missed = await api.getMessages(lastMessageAt, 50);
      let processed = 0;
      for (const msg of missed) {
        if (msg.id && seenMessageIds.has(msg.id)) continue;
        // Skip own messages
        if (msg.sender_agent_id === account.config.agentId) {
          trackMessage(msg.id, msg.created_at);
          continue;
        }
        const message: FluffleInboundMessage = {
          id: msg.id ?? "",
          groupId: msg.group_id ?? "",
          teamId: msg.team_id ?? "",
          senderId: msg.sender_user_id ?? msg.sender_agent_id ?? "",
          senderName: msg.sender_name ?? "",
          senderType: (msg.sender_agent_id ? "agent" : (msg.sender_type ?? "user")) as "agent" | "user",
          content: msg.content ?? "",
          messageType: msg.message_type ?? "text",
          createdAt: msg.created_at ?? new Date().toISOString(),
          replyTo: (msg as any).reply_to ?? null,
          fileId: (msg as any).file_id ?? null,
          fileName: (msg as any).file_name ?? null,
          fileMimeType: (msg as any).file_mime_type ?? null,
        };
        trackMessage(msg.id, msg.created_at);
        statusSink?.({ lastInboundAt: Date.now() });
        await processMessage(message, account, config, core, runtime, statusSink).catch((err) => {
          runtime.error(`[fluffle] Failed to process catch-up message: ${String(err)}`);
        });
        processed++;
      }
      runtime.log?.(`[fluffle] Catch-up complete: ${processed} new message(s) from ${missed.length} fetched`);
    } catch (err) {
      runtime.error?.(`[fluffle] Catch-up polling failed: ${String(err)}`);
    }
  }

  // Dynamic import pusher-js
  const PusherModule = await import("pusher-js");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const PusherClass = (PusherModule.default ?? PusherModule) as any;

  const pusher = new PusherClass(pusherConfig.key, {
    cluster: pusherConfig.cluster,
    authorizer: (channel: { name: string }) => ({
      authorize: (socketId: string, callback: (error: Error | null, data: { auth: string } | null) => void) => {
        api.pusherAuth(socketId, channel.name)
          .then((data) => callback(null, data))
          .catch((err) => callback(err, null));
      },
    }),
  });

  pusher.connection.bind("connected", () => {
    runtime.log?.(`[fluffle] Pusher connected${isReconnect ? " (reconnect — catching up)" : ""}`);
    if (isReconnect) {
      catchUpMissedMessages();
    }
    isReconnect = true; // subsequent connects are reconnects
  });

  pusher.connection.bind("error", (err: unknown) => {
    runtime.error?.(`[fluffle] Pusher error: ${String(err)}`);
  });

  // Subscribe to agent channel
  const agentChannel = pusher.subscribe(`private-agent-${account.config.agentId}`);
  agentChannel.bind("message:new", (data: any) => {
    runtime.log?.(`[fluffle] Pusher agent message received: ${JSON.stringify(data).slice(0, 300)}`);

    // Handle both WebhookPayload shape (new: has message object) and flat shape (legacy)
    let message: FluffleInboundMessage;
    if (data.message && typeof data.message === "object" && data.message.content !== undefined) {
      // New WebhookPayload shape — use parseWebhookPayload
      message = parseWebhookPayload({
        event: "message.new",
        team_id: data.team_id ?? "",
        group_id: data.group_id ?? "",
        message: data.message,
        recipient_agent: data.recipient_agent,
        teammates: data.teammates,
        target_agent_ids: data.target_agent_ids,
        target_agent_names: data.target_agent_names,
        playbook: data.playbook,
      });
    } else if (data.content !== undefined) {
      // Legacy flat shape — normalize manually
      message = {
        id: data.id ?? "",
        groupId: data.group_id ?? "",
        teamId: data.team_id ?? "",
        senderId: data.sender_user_id ?? data.sender_agent_id ?? data.sender_id ?? "",
        senderName: data.sender_name ?? "",
        senderType: data.sender_agent_id ? "agent" : "user",
        content: data.content ?? "",
        messageType: data.message_type ?? "text",
        createdAt: data.created_at ?? new Date().toISOString(),
        replyTo: data.reply_to ?? null,
        fileId: data.file_id ?? null,
        fileName: data.file_name ?? null,
        fileMimeType: data.file_mime_type ?? null,
        targetAgentIds: data.target_agent_ids,
        targetAgentNames: data.target_agent_names,
        teammates: data.teammates,
      };
    } else {
      runtime.log?.(`[fluffle] Pusher agent message: unrecognized shape, skipping`);
      return;
    }

    trackMessage(message.id, message.createdAt);
    statusSink?.({ lastInboundAt: Date.now() });
    processMessage(message, account, config, core, runtime, statusSink).catch((err) => {
      runtime.error(`[fluffle] Failed to process Pusher agent message: ${String(err)}`);
    });
  });

  // ─── Dynamic group subscription ──────────────────────────────────────────
  const subscribedGroups = new Set<string>();

  function subscribeToGroup(groupId: string, teamId: string) {
    if (subscribedGroups.has(groupId)) return;
    subscribedGroups.add(groupId);
    const channel = pusher.subscribe(`private-group-${groupId}`);
    // Listen for both 'message:created' (new server) and 'message:new' (legacy) — dedup handles duplicates
    const groupMessageHandler = (data: any) => {
      runtime.log?.(`[fluffle] Pusher group message received: ${JSON.stringify(data).slice(0, 300)}`);
      if (data.sender_agent_id === account.config.agentId) return;
      const message: FluffleInboundMessage = {
        id: data.id ?? "",
        groupId: groupId,
        teamId: data.team_id ?? teamId ?? "",
        senderId: data.sender_user_id ?? data.sender_agent_id ?? data.sender_id ?? data.sender?.id ?? "",
        senderName: data.sender_name ?? data.sender?.name ?? "",
        senderType: data.sender_agent_id ? "agent" : (data.sender_type ?? "user"),
        content: data.content ?? "",
        messageType: data.message_type ?? "text",
        createdAt: data.created_at ?? new Date().toISOString(),
        replyTo: data.reply_to ?? null,
        fileId: data.file_id ?? null,
        fileName: data.file_name ?? null,
        fileMimeType: data.file_mime_type ?? null,
        playbook: data.playbook,
        targetAgentIds: data.target_agent_ids,
        targetAgentNames: data.target_agent_names,
        teammates: data.teammates,
      };
      trackMessage(message.id, message.createdAt);
      statusSink?.({ lastInboundAt: Date.now() });
      processMessage(message, account, config, core, runtime, statusSink).catch((err) => {
        runtime.error(`[fluffle] Failed to process Pusher group message: ${String(err)}`);
      });
    };
    channel.bind("message:new", groupMessageHandler);
    channel.bind("message:created", groupMessageHandler);

    // Handle streaming message finalization — agents that use streaming send
    // initial message:new with empty content (cached in streamingSenderCache),
    // then stream chunks, then fire message:stream:end with the final content.
    channel.bind("message:stream:end", (data: any) => {
      const msgId = data.messageId;
      const content = data.content ?? "";
      runtime.log?.(`[fluffle] Pusher stream:end received: msgId=${msgId} content="${content.slice(0, 100)}"`);
      if (!content.trim()) return;

      // Look up sender info from the cached initial streaming message
      const cached = streamingSenderCache.get(msgId);
      if (!cached) {
        runtime.log?.(`[fluffle] stream:end: no cached sender for ${msgId}, skipping`);
        return;
      }
      streamingSenderCache.delete(msgId);

      // Skip our own messages
      if (cached.senderId === account.config.agentId) return;

      const message: FluffleInboundMessage = {
        id: `${msgId}-stream-end`,
        groupId: groupId,
        teamId: cached.teamId || teamId,
        senderId: cached.senderId,
        senderName: cached.senderName,
        senderType: cached.senderType as "agent" | "user",
        content: content,
        messageType: "text",
        createdAt: cached.createdAt,
        replyTo: null,
        fileId: null,
        fileName: null,
        fileMimeType: null,
      };
      trackMessage(message.id, message.createdAt);
      statusSink?.({ lastInboundAt: Date.now() });
      processMessage(message, account, config, core, runtime, statusSink).catch((err) => {
        runtime.error?.(`[fluffle] Failed to process stream:end message: ${String(err)}`);
      });
    });
  }

  async function refreshGroupSubscriptions() {
    try {
      const groups = await api.getGroups();
      let newCount = 0;
      for (const group of groups) {
        // Cache group/team names for envelope context
        groupNameCache.set(group.id, {
          title: group.title ?? group.id,
          teamId: group.team_id,
          teamName: (group as any).team_name ?? group.team_id,
        });
        if (!subscribedGroups.has(group.id)) {
          subscribeToGroup(group.id, group.team_id);
          newCount++;
        }
      }
      if (newCount > 0) {
        runtime.log?.(`[fluffle] Subscribed to ${newCount} new group channel(s) (total: ${subscribedGroups.size})`);
      }
    } catch (err) {
      runtime.error?.(`[fluffle] Failed to refresh group subscriptions: ${String(err)}`);
    }
  }

  // Initial subscription
  await refreshGroupSubscriptions();
  runtime.log?.(`[fluffle] Subscribed to ${subscribedGroups.size} group channel(s) via Pusher`);

  // Periodic refresh for new groups (every 60s)
  const groupRefreshInterval = setInterval(() => {
    refreshGroupSubscriptions();
  }, 60_000);

  // ─── Agent validation on persistent errors ─────────────────────────────
  let consecutiveHeartbeatErrors = 0;

  async function checkAgentStillExists(): Promise<boolean> {
    try {
      const result = await api.validateAgent();
      if (!result.exists) {
        runtime.error?.(`[fluffle] Agent confirmed removed from Fluffle (reason: ${result.reason}). Shutting down plugin.`);
        // Notify user via other channels
        try {
          const msg = `⚠️ My Fluffle agent has been removed or my API key was revoked (reason: ${result.reason}). The Fluffle plugin is now disabled.`;
          (core.channel as any).injectSystemEvent?.(msg);
        } catch (_) { /* best effort */ }
        return false;
      }
      return true;
    } catch (_) {
      // Can't reach Fluffle validate endpoint — treat as "unknown", keep going
      runtime.log?.(`[fluffle] Could not validate agent (Fluffle may be down), continuing...`);
      return true;
    }
  }

  // Heartbeat
  await api.heartbeat().catch(() => {});
  const heartbeatInterval = setInterval(async () => {
    try {
      await api.heartbeat();
      consecutiveHeartbeatErrors = 0;
    } catch (err) {
      consecutiveHeartbeatErrors++;
      runtime.error?.(`[fluffle] Heartbeat failed (${consecutiveHeartbeatErrors}x): ${String(err)}`);

      // After 3 consecutive failures, ask Fluffle directly if we still exist
      if (consecutiveHeartbeatErrors >= 3) {
        const stillExists = await checkAgentStillExists();
        if (!stillExists) {
          clearInterval(heartbeatInterval);
          pusher.disconnect();
          runtime.log?.(`[fluffle] Plugin stopped — agent no longer exists on Fluffle`);
          return;
        }
        // Reset counter — Fluffle confirmed we exist, just having transient issues
        consecutiveHeartbeatErrors = 0;
      }
    }
  }, 30_000);

  abortSignal.addEventListener(
    "abort",
    () => {
      clearInterval(heartbeatInterval);
      clearInterval(groupRefreshInterval);
      pusher.disconnect();
      runtime.log?.(`[fluffle] Pusher disconnected`);
    },
    { once: true },
  );
}

// ─── Main monitor entry ─────────────────────────────────────────────────────

export async function monitorFluffle(
  options: FluffleMonitorOptions,
): Promise<FluffleMonitorResult> {
  const { account, config, abortSignal, statusSink, runtime } = options;
  const core = getFluffleRuntime();
  let stopped = false;

  // Initialize send API for outbound messages
  initFluffleSendApi(account);

  const stop = () => {
    stopped = true;
  };

  const transport = account.config.transport ?? "webhook";

  if (transport === "pusher") {
    runtime.log?.(`[fluffle] Starting Pusher transport`);
    await startPusherListener(account, config, core, runtime, abortSignal, statusSink);

    // Keep alive until abort
    await new Promise<void>((resolve) => {
      abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
  } else {
    runtime.log?.(`[fluffle] Starting webhook transport`);
    startWebhookListener(account, config, core, runtime, statusSink);

    // Keep alive until abort
    await new Promise<void>((resolve) => {
      abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  return { stop };
}
