export type ComputerPhase =
  | "absent"
  | "starting"
  | "ready"
  | "draining"
  | "archiving"
  | "sleeping"
  | "restoring"
  | "deleting"
  | "deleted"
  | "attention";
export interface ComputerOperation {
  id: string;
  kind: "start" | "sleep" | "restore" | "delete" | "upgrade";
  at: number;
  generation: number;
  key?: string;
  body?: string;
  sourceCheckpointId?: string;
}
export interface ComputerState {
  kittyId: string;
  generation: number;
  phase: ComputerPhase;
  remoteId?: string;
  tokenVersion: number;
  previousIds: string[];
  operation?: ComputerOperation;
  receipt?: { remoteId: string; generation: number; key: string; body: string; at: number };
  quiesced?: { remoteId: string; generation: number; at: number };
  checkpoint?: {
    name: string;
    snapshotId: string;
    sourceRemoteId: string;
    generation: number;
    quiesced: boolean;
    at: number;
  };
  lastRenewAt: number;
  lastActiveAt: number;
  failureCount: number;
}
export const freshComputer = (kittyId: string, now: number): ComputerState => ({
  kittyId,
  generation: 1,
  phase: "absent",
  tokenVersion: 0,
  previousIds: [],
  lastRenewAt: 0,
  lastActiveAt: now,
  failureCount: 0,
});
export function beginOperation(
  previous: ComputerState,
  id: string,
  kind: ComputerOperation["kind"],
  at: number,
): ComputerState {
  if (previous.operation) {
    if (previous.operation.id === id && previous.operation.kind === kind) return previous;
    throw Error("COMPUTER_BUSY");
  }
  if (kind === "restore" && !previous.checkpoint) throw Error("CHECKPOINT_REQUIRED");
  if ((kind === "start" || kind === "upgrade") && previous.phase === "sleeping")
    throw Error("USE_RESTORE");
  if ((kind === "sleep" || kind === "delete") && !previous.remoteId) throw Error("COMPUTER_ABSENT");
  if (kind === "start" && previous.phase === "ready") return previous;
  const recreate = previous.phase === "deleted" && (kind === "start" || kind === "upgrade");
  const generation = previous.generation + (kind === "restore" || recreate ? 1 : 0);
  return {
    ...previous,
    ...(recreate
      ? {
          remoteId: undefined,
          receipt: undefined,
          quiesced: undefined,
          previousIds: [
            ...new Set([
              ...previous.previousIds,
              ...(previous.remoteId ? [previous.remoteId] : []),
            ]),
          ],
        }
      : {}),
    generation,
    tokenVersion: previous.tokenVersion + 1,
    phase:
      kind === "restore"
        ? "restoring"
        : kind === "start" || kind === "upgrade"
          ? "starting"
          : "draining",
    operation: { id, kind, at, generation },
  };
}
export const canMutate = (state: ComputerState, id: string) => state.operation?.id === id;
