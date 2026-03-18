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

  async sendMessage(groupId: string, content: string): Promise<{ id: string }> {
    return this.request<{ id: string }>(`/api/groups/${groupId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, message_type: "text" }),
    });
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
