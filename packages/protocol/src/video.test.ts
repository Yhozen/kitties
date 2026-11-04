import { describe, expect, it } from "vitest";
import {
  acknowledgeVideo,
  freshVideoFlow,
  offerVideo,
  videoHeader,
  MAX_VIDEO_BYTES,
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
      acknowledgeVideo(fast, seq);
    }
    expect(offerVideo(slow, frame(9), 200, 10)).toBe("skip");
    expect(offerVideo(fast, frame(9), 200, 10)).toBe("send");
    expect(acknowledgeVideo(slow, 999)).toBe(false);
    expect(acknowledgeVideo(slow, 8)).toBe(true);
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
    acknowledgeVideo(restored, 2);
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
