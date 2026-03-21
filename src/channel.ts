import type {
  ChannelAccountSnapshot,
  ChannelDock,
  ChannelPlugin,
  OpenClawConfig,
  GroupToolPolicyConfig,
  ChannelGroupContext,
} from "openclaw/plugin-sdk";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  formatAllowFromLowercase,
  formatPairingApproveHint,
  resolveChannelAccountConfigBasePath,
  setAccountEnabledInConfigSection,
  deleteAccountFromConfigSection,
} from "openclaw/plugin-sdk";
import {
  listFluffleAccountIds,
  resolveDefaultFluffleAccountId,
  resolveFluffleAccountSync,
} from "./accounts.js";
import { FluffleConfigSchema } from "./config-schema.js";
import { sendMessageFluffle } from "./send.js";
import type { ResolvedFluffleAccount } from "./types.js";

const meta = {
  id: "fluffle",
  label: "Fluffle",
  selectionLabel: "Fluffle (AI Team Collaboration)",
  docsPath: "/plugins/fluffle",
  docsLabel: "fluffle",
  blurb: "Fluffle.ai AI agent team collaboration — webhook + Pusher transport.",
  aliases: ["fl"],
  order: 90,
  quickstartAllowFrom: true,
};

function resolveGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const account = resolveFluffleAccountSync({
    cfg: params.cfg,
    accountId: params.accountId ?? undefined,
  });
  const groups = account.config.groups ?? {};
  const candidates = [params.groupId, params.groupChannel, "*"].filter(
    (v): v is string => Boolean(v?.trim()),
  );
  for (const key of candidates) {
    const entry = groups[key.trim()];
    if (entry?.tools) return entry.tools;
  }
  return undefined;
}

export const fluffleDock: ChannelDock = {
  id: "fluffle",
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    blockStreaming: false,
  },
  outbound: { textChunkLimit: 4096 },
  config: {
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveFluffleAccountSync({ cfg, accountId }).config.allowFrom ?? []).map(String),
    formatAllowFrom: ({ allowFrom }) =>
      formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^fluffle:/i }),
  },
  groups: {
    resolveRequireMention: () => false,
    resolveToolPolicy: resolveGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
};

export const flufflePlugin: ChannelPlugin<ResolvedFluffleAccount> = {
  id: "fluffle",
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.fluffle", "plugins.entries.fluffle"] },
  configSchema: buildChannelConfigSchema(FluffleConfigSchema),
  config: {
    listAccountIds: (cfg) => listFluffleAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveFluffleAccountSync({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultFluffleAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "fluffle",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "fluffle",
        accountId,
        clearBaseFields: [
          "name", "dmPolicy", "allowFrom", "groupPolicy", "groups", "messagePrefix",
          "apiKey", "agentId", "signingSecret", "baseUrl", "transport", "pusher",
        ],
      }),
    isConfigured: async (cfg) => {
      // cfg here is the resolved account object, not the full OpenClaw config
      const config = (cfg as any)?.config ?? cfg;
      return Boolean(config?.apiKey && config?.agentId);
    },
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: undefined,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveFluffleAccountSync({ cfg, accountId }).config.allowFrom ?? []).map(String),
    formatAllowFrom: ({ allowFrom }) =>
      formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^fluffle:/i }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const basePath = resolveChannelAccountConfigBasePath({
        cfg,
        channelKey: "fluffle",
        accountId: resolvedAccountId,
      });
      return {
        policy: account.config.dmPolicy ?? "open",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("fluffle"),
        normalizeEntry: (raw: string) => raw.replace(/^fluffle:/i, ""),
      };
    },
  },
  groups: {
    resolveRequireMention: () => false,
    resolveToolPolicy: resolveGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
  messaging: {
    normalizeTarget: (raw) => raw?.trim()?.replace(/^fluffle:/i, "") || undefined,
    targetResolver: {
      looksLikeId: (raw) => /^[0-9a-f-]{36}$/i.test(raw.trim()),
      hint: "<groupId>",
    },
  },
  gateway: {
    startAccount: async ({ cfg, account, runtime, abortSignal }) => {
      runtime.log?.(`[fluffle] startAccount() called, account=${account.accountId}, enabled=${account.enabled}`);
      const { monitorFluffle } = await import("./monitor.js");
      runtime.log?.(`[fluffle] monitor imported, starting...`);
      await monitorFluffle({ account, config: cfg, runtime, abortSignal });
    },
    send: async ({ target, text }) => {
      const result = await sendMessageFluffle(target, text);
      return { ok: result.ok, error: result.error };
    },
  },
};
