type Input = { action: string; args: Record<string, unknown>; control: string; bytes: number };

// One ordered, bounded queue per viewer. A grant never inherits another grant's input.
export class DesktopInputQueue {
  control = "";
  private pending: Input[] = [];
  private current?: Input;
  private running = false;
  private disposed = false;

  constructor(
    private send: (
      control: string,
      action: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>,
    private changed: (count: number) => void,
    private completed: () => void,
    private failed: (error: unknown, control: string) => void,
  ) {}

  open(control: string) {
    this.pending = [];
    this.control = control;
    this.notify();
  }

  close() {
    const control = this.control;
    this.open("");
    return control;
  }

  dispose() {
    this.disposed = true;
    return this.close();
  }

  enqueue(action: string, args: Record<string, unknown>): boolean {
    if (!this.control || this.disposed) return false;
    const bytes = new TextEncoder().encode(JSON.stringify(args)).length;
    const queued = this.pending.reduce(
      (size, input) => size + input.bytes,
      this.current?.bytes ?? 0,
    );
    if (this.pending.length + Number(!!this.current) >= 32 || queued + bytes > 16 * 1024)
      return false;
    this.pending.push({ action, args, control: this.control, bytes });
    this.notify();
    void this.drain();
    return true;
  }

  private notify() {
    if (!this.disposed)
      this.changed(this.pending.length + Number(this.current?.control === this.control));
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length && !this.disposed) {
        const input = this.pending.shift()!;
        if (input.control !== this.control) continue;
        this.current = input;
        try {
          await this.send(input.control, input.action, input.args);
          if (this.control === input.control && !this.disposed) this.completed();
        } catch (error) {
          if (this.control === input.control && !this.disposed) {
            this.close();
            this.failed(error, input.control);
          }
        } finally {
          this.current = undefined;
          this.notify();
        }
      }
    } finally {
      this.running = false;
    }
  }
}
