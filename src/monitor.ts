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

  runtime.log?.(`[fluffle] processMessage: from=${message.senderName} content="${message.content?.slice(0, 50)}" groupId=${message.groupId}`);

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

  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const providerConfigPresent = (config.channels as any)?.["fluffle"] !== undefined;
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
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Fluffle",
    from: message.senderName || `${message.senderType}:${message.senderId}`,
    timestamp: new Date(message.createdAt).getTime(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

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
  });

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

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload) => {
        await deliverReply({
          payload: payload as OutboundReplyPayload,
          groupId: message.groupId,
          runtime,
          core,
          config,
          accountId: account.accountId,
          statusSink,
        });
      },
      onError: (err, info) => {
        runtime.error(`[fluffle] ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: { onModelSelected },
  });
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
}): Promise<void> {
  const { payload, groupId, runtime, core, config, accountId, statusSink } = params;
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

  if (text) {
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
    runtime.log?.(`[fluffle] Pusher connected`);
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
    });
    statusSink?.({ lastInboundAt: Date.now() });
    processMessage(message, account, config, core, runtime, statusSink).catch((err) => {
      runtime.error(`[fluffle] Failed to process Pusher message: ${String(err)}`);
    });
  });

  // Fetch and subscribe to group channels
  try {
    const groups = await api.getGroups();
    for (const group of groups) {
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
        };
        statusSink?.({ lastInboundAt: Date.now() });
        processMessage(message, account, config, core, runtime, statusSink).catch((err) => {
          runtime.error(`[fluffle] Failed to process Pusher group message: ${String(err)}`);
        });
      });
    }
    runtime.log?.(`[fluffle] Subscribed to ${groups.length} group channel(s) via Pusher`);
  } catch (err) {
    runtime.error?.(`[fluffle] Failed to fetch groups for Pusher: ${String(err)}`);
  }

  // Heartbeat
  await api.heartbeat().catch(() => {});
  const heartbeatInterval = setInterval(async () => {
    try {
      await api.heartbeat();
    } catch (err) {
      runtime.error?.(`[fluffle] Heartbeat failed: ${String(err)}`);
    }
  }, 30_000);

  abortSignal.addEventListener(
    "abort",
    () => {
      clearInterval(heartbeatInterval);
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
