export type FluffleConfig = {
  enabled?: boolean;
  name?: string;
  apiKey: string;
  agentId: string;
  signingSecret: string;
  baseUrl: string;
  transport?: "webhook" | "pusher";
  pusher?: { key: string; cluster: string };
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  groupPolicy?: "open" | "allowlist" | "disabled";
  groups?: Record<string, FluffleGroupConfig>;
  messagePrefix?: string;
  responsePrefix?: string;
  defaultAccount?: string;
  accounts?: Record<string, FluffleAccountConfig>;
};

export type FluffleAccountConfig = {
  enabled?: boolean;
  name?: string;
  apiKey?: string;
  agentId?: string;
  signingSecret?: string;
  baseUrl?: string;
  transport?: "webhook" | "pusher";
  pusher?: { key: string; cluster: string };
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  groupPolicy?: "open" | "allowlist" | "disabled";
  groups?: Record<string, FluffleGroupConfig>;
  messagePrefix?: string;
  responsePrefix?: string;
};

export type FluffleGroupConfig = {
  allow?: boolean;
  enabled?: boolean;
  tools?: { allow?: string[]; deny?: string[] };
};

export type ResolvedFluffleAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: FluffleAccountConfig & {
    apiKey: string;
    agentId: string;
    signingSecret: string;
    baseUrl: string;
  };
};

export type WebhookPayload = {
  event: string;
  team_id: string;
  group_id: string;
  message: {
    id: string;
    sender: { type: "agent" | "user"; id: string | null; name: string | null };
    content: string;
    message_type: string;
    created_at: string;
    reply_to?: { id: string; content: string; sender_name: string } | null;
    file_id?: string | null;
    file_name?: string | null;
    file_mime_type?: string | null;
  };
  recipient_agent?: {
    id?: string;
    name?: string;
    role: string | null;
    directives?: string | null;
    attitude?: string | null;
  };
  teammates?: Array<{ id?: string; name: string; role: string | null }>;
  target_agent_ids?: string[];
  target_agent_names?: string[];
  playbook?: { version: number };
};

export type FluffleInboundMessage = {
  id: string;
  groupId: string;
  teamId: string;
  senderId: string;
  senderName: string;
  senderType: "agent" | "user";
  content: string;
  messageType: string;
  createdAt: string;
  replyTo?: { id: string; content: string; senderName: string } | null;
  fileId?: string | null;
  fileName?: string | null;
  fileMimeType?: string | null;
  playbook?: { version: number };
  /** IDs of agents the server targeted for this message */
  targetAgentIds?: string[];
  /** Names of targeted agents */
  targetAgentNames?: string[];
  /** Info about the recipient agent (role, etc.) — from agent-channel delivery */
  recipientAgent?: { id?: string; name?: string; role: string | null };
  /** All agent teammates in this group */
  teammates?: Array<{ id?: string; name: string; role: string | null }>;
};
