/** Kitties video v1: generation (u32 BE), then voxl 0.3.2's 16-byte
 * single-stripe video header and Annex-B H.264. No input/media side channels. */
export const VIDEO_HEADER_BYTES = 20;
export const MAX_VIDEO_BYTES = 1024 * 1024;

export interface VideoHeader {
  generation: number;
  seq: number;
  key: boolean;
  pipelineMs: number;
}

export function videoHeader(bytes: Uint8Array): VideoHeader | undefined {
  if (
    bytes.byteLength <= VIDEO_HEADER_BYTES ||
    bytes.byteLength > MAX_VIDEO_BYTES ||
    bytes[4] !== 1 ||
    bytes[14] !== 0 ||
    bytes[16] !== 1
  )
    return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return {
    generation: view.getUint32(0),
    seq: view.getUint32(6),
    key: (bytes[5] & 1) !== 0,
    pipelineMs: view.getUint32(10) / 10,
  };
}

/** Serializable in a hibernating WebSocket attachment. Every skipped delta
 * invalidates this viewer's decode chain until a new keyframe is delivered. */
export interface VideoFlow {
  waitingKey: boolean;
  inflight: Array<{ seq: number; bytes: number; at: number }>;
  rttMs?: number;
  jitterMs?: number;
}

export const MAX_VIDEO_FRAMES = 32;

export const freshVideoFlow = (previous?: VideoFlow): VideoFlow => ({
  waitingKey: true,
  inflight: [],
  ...(previous?.rttMs === undefined ? {} : { rttMs: previous.rttMs, jitterMs: previous.jitterMs }),
});

export function videoFrameLimit(flow: VideoFlow) {
  if (flow.rttMs === undefined) return 8;
  // voxl captures at 60 fps. Allow for measured RTT variation plus two frames of
  // scheduling slack. This is a credit limit, not a queue we try to fill.
  const budget = Math.ceil(((flow.rttMs + 4 * (flow.jitterMs ?? 0)) * 60) / 1000) + 2;

  return Number.isFinite(budget) ? Math.min(MAX_VIDEO_FRAMES, Math.max(8, budget)) : 8;
}

export function offerVideo(flow: VideoFlow, frame: VideoHeader, bytes: number, now: number) {
  if (flow.inflight.length && now - flow.inflight[0].at > 5000) return "close" as const;

  if (
    flow.inflight.length >= videoFrameLimit(flow) ||
    flow.inflight.reduce((sum, item) => sum + item.bytes, 0) + bytes > 2 * MAX_VIDEO_BYTES
  ) {
    flow.waitingKey = true;

    return "skip" as const;
  }

  if (flow.waitingKey && !frame.key) return "keyframe" as const;
  flow.waitingKey = false;
  flow.inflight.push({ seq: frame.seq, bytes, at: now });

  return "send" as const;
}

export function acknowledgeVideo(flow: VideoFlow, seq: number, now: number) {
  const index = flow.inflight.findIndex((frame) => frame.seq === seq);

  if (index < 0) return false;
  const sample = now - flow.inflight[index].at;

  if (sample >= 0 && sample <= 5000) {
    const previous = flow.rttMs;
    const round = (value: number) => Math.round(value * 10) / 10;
    flow.rttMs = round(previous === undefined ? sample : previous * 0.875 + sample * 0.125);
    flow.jitterMs = round(
      previous === undefined
        ? sample / 2
        : (flow.jitterMs ?? 0) * 0.75 + Math.abs(previous - sample) * 0.25,
    );
  }

  flow.inflight.splice(0, index + 1);

  return true;
}
