export interface Intent {
  id: string;
  generation: number;
  epoch: number;
  deadline: number;
}
export type Receipt = { status: "completed" | "unknown"; result?: string };
// The map represents guest disk, and deliberately survives construction of a new daemon.
export class FakeKittyd {
  readonly effects: string[] = [];
  constructor(
    readonly disk = new Map<string, Receipt>(),
    readonly generation = 1,
    readonly epoch = 1,
  ) {}
  dispatch(intent: Intent, killAfterEffect = false): Receipt {
    if (
      intent.generation !== this.generation ||
      intent.epoch !== this.epoch ||
      intent.deadline <= Date.now()
    )
      throw new Error("FENCED");
    const saved = this.disk.get(intent.id);
    if (saved) return saved;
    this.disk.set(intent.id, { status: "unknown" });
    this.effects.push(intent.id);
    if (killAfterEffect) throw new Error("CONNECTION_LOST");
    const receipt: Receipt = { status: "completed", result: "ok" };
    this.disk.set(intent.id, receipt);
    return receipt;
  }
  reconcile(id: string) {
    return this.disk.get(id);
  }
}
