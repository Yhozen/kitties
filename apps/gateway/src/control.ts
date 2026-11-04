export interface Fence {
  kittyId: string;
  generation: number;
  remoteId: string;
  epoch: number;
}

export interface Grant extends Fence {
  nonce: string;
  clientId: string;
  expiresAt: number;
  lastInputAt: number;
  draining: boolean;
}

export function validGrant(
  grant: Grant | null,
  fence: Fence,
  clientId: string,
  nonce: string,
  now: number,
): grant is Grant {
  return (
    !!grant &&
    !grant.draining &&
    grant.expiresAt > now &&
    grant.nonce === nonce &&
    grant.clientId === clientId &&
    grant.kittyId === fence.kittyId &&
    grant.generation === fence.generation &&
    grant.remoteId === fence.remoteId &&
    grant.epoch === fence.epoch
  );
}

export function canGrant(agentInFlight: number, existing: Grant | null, now: number): boolean {
  return agentInFlight === 0 && (!existing || existing.expiresAt <= now);
}
