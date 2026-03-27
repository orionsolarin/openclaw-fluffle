import type { ResolvedFluffleAccount } from "./types.js";
import { FluffleApi } from "./api.js";
import { getFluffleRuntime } from "./runtime.js";
import type { RuntimeEnv } from "openclaw/plugin-sdk";

export type CycleTeamConfig = {
  teamId: string;
  teamName?: string;
  cadenceMs: number;
};

export class CycleEngine {
  private intervals = new Map<string, ReturnType<typeof setInterval>>();
  private account: ResolvedFluffleAccount;
  private runtime: RuntimeEnv;

  constructor(account: ResolvedFluffleAccount, runtime: RuntimeEnv) {
    this.account = account;
    this.runtime = runtime;
  }

  start(teams: Array<{ teamId: string; cadenceMs: number; teamName?: string }>): void {
    for (const team of teams) {
      if (this.intervals.has(team.teamId)) {
        clearInterval(this.intervals.get(team.teamId)!);
      }
      const interval = setInterval(() => {
        this.triggerNextCycle(team.teamId, team.teamName).catch((err) => {
          this.runtime.error?.(`[fluffle/cycle] Failed to trigger cycle for team ${team.teamId}: ${String(err)}`);
        });
      }, team.cadenceMs);
      this.intervals.set(team.teamId, interval);
      this.runtime.log?.(`[fluffle/cycle] Scheduled cycle engine for team ${team.teamId} every ${team.cadenceMs}ms`);
    }
  }

  stop(): void {
    for (const [teamId, interval] of this.intervals) {
      clearInterval(interval);
      this.runtime.log?.(`[fluffle/cycle] Stopped cycle engine for team ${teamId}`);
    }
    this.intervals.clear();
  }

  private async triggerNextCycle(teamId: string, teamName?: string): Promise<void> {
    const api = new FluffleApi(this.account);
    this.runtime.log?.(`[fluffle/cycle] Triggering next cycle for team ${teamId}`);

    // 1. POST to trigger the cycle
    const cycleInfo = await api.triggerCycle(teamId);
    this.runtime.log?.(`[fluffle/cycle] Cycle #${cycleInfo.cycleNumber} triggered for team ${teamId} — concern: "${cycleInfo.concernTitle}"`);

    // 2. GET last 10 cycles for previous TLDRs
    const cycles = await api.getCycles(teamId, 10);

    // 3. Format trigger message
    const previousTldrs = cycles
      .filter((c) => c.tldr || c.summary)
      .map((c) => `  - Cycle #${c.number ?? c.cycleNumber ?? "?"}: ${(c.tldr ?? c.summary ?? "").slice(0, 200)}`)
      .join("\n") || "  (none)";

    const latestCycle = cycles[0];
    const rawCarryForward = latestCycle?.carryForward ?? latestCycle?.carry_forward;
    const carryForwardText = rawCarryForward
      ? Array.isArray(rawCarryForward)
        ? rawCarryForward.map((i: string) => `  - ${i}`).join("\n")
        : String(rawCarryForward)
      : "  (none)";

    const resolvedTeamName = teamName ?? (cycleInfo as any).teamName ?? teamId;

    const message = [
      `[Cycle #${cycleInfo.cycleNumber} Starting]`,
      `Team: ${resolvedTeamName}`,
      `Focal Concern: ${cycleInfo.concernTitle} (iteration ${cycleInfo.iteration} of ${cycleInfo.iterationsAllowed})`,
      `Previous TLDRs:\n${previousTldrs}`,
      `Carry-forward:\n${carryForwardText}`,
    ].join("\n");

    this.runtime.log?.(`[fluffle/cycle] Injecting cycle trigger message for team ${teamId}:\n${message.slice(0, 300)}`);

    // 4. Inject into Agent 1's OpenClaw session as a system event
    const core = getFluffleRuntime();
    (core.channel as any).injectSystemEvent?.(message);
  }
}
