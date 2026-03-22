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
  // Skip messages from our own agent
  if (message.senderType === "agent" && message.senderId === account.config.agentId) return;

  runtime.log?.(`[fluffle] processMessage: from=${message.senderName} content="${message.content?.slice(0, 50)}" groupId=${message.groupId} fileId=${message.fileId ?? "none"} fileName=${message.fileName ?? "none"}`);

  const pairing = createScopedPairingAccess({
    core,
    channel: "fluffle",
    accountId: account.accountId,
  });

  if (!message.content?.trim()) { runtime.log?.(`[fluffle] processMessage: empty content, skipping`); return; }

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
  // Prepend playbook if available
  const cachedPlaybook = playbookCache.get(message.teamId);
  const effectiveBody = playbookContent
    ? `[Team Playbook - v${cachedPlaybook?.version ?? '?'}]\n${playbookContent}\n[End Playbook]\n\n${rawBody}`
    : rawBody;

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
    ...(fileMediaUrl ? { MediaUrl: fileMediaUrl, NumMedia: "1" } : {}),
    ...(fileMediaType ? { MediaType: fileMediaType } : {}),
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
  core.http.registerHttpRoute({
    method: "POST",
    path: "/channels/fluffle/webhook",
    handler: async (req) => {
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
          senderType: msg.sender_agent_id ? "agent" : (msg.sender_type ?? "user"),
          content: msg.content ?? "",
          messageType: msg.message_type ?? "text",
          createdAt: msg.created_at ?? new Date().toISOString(),
          replyTo: msg.reply_to ?? null,
          fileId: msg.file_id ?? null,
          fileName: msg.file_name ?? null,
          fileMimeType: msg.file_mime_type ?? null,
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
  const Pusher = PusherModule.default ?? PusherModule;

  const pusher = new Pusher(pusherConfig.key, {
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
    const payload = data as WebhookPayload;
    if (payload.event !== "message.new" && !payload.message) return;
    const message = parseWebhookPayload({
      event: "message.new",
      team_id: payload.team_id ?? "",
      group_id: payload.group_id ?? "",
      message: payload.message,
      recipient_agent: payload.recipient_agent,
      teammates: payload.teammates,
      playbook: payload.playbook,
    });
    trackMessage(message.id, message.createdAt);
    statusSink?.({ lastInboundAt: Date.now() });
    processMessage(message, account, config, core, runtime, statusSink).catch((err) => {
      runtime.error(`[fluffle] Failed to process Pusher message: ${String(err)}`);
    });
  });

  // ─── Group subscription with dynamic refresh ──────────────────────────────
  const subscribedGroupIds = new Set<string>();

  function subscribeToGroup(group: { id: string; title: string; team_id: string }) {
    if (subscribedGroupIds.has(group.id)) return;
    subscribedGroupIds.add(group.id);

    const channel = pusher.subscribe(`private-group-${group.id}`);
    channel.bind("message:new", (data: any) => {
      runtime.log?.(`[fluffle] Pusher group message received: ${JSON.stringify(data).slice(0, 300)}`);
      if (data.sender_agent_id === account.config.agentId) return;
      const message: FluffleInboundMessage = {
        id: data.id ?? "",
        groupId: group.id,
        teamId: group.team_id ?? "",
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
      };
      trackMessage(message.id, message.createdAt);
      statusSink?.({ lastInboundAt: Date.now() });
      processMessage(message, account, config, core, runtime, statusSink).catch((err) => {
        runtime.error(`[fluffle] Failed to process Pusher group message: ${String(err)}`);
      });
    });
    runtime.log?.(`[fluffle] Subscribed to group: ${group.title} (${group.id}) [team: ${group.team_id}]`);
  }

  async function refreshGroupSubscriptions() {
    try {
      const groups = await api.getGroups();
      let newCount = 0;
      for (const group of groups) {
        if (!subscribedGroupIds.has(group.id)) {
          subscribeToGroup(group);
          newCount++;
        }
      }
      if (newCount > 0) {
        runtime.log?.(`[fluffle] Group refresh: subscribed to ${newCount} new group(s), total: ${subscribedGroupIds.size}`);
      }
    } catch (err) {
      runtime.error?.(`[fluffle] Failed to refresh groups: ${String(err)}`);
    }
  }

  // Initial group subscription
  try {
    const groups = await api.getGroups();
    for (const group of groups) {
      subscribeToGroup(group);
    }
    runtime.log?.(`[fluffle] Subscribed to ${groups.length} group channel(s) via Pusher`);
  } catch (err) {
    runtime.error?.(`[fluffle] Failed to fetch groups for Pusher: ${String(err)}`);
  }

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
          core.channel.injectSystemEvent?.(msg);
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

  // Heartbeat + periodic group refresh
  let heartbeatCount = 0;
  await api.heartbeat().catch(() => {});
  const heartbeatInterval = setInterval(async () => {
    heartbeatCount++;
    try {
      await api.heartbeat();
      consecutiveHeartbeatErrors = 0;

      // Refresh group subscriptions every 5 heartbeats (~2.5 min)
      // This picks up new teams/groups the agent was added to after startup
      if (heartbeatCount % 5 === 0) {
        await refreshGroupSubscriptions();
      }
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
      pusher.disconnect();
      runtime.log?.(`[fluffle] Pusher disconnected (was tracking ${subscribedGroupIds.size} groups)`);
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
