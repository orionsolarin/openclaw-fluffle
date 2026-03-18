export const FluffleConfigSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    enabled: { type: "boolean" },
    name: { type: "string" },
    apiKey: { type: "string" },
    agentId: { type: "string" },
    signingSecret: { type: "string" },
    baseUrl: { type: "string" },
    transport: { type: "string", enum: ["webhook", "pusher"] },
    pusher: {
      type: "object",
      properties: {
        key: { type: "string" },
        cluster: { type: "string" },
      },
    },
    dmPolicy: { type: "string", enum: ["pairing", "allowlist", "open", "disabled"] },
    allowFrom: { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } },
    groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
    groups: { type: "object", additionalProperties: true },
    messagePrefix: { type: "string" },
    responsePrefix: { type: "string" },
    defaultAccount: { type: "string" },
    accounts: { type: "object", additionalProperties: true },
  },
};
