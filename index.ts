import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { FluffleClient } from "./src/client.js";
import type { FluffleConfig, FluffleMessage, FluffleGroup } from "./src/types.js";

let client: FluffleClient | null = null;
let pluginApi: OpenClawPluginApi | null = null;

// Track thinking state per group so we can emit heartbeats and stop
const thinkingTimers = new Map<string, ReturnType<typeof setInterval>>();

function startThinking(groupId: string, agentName: string, avatar?: string) {
  if (!client) return;
  // Don't double-start
  if (thinkingTimers.has(groupId)) return;
  
  client.emitThinkingStart(groupId, agentName, avatar);
  
  // Heartbeat every 3s to keep dots alive
  const interval = setInterval(() => {
    client?.emitThinkingHeartbeat(groupId);
  }, 3000);
  thinkingTimers.set(groupId, interval);
}

function stopThinking(groupId: string) {
  if (!client) return;
  const interval = thinkingTimers.get(groupId);
  if (interval) {
    clearInterval(interval);
    thinkingTimers.delete(groupId);
  }
  client.emitThinkingStop(groupId);
}

function parseConfig(raw: unknown): FluffleConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const cfg = raw as Record<string, unknown>;
  if (cfg.enabled === false) return null;
  if (!cfg.apiKey || !cfg.agentId) {
    console.warn('[fluffle] Missing required config (apiKey, agentId)');
    return null;
  }
  return {
    enabled: true,
    baseUrl: (cfg.baseUrl as string) || 'https://fluffle.ai',
    apiKey: cfg.apiKey as string,
    agentId: cfg.agentId as string,
  };
}

const plugin = {
  id: "fluffle",
  name: "Fluffle",
  description: "Connect to Fluffle AI agent team collaboration via WebSocket",

  configSchema: {
    parse(value: unknown): FluffleConfig | null {
      return parseConfig(value);
    },
  },

  async register(api: OpenClawPluginApi) {
    pluginApi = api;
    // api.config is the full OpenClaw config — extract plugin-specific config
    const fullCfg = api.config as Record<string, unknown>;
    const pluginCfg = (fullCfg as any)?.plugins?.entries?.fluffle?.config ?? fullCfg;
    console.log('[fluffle] Plugin config:', JSON.stringify(pluginCfg));
    const config = parseConfig(pluginCfg);
    if (!config) {
      console.log('[fluffle] Plugin disabled or not configured');
      return;
    }

    client = new FluffleClient(config);

    client.setMessageHandler(async (message: FluffleMessage, group: FluffleGroup) => {
      const sessionKey = `fluffle:${group.team_id}:${group.id}`;
      
      console.log(`[fluffle] Message from ${message.sender_name} in ${group.title}: ${message.content.slice(0, 80)}`);
      
      // Start thinking indicator — agent received the message
      startThinking(group.id, config.agentId);
      
      try {
        // Build context for the LLM
        const systemPrompt = [
          `You are in a Fluffle group chat "${group.title}" (team: ${group.team_name}).`,
          `Sender: ${message.sender_name} (${message.sender_type})`,
          `Group ID: ${group.id}`,
          `Use the fluffle_send tool to reply. groupId: ${group.id}`,
        ].join('\n');

        // Dispatch via subagent — bypasses channel system entirely
        const { runId } = await api.runtime.subagent.run({
          sessionKey,
          message: message.content,
          extraSystemPrompt: systemPrompt,
          deliver: false, // we handle delivery via fluffle_send tool
        });

        console.log(`[fluffle] Subagent dispatched: runId=${runId}, sessionKey=${sessionKey}`);
        
        // Wait for completion (up to 2 minutes)
        const result = await api.runtime.subagent.waitForRun({
          runId,
          timeoutMs: 120_000,
        });

        console.log(`[fluffle] Subagent result: status=${result.status}`);
        
        if (result.status === 'error') {
          console.error(`[fluffle] Subagent error: ${result.error}`);
        }
      } catch (err) {
        console.error(`[fluffle] Failed to dispatch message:`, err);
      } finally {
        // Always stop thinking when done
        stopThinking(group.id);
      }
    });

    try {
      await client.connect();
      const groups = client.getGroups();
      console.log(`[fluffle] Connected! Listening on ${groups.length} group(s): ${groups.map(g => g.title).join(', ')}`);
    } catch (err) {
      console.error('[fluffle] Failed to connect:', err);
    }

    // Register a tool for sending messages back to Fluffle
    api.registerTool?.({
      name: 'fluffle_send',
      description: 'Send a message to a Fluffle group chat',
      parameters: {
        type: 'object',
        properties: {
          groupId: { type: 'string', description: 'Fluffle group ID' },
          message: { type: 'string', description: 'Message content to send' },
        },
        required: ['groupId', 'message'],
      },
      async execute(params: { groupId: string; message: string }) {
        if (!client) throw new Error('Fluffle not connected');
        // Stop thinking indicator — we're about to send the response
        stopThinking(params.groupId);
        const id = await client.sendMessage(params.groupId, params.message);
        return { sent: true, messageId: id };
      },
    });
  },

  async unload() {
    // Clear all thinking timers
    for (const [, interval] of thinkingTimers) {
      clearInterval(interval);
    }
    thinkingTimers.clear();
    client?.disconnect();
    client = null;
    pluginApi = null;
  },
};

export default plugin;
