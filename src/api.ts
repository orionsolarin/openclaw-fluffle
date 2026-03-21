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

  async sendMessage(groupId: string, content: string): Promise<{ id: string }> {
    return this.request<{ id: string }>(`/api/groups/${groupId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, message_type: "text" }),
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

  async getGroups(): Promise<Array<{ id: string; title: string; team_id: string }>> {
    const data = await this.request<{ groups: Array<{ group_id?: string; id?: string; title: string; team_id: string }> }>(
      `/api/agents/${this.agentId}/groups`,
    );
    // Normalize: API returns group_id, plugin expects id
    return data.groups.map((g) => ({
      id: g.group_id ?? g.id ?? "",
      title: g.title,
      team_id: g.team_id,
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

  async searchMessages(q: string, limit = 20, offset = 0): Promise<{
    messages: Array<{
      id: string;
      content: string;
      snippet: string;
      group_id: string;
      group_title: string;
      team_id: string;
      sender_name: string | null;
      sender_agent_id: string | null;
      sender_user_id: string | null;
      created_at: string;
    }>;
    total: number;
  }> {
    return this.request(
      `/api/agents/${this.agentId}/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`,
    );
  }

  async getRecentMessages(hours: number, limit = 50, groupId?: string): Promise<Array<{
    id: string;
    group_id: string;
    group_title: string;
    content: string;
    message_type: string;
    sender_agent_id: string | null;
    sender_user_id: string | null;
    sender_name: string | null;
    reply_to_id: string | null;
    created_at: string;
  }>> {
    const params = new URLSearchParams({ hours: String(hours), limit: String(limit) });
    if (groupId) params.set('group_id', groupId);
    const data = await this.request<{ messages: any[] }>(
      `/api/agents/${this.agentId}/messages?${params}`,
    );
    return data.messages ?? [];
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

  async getPlaybook(teamId: string): Promise<{ version: number; content: string } | null> {
    const res = await fetch(`${this.baseUrl}/api/teams/${teamId}/playbook`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) return null;
    const data = await res.json() as { playbook?: { version: number; content: string } | null };
    return data.playbook ? { version: data.playbook.version, content: data.playbook.content } : null;
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
