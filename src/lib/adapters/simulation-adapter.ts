import type { OnOff } from "@/lib/state/types";
import { AdapterEmitter, type AdapterListener, type CommandContext, type CommandOutcome, type LightAdapter } from "./types";

/**
 * In-browser simulation. Never touches a network or hardware. Every outcome is
 * explicitly labelled "simulated".
 */
export class SimulationAdapter implements LightAdapter {
  readonly mode = "simulation" as const;
  readonly label = "In-browser simulation (no hardware)";
  readonly feedbackAvailable = false;
  private emitter = new AdapterEmitter();
  private disposed = false;

  constructor(private readonly latencyMs = 140) {}

  async send(value: OnOff, _ctx: CommandContext): Promise<CommandOutcome> {
    if (this.disposed) throw new Error("Simulation adapter disposed");
    await new Promise((r) => setTimeout(r, this.latencyMs));
    return { phase: "simulated", detail: `Simulated lamp switched ${value.toUpperCase()} — no hardware involved.` };
  }

  async refreshState(): Promise<void> {
    /* nothing to read in simulation */
  }

  subscribe(listener: AdapterListener): () => void {
    return this.emitter.subscribe(listener);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.emitter.clear();
  }
}
