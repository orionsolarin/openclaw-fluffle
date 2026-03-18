import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { FluffleAccountConfig, FluffleConfig, ResolvedFluffleAccount } from "./types.js";

function getFluffleSection(cfg: OpenClawConfig): FluffleConfig | undefined {
  // Try channels.fluffle first (standard channel config location)
  const fromChannels = (cfg.channels as any)?.["fluffle"] as FluffleConfig | undefined;
  if (fromChannels) return fromChannels;
  // Fall back to plugins.entries.fluffle.config (where gateway stores plugin config)
  const pluginEntry = (cfg as any)?.plugins?.entries?.["fluffle"];
  const fromPlugin = pluginEntry?.config as FluffleConfig | undefined;
  if (fromPlugin && pluginEntry?.enabled !== undefined && fromPlugin.enabled === undefined) {
    // Hoist the entry-level enabled flag into the config section
    fromPlugin.enabled = pluginEntry.enabled;
  }
  return fromPlugin ?? undefined;
}

export function listFluffleAccountIds(cfg: OpenClawConfig): string[] {
  const section = getFluffleSection(cfg);
  if (!section) return [DEFAULT_ACCOUNT_ID];
  const ids = new Set<string>([DEFAULT_ACCOUNT_ID]);
  if (section.accounts) {
    for (const key of Object.keys(section.accounts)) {
      ids.add(key);
    }
  }
  return [...ids];
}

export function resolveDefaultFluffleAccountId(cfg: OpenClawConfig): string {
  const section = getFluffleSection(cfg);
  return section?.defaultAccount ?? DEFAULT_ACCOUNT_ID;
}

export function resolveFluffleAccountSync(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedFluffleAccount {
  const { cfg, accountId } = params;
  const section = getFluffleSection(cfg);
  const resolvedId = accountId ?? DEFAULT_ACCOUNT_ID;

  const baseConfig: FluffleAccountConfig & {
    apiKey: string;
    agentId: string;
    signingSecret: string;
    baseUrl: string;
  } = {
    enabled: section?.enabled,
    name: section?.name,
    apiKey: section?.apiKey ?? "",
    agentId: section?.agentId ?? "",
    signingSecret: section?.signingSecret ?? "",
    baseUrl: section?.baseUrl ?? "https://fluffle.ai",
    transport: section?.transport,
    pusher: section?.pusher,
    dmPolicy: section?.dmPolicy,
    allowFrom: section?.allowFrom,
    groupPolicy: section?.groupPolicy,
    groups: section?.groups,
    messagePrefix: section?.messagePrefix,
    responsePrefix: section?.responsePrefix,
  };

  if (resolvedId !== DEFAULT_ACCOUNT_ID && section?.accounts?.[resolvedId]) {
    const accountConfig = section.accounts[resolvedId];
    return {
      accountId: resolvedId,
      name: accountConfig.name ?? baseConfig.name,
      enabled: accountConfig.enabled ?? baseConfig.enabled ?? false,
      config: {
        ...baseConfig,
        ...accountConfig,
        apiKey: accountConfig.apiKey ?? baseConfig.apiKey,
        agentId: accountConfig.agentId ?? baseConfig.agentId,
        signingSecret: accountConfig.signingSecret ?? baseConfig.signingSecret,
        baseUrl: accountConfig.baseUrl ?? baseConfig.baseUrl,
      },
    };
  }

  return {
    accountId: resolvedId,
    name: baseConfig.name,
    enabled: baseConfig.enabled ?? false,
    config: baseConfig,
  };
}
