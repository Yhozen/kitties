import type { ComputerState } from "./computer-state.ts";
import { TRANSFER_LEASE } from "./desktop-files-core.ts";

export interface FileLease {
  id: string;
  remoteId: string;
  generation: number;
  expiresAt: number;
}

export const liveFileLeases = (leases: FileLease[], now: number) =>
  leases.filter((lease) => lease.expiresAt > now);

export function newFileLease(
  state: ComputerState | null,
  leases: FileLease[],
  id: string,
  now: number,
): FileLease {
  if (!state?.remoteId || state.phase !== "ready" || state.operation)
    throw Error("COMPUTER_NOT_READY");

  if (liveFileLeases(leases, now).length >= 4) throw Error("FILE_TRANSFERS_BUSY");

  return {
    id,
    remoteId: state.remoteId,
    generation: state.generation,
    expiresAt: now + TRANSFER_LEASE,
  };
}

export function validFileLease(
  state: ComputerState | null,
  lease: FileLease | undefined,
  now: number,
) {
  return (
    !!lease &&
    lease.expiresAt > now &&
    state?.phase === "ready" &&
    !state.operation &&
    state.remoteId === lease.remoteId &&
    state.generation === lease.generation
  );
}
