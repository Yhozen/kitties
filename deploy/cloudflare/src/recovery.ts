export interface RecoveryOperation {
  id: string;
  snapshot: string;
  previous: string;
  target: string;
  phase:
    | "preflight"
    | "releasing"
    | "retiring"
    | "activating"
    | "complete"
    | "failed";
  startedAt: string;
  error?: string;
}
export interface RecoveryStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  sync(): Promise<void>;
}
export interface RecoveryGateway {
  preflight(
    id: string,
    snapshot: string,
  ): Promise<"pending" | "ready" | "failed">;
  release(id: string): Promise<void>;
  retire(): Promise<void>;
  activate(id: string, snapshot: string): Promise<void>;
  restart(): Promise<void>;
}
export class RecoveryConflict extends Error {}

export class RecoveryCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly storage: RecoveryStorage,
    private readonly gateway: (generation: string) => RecoveryGateway,
    private readonly wake: (delay: number) => Promise<void>,
  ) {}
  async active(): Promise<string> {
    return (await this.storage.get<string>("active")) ?? "initial";
  }
  async status(): Promise<{ active: string; operation?: RecoveryOperation }> {
    return {
      active: await this.active(),
      operation: await this.storage.get<RecoveryOperation>("operation"),
    };
  }
  restore(id: string, snapshot: string): Promise<RecoveryOperation> {
    return this.exclusive(async () => {
      const existing = await this.storage.get<RecoveryOperation>(
        `operation:${id}`,
      );
      if (existing) {
        if (existing.snapshot !== snapshot)
          throw new RecoveryConflict(
            "Operation ID already names another snapshot",
          );
        return existing;
      }
      const current = await this.storage.get<RecoveryOperation>("operation");
      if (current && current.phase !== "complete" && current.phase !== "failed")
        throw new RecoveryConflict("A gateway recovery is already in progress");
      const operation: RecoveryOperation = {
        id,
        snapshot,
        previous: await this.active(),
        target: `recovery-${id}`,
        phase: "preflight",
        startedAt: new Date().toISOString(),
      };
      await this.save(operation);
      await this.wake(1);
      return operation;
    });
  }
  restart(): Promise<void> {
    return this.exclusive(async () => {
      const operation = await this.storage.get<RecoveryOperation>("operation");
      if (
        operation &&
        operation.phase !== "complete" &&
        operation.phase !== "failed"
      )
        throw new RecoveryConflict("A gateway recovery is already in progress");
      await this.gateway(await this.active()).restart();
    });
  }
  advance(): Promise<void> {
    return this.exclusive(async () => {
      const operation = await this.storage.get<RecoveryOperation>("operation");
      if (
        !operation ||
        operation.phase === "complete" ||
        operation.phase === "failed"
      )
        return;
      try {
        if (operation.phase === "preflight") {
          const result = await this.gateway(operation.previous).preflight(
            operation.id,
            operation.snapshot,
          );
          if (result === "pending") {
            await this.wake(5_000);
            return;
          }
          if (result === "failed") {
            await this.save({ ...operation, phase: "releasing" });
            await this.wake(1);
            return;
          }
          await this.save({
            ...operation,
            phase: "retiring",
            error: undefined,
          });
        } else if (operation.phase === "releasing") {
          await this.gateway(operation.previous).release(operation.id);
          await this.save({
            ...operation,
            phase: "failed",
            error:
              "Recovery verification failed; the current gateway is unchanged.",
          });
          return;
        } else if (operation.phase === "retiring") {
          await this.gateway(operation.previous).retire();
          await this.save({
            ...operation,
            phase: "activating",
            error: undefined,
          });
        } else {
          await this.gateway(operation.target).activate(
            operation.id,
            operation.snapshot,
          );
          await this.save(
            { ...operation, phase: "complete", error: undefined },
            operation.target,
          );
        }
        await this.wake(1);
      } catch {
        if (operation.phase === "preflight") {
          await this.save({
            ...operation,
            phase: "releasing",
            error:
              "Recovery verification failed; releasing the maintenance freeze.",
          });
          await this.wake(1);
        } else {
          await this.save({
            ...operation,
            error:
              "Recovery is waiting for the cloud runtime; it will retry automatically.",
          });
          await this.wake(60_000);
        }
      }
    });
  }
  private async save(
    operation: RecoveryOperation,
    active?: string,
  ): Promise<void> {
    await this.storage.put({
      operation,
      [`operation:${operation.id}`]: operation,
      ...(active ? { active } : {}),
    });
    await this.storage.sync();
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
