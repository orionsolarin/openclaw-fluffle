import type { ResolvedFluffleAccount } from "./types.js";

export class FluffleApi {
  private baseUrl: string;
  private apiKey: string;
  private agentId: string;

  constructor(account: ResolvedFluffleAccount) {
    this.baseUrl = account.config.baseUrl.replace(/\/$/, "");
    this.apiKey = account.config.apiKey;
    this.agentId = account.config.agentId;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...((options.headers as Record<string, string>) || {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Fluffle API ${res.status}: ${path} — ${body}`);
    }
    return res.json() as Promise<T>;
  }

  async sendTyping(groupId: string): Promise<void> {
    await this.request(`/api/groups/${groupId}/typing`, { method: "POST" }).catch(() => {});
  }

  async sendMessage(groupId: string, content: string, fileId?: string): Promise<{ id: string }> {
    return this.request<{ id: string }>(`/api/groups/${groupId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, message_type: "text", ...(fileId ? { file_id: fileId } : {}) }),
    });
  }

  async createStreamingMessage(groupId: string): Promise<{ id: string }> {
    const data = await this.request<{ message: { id: string } }>(`/api/groups/${groupId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "", message_type: "text", streaming: true }),
    });
    return { id: data.message.id };
  }

  async sendStreamChunk(groupId: string, messageId: string, chunk: string): Promise<void> {
    await this.request(`/api/groups/${groupId}/messages/${messageId}/stream`, {
      method: "POST",
      body: JSON.stringify({ chunk }),
    });
  }

  async finalizeStream(groupId: string, messageId: string): Promise<void> {
    await this.request(`/api/groups/${groupId}/messages/${messageId}/stream`, {
      method: "POST",
      body: JSON.stringify({ done: true }),
    });
  }

  async sendThinkingMessage(groupId: string): Promise<{ id: string }> {
    const data = await this.request<{ message: { id: string } }>(`/api/groups/${groupId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "", message_type: "thinking" }),
    });
    return { id: data.message.id };
  }

  async getGroups(): Promise<Array<{ id: string; title: string; team_id: string; team_name: string }>> {
    const data = await this.request<{ groups: Array<{ group_id?: string; id?: string; title: string; team_id: string; team_name?: string }> }>(
      `/api/agents/${this.agentId}/groups`,
    );
    // Normalize: API returns group_id, plugin expects id
    return data.groups.map((g) => ({
      id: g.group_id ?? g.id ?? "",
      title: g.title,
      team_id: g.team_id,
      team_name: g.team_name ?? g.team_id,
    }));
  }

  async heartbeat(): Promise<void> {
    await this.request(`/api/agents/${this.agentId}/heartbeat`, {
      method: "POST",
      body: JSON.stringify({ status: "online" }),
    });
  }

  /**
   * Check if this agent still exists on Fluffle.
   * Returns { exists, reason? } — only trust the result if the request succeeds.
   * On network error / 5xx, throws (caller should treat as "unknown").
   */
  async validateAgent(): Promise<{ exists: boolean; reason?: string }> {
    const url = `${this.baseUrl}/api/agents/${this.agentId}/validate`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    // 200 = exists, 401/404/410 = explicit "you're gone"
    if (res.ok) {
      return res.json() as Promise<{ exists: boolean }>;
    }
    if (res.status === 401 || res.status === 404 || res.status === 410) {
      return res.json() as Promise<{ exists: boolean; reason: string }>;
    }
    // 5xx or anything else = can't tell, throw so caller retries
    throw new Error(`Validate returned ${res.status}`);
  }

  async getMessages(since: string, limit = 50): Promise<Array<{
    id: string;
    group_id: string;
    team_id: string;
    sender_user_id?: string;
    sender_agent_id?: string;
    sender_name?: string;
    sender_type?: string;
    content: string;
    message_type?: string;
    created_at: string;
    reply_to?: string | null;
  }>> {
    const data = await this.request<{ messages: any[] }>(
      `/api/agents/${this.agentId}/messages?since=${encodeURIComponent(since)}&limit=${limit}`,
    );
    return data.messages ?? [];
  }

  async getTeamContext(teamId: string): Promise<{
    channelDigest?: Array<{ channelName: string; channelType: string; recentMessages: Array<{ senderName: string; content: string; createdAt: string }> }>;
    playbook?: { version: number; content: string };
  } | null> {
    try {
      return await this.request(`/api/teams/${teamId}/context`);
    } catch {
      return null;
    }
  }

  async getPlaybook(teamId: string): Promise<{ version: number; content: string } | null> {
    const res = await fetch(`${this.baseUrl}/api/teams/${teamId}/playbook`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) return null;
    const data = await res.json() as { playbook?: { version: number; content: string } | null };
    return data.playbook ? { version: data.playbook.version, content: data.playbook.content } : null;
  }

  async uploadFile(groupId: string, buffer: Buffer, filename: string, mimeType: string): Promise<{ fileId: string }> {
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimeType }), filename);
    const url = `${this.baseUrl}/api/groups/${groupId}/files`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Fluffle API ${res.status}: upload file — ${body}`);
    }
    const data = await res.json() as { file_id?: string; fileId?: string };
    return { fileId: data.file_id ?? data.fileId ?? "" };
  }

  async pusherAuth(socketId: string, channelName: string): Promise<{ auth: string }> {
    const params = new URLSearchParams();
    params.set("socket_id", socketId);
    params.set("channel_name", channelName);
    const res = await fetch(`${this.baseUrl}/api/pusher/auth`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: params.toString(),
    });
    if (!res.ok) throw new Error(`Pusher auth failed: ${res.status}`);
    return res.json() as Promise<{ auth: string }>;
  }
}
