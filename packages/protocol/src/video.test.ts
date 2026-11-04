import { describe, expect, it } from "vitest";
import {
  acknowledgeVideo,
  freshVideoFlow,
  offerVideo,
  videoHeader,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_FRAMES,
  videoFrameLimit,
} from "./video.ts";
const frame = (seq: number, key = false) => ({ generation: 4, seq, key, pipelineMs: 2 });

describe("video viewer backpressure", () => {
  it("requires a keyframe on admission and after any dropped delta", () => {
    const slow = freshVideoFlow(),
      fast = freshVideoFlow();
    expect(offerVideo(slow, frame(0), 200, 0)).toBe("keyframe");
    for (let seq = 1; seq <= 8; seq++) {
      expect(offerVideo(slow, frame(seq, seq === 1), 200, seq)).toBe("send");
      expect(offerVideo(fast, frame(seq, seq === 1), 200, seq)).toBe("send");
      acknowledgeVideo(fast, seq, seq);
    }
    expect(offerVideo(slow, frame(9), 200, 10)).toBe("skip");
    expect(offerVideo(fast, frame(9), 200, 10)).toBe("send");
    expect(acknowledgeVideo(slow, 999, 11)).toBe(false);
    expect(acknowledgeVideo(slow, 8, 11)).toBe(true);
    expect(offerVideo(slow, frame(10), 200, 12)).toBe("keyframe");
    expect(offerVideo(slow, frame(11, true), 200, 13)).toBe("send");
    expect(offerVideo(slow, frame(12), 200, 14)).toBe("send");
  });
  it("bounds both buffered bytes and the lifetime of unacknowledged frames", () => {
    const flow = freshVideoFlow();
    expect(offerVideo(flow, frame(1, true), MAX_VIDEO_BYTES, 1)).toBe("send");
    expect(offerVideo(flow, frame(2), MAX_VIDEO_BYTES, 2)).toBe("send");
    expect(offerVideo(flow, frame(3), 1, 3)).toBe("skip");
    expect(offerVideo(flow, frame(4, true), 1, 5002)).toBe("close");
  });
  it("survives hibernation without losing decoder/ack state", () => {
    const flow = freshVideoFlow();
    offerVideo(flow, frame(1, true), 1000, 1);
    offerVideo(flow, frame(2), 1000, 2);
    const restored = JSON.parse(JSON.stringify(flow));
    acknowledgeVideo(restored, 2, 3);
    expect(restored.inflight).toEqual([]);
    expect(offerVideo(restored, frame(3), 1000, 101)).toBe("send");
    // Resetting the decoder must not retain a reference chain from the old session.
    expect(offerVideo(freshVideoFlow(), frame(3), 1000, 101)).toBe("keyframe");
  });
});
it("only accepts bounded single-stripe voxl video, with explicit generation", () => {
  const packet = new Uint8Array(25),
    view = new DataView(packet.buffer);
  view.setUint32(0, 4);
  packet[4] = 1;
  packet[5] = 1;
  view.setUint32(6, 42);
  view.setUint32(10, 25);
  packet[16] = 1;
  expect(videoHeader(packet)).toEqual({ generation: 4, seq: 42, key: true, pipelineMs: 2.5 });
  for (const [offset, value] of [
    [4, 3],
    [14, 1],
    [16, 2],
  ]) {
    const bad = packet.slice();
    bad[offset] = value;
    expect(videoHeader(bad)).toBeUndefined();
  }
  expect(videoHeader(packet.slice(0, 20))).toBeUndefined();
  expect(videoHeader(new Uint8Array(MAX_VIDEO_BYTES + 1))).toBeUndefined();
});

it("learns acknowledgement delay without trusting unknown acks and keeps hard limits", () => {
  const flow = freshVideoFlow();
  expect(videoFrameLimit(flow)).toBe(8);
  offerVideo(flow, frame(1, true), 1000, 100);
  expect(acknowledgeVideo(flow, 999, 300)).toBe(false);
  expect(flow.rttMs).toBeUndefined();
  acknowledgeVideo(flow, 1, 300);
  expect(flow.rttMs).toBe(200);
  expect(videoFrameLimit(flow)).toBeGreaterThan(12);
  const reset = freshVideoFlow(flow);
  expect(reset.inflight).toEqual([]);
  expect(reset.waitingKey).toBe(true);
  expect(reset.rttMs).toBe(200);
  expect(offerVideo(reset, frame(2), 1000, 301)).toBe("keyframe");
  // A delayed/forged client may at most expand to the hard ceiling, never an
  // unbounded array or a WebSocket attachment larger than Cloudflare's 2 KiB cap.
  reset.rttMs = 4999.9;
  reset.jitterMs = 2499.9;
  for (let i = 0; i < MAX_VIDEO_FRAMES; i++) {
    expect(offerVideo(reset, frame(4294967295 - i, i === 0), 50000, 1793765667000)).toBe("send");
  }
  expect(offerVideo(reset, frame(9), 50000, 1793765667001)).toBe("skip");
  expect(
    JSON.stringify({
      role: "video-viewer",
      clientId: "x".repeat(36),
      epoch: Number.MAX_SAFE_INTEGER,
      video: reset,
      keyframeAt: 1793765667000,
      count: 120,
      window: 1793765667000,
    }).length,
  ).toBeLessThanOrEqual(2048);
  expect(offerVideo(reset, frame(10, true), 1, 1793765672001)).toBe("close");
});

it.each([100, 200, 350])("sustains a 60 fps source after learning %i ms RTT with jitter", (rtt) => {
  const flow = freshVideoFlow();
  const acks: Array<{ seq: number; at: number }> = [];
  let seq = 0,
    lastKey = -1000,
    lastAckAt = 0,
    sent = 0,
    offered = 0;
  for (let now = 0; now < 6000; now++) {
    while (acks[0]?.at <= now) acknowledgeVideo(flow, acks.shift()!.seq, now);
    if (now % 16 !== 0) continue;
    const key = seq === 0 || (flow.waitingKey && now - lastKey >= 500);
    if (key) lastKey = now;
    const outcome = offerVideo(flow, frame(seq++, key), 5000, now);
    if (now >= 2000) offered++;
    if (outcome === "send") {
      if (now >= 2000) sent++;
      lastAckAt = Math.max(lastAckAt + 1, now + rtt + 20 * Math.sin(now / 100));
      acks.push({ seq: seq - 1, at: lastAckAt });
    }
    expect(flow.inflight.length).toBeLessThanOrEqual(MAX_VIDEO_FRAMES);
  }
  expect(sent / offered).toBeGreaterThan(0.98);
});
