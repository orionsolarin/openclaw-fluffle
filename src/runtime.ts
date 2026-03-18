import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

let _runtime: OpenClawPluginApi["runtime"] | null = null;

export function setFluffleRuntime(runtime: OpenClawPluginApi["runtime"]): void {
  _runtime = runtime;
}

export function getFluffleRuntime() {
  if (!_runtime) {
    throw new Error("fluffle runtime not initialized");
  }
  return _runtime;
}
