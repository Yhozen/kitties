import { describe, expect, test } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  acknowledgeVideo,
  freshVideoFlow,
  offerVideo,
  videoFrameLimit,
  videoHeader,
  type VideoHeader,
} from "./video.ts";

const wireFrame = new Uint8Array([
  1, 2, 3, 4, 1, 1, 17, 34, 51, 68, 0, 0, 0, 123, 0, 0, 1, 0, 0, 0, 0, 0, 1, 101,
]);

const frame = (seq: number, key = false): VideoHeader => ({
  generation: 1,
  seq,
  key,
  pipelineMs: 0,
});

describe("video packet boundary", () => {
  test("reads the wire header from a view with a nonzero byte offset", () => {
    const storage = new Uint8Array(wireFrame.length + 9);
    storage.set(wireFrame, 5);

    expect(videoHeader(storage.subarray(5, 5 + wireFrame.length))).toEqual({
      generation: 0x01020304,
      seq: 0x11223344,
      key: true,
      pipelineMs: 12.3,
    });
  });

  test("rejects incomplete headers, empty payloads and packets over one MiB", () => {
    const largest = new Uint8Array(1024 * 1024);
    largest.set(wireFrame);
    const oversized = new Uint8Array(1024 * 1024 + 1);
    oversized.set(wireFrame);

    expect(videoHeader(wireFrame.subarray(0, 19))).toBeUndefined();
    expect(videoHeader(wireFrame.subarray(0, 20))).toBeUndefined();
    expect(videoHeader(largest)).toBeDefined();
    expect(videoHeader(oversized)).toBeUndefined();
  });

  test.each([
    { field: "non-video channel", offset: 4, value: 2 },
    { field: "second stripe", offset: 14, value: 1 },
    { field: "multiple stripes", offset: 16, value: 2 },
  ])("rejects $field", ({ offset, value }) => {
    const bytes = wireFrame.slice();
    bytes[offset] = value;

    expect(videoHeader(bytes)).toBeUndefined();
  });
});

describe("viewer decode chain and credits", () => {
  test("starts at a keyframe and requests one without spending delta credits", () => {
    const flow = freshVideoFlow();

    expect(offerVideo(flow, frame(1), 100, 1000)).toBe("keyframe");
    expect(flow.inflight).toEqual([]);
    expect(offerVideo(flow, frame(2, true), 100, 1000)).toBe("send");
    expect(offerVideo(flow, frame(3), 100, 1000)).toBe("send");
    expect(flow.inflight.map((packet) => packet.seq)).toEqual([2, 3]);
  });

  test("requires a new keyframe after congestion drops a delta, even when an ack frees credits", () => {
    const flow = freshVideoFlow();

    for (let seq = 1; seq <= 8; seq++)
      expect(offerVideo(flow, frame(seq, seq === 1), 100, 1000)).toBe("send");

    expect(offerVideo(flow, frame(9), 100, 1000)).toBe("skip");
    expect(acknowledgeVideo(flow, 4, 1000)).toBe(true);
    expect(offerVideo(flow, frame(10), 100, 1000)).toBe("keyframe");
    expect(offerVideo(flow, frame(11, true), 100, 1000)).toBe("send");
    expect(flow.inflight.map((packet) => packet.seq)).toEqual([5, 6, 7, 8, 11]);
  });

  test("caps outstanding bytes at two MiB independently of available frame credits", () => {
    const flow = freshVideoFlow();

    expect(offerVideo(flow, frame(1, true), 1024 * 1024, 1000)).toBe("send");
    expect(offerVideo(flow, frame(2), 1024 * 1024, 1000)).toBe("send");
    expect(offerVideo(flow, frame(3), 1, 1000)).toBe("skip");
    expect(flow.inflight.map((packet) => packet.seq)).toEqual([1, 2]);
  });

  test("acks cumulatively and ignores repeated or unsent sequence numbers", () => {
    const flow = freshVideoFlow();
    offerVideo(flow, frame(1, true), 400, 1000);
    offerVideo(flow, frame(2), 500, 1000);
    offerVideo(flow, frame(3), 600, 1000);

    expect(acknowledgeVideo(flow, 2, 1100)).toBe(true);
    expect(flow.inflight).toEqual([{ seq: 3, bytes: 600, at: 1000 }]);
    expect(flow.rttMs).toBe(100);
    expect(flow.jitterMs).toBe(50);
    expect(acknowledgeVideo(flow, 2, 1200)).toBe(false);
    expect(acknowledgeVideo(flow, 99, 1200)).toBe(false);
    expect(flow.inflight).toEqual([{ seq: 3, bytes: 600, at: 1000 }]);
    expect(flow.rttMs).toBe(100);
    expect(flow.jitterMs).toBe(50);
  });

  test("closes a stalled viewer only after the five-second acknowledgement deadline", () => {
    const flow = freshVideoFlow();
    offerVideo(flow, frame(1, true), 100, 1000);

    expect(offerVideo(flow, frame(2), 100, 6000)).toBe("send");
    expect(offerVideo(flow, frame(3), 100, 6001)).toBe("close");
    expect(flow.inflight.map((packet) => packet.seq)).toEqual([1, 2]);
  });

  test("restarts the decode chain without losing latency estimates or retaining old credit debt", () => {
    const previous = freshVideoFlow();
    offerVideo(previous, frame(1, true), 100, 1000);
    acknowledgeVideo(previous, 1, 1100);
    offerVideo(previous, frame(2), 100, 1100);
    const restarted = freshVideoFlow(previous);

    expect(restarted.inflight).toEqual([]);
    expect(restarted.rttMs).toBe(100);
    expect(restarted.jitterMs).toBe(50);
    expect(videoFrameLimit(restarted)).toBe(20);
    expect(offerVideo(restarted, frame(3), 100, 1100)).toBe("keyframe");
    expect(previous.inflight.map((packet) => packet.seq)).toEqual([2]);
  });

  it.effect.prop(
    "unknown acknowledgements cannot release a full viewer's credits",
    [Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 1000000 }))],
    ([unknownSeq]) =>
      Effect.sync(() => {
        const flow = freshVideoFlow();

        for (let seq = 1; seq <= 8; seq++) offerVideo(flow, frame(seq, seq === 1), 100, 1000);

        expect(acknowledgeVideo(flow, unknownSeq, 1000)).toBe(false);
        expect(offerVideo(flow, frame(9), 100, 1000)).toBe("skip");
        expect(flow.inflight.map((packet) => packet.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      }),
    { arbitrary: { runs: 100, seed: "video-unknown-ack-v1" } },
  );
});
