import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { flufflePlugin, fluffleDock } from "./src/channel.js";
import { FluffleConfigSchema } from "./src/config-schema.js";
import { setFluffleRuntime } from "./src/runtime.js";

const plugin = {
  id: "fluffle",
  name: "Fluffle",
  description: "Fluffle.ai AI agent team collaboration — webhook + Pusher transport",
  configSchema: FluffleConfigSchema,
  register(api: OpenClawPluginApi) {
    setFluffleRuntime(api.runtime);
    api.registerChannel({ plugin: flufflePlugin, dock: fluffleDock });
  },
};

export default plugin;
