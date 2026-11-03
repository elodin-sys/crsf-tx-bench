import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildOutputs } from "./controls";
import {
  CRSF_ADDRESS_MODULE,
  CRSF_CHANNEL_MID,
  CRSF_SYNC,
  CrsfParser,
  buildModelIdFrame,
  buildPingFrame,
  buildRcFrame,
  crc8,
  emptyTelemetry,
  noteFrame,
  unpackChannels,
  usToCrsf,
} from "./crsf";

describe("crc8", () => {
  it("matches the EdgeTX DVB-S2 table", () => {
    const expected = [0x00, 0xd5, 0x7f, 0xaa, 0xfe, 0x2b, 0x81, 0x54];
    expected.forEach((value, index) => {
      assert.equal(crc8(Uint8Array.of(index)), value);
    });
  });

  it("matches the EdgeTX command polynomial on the first bytes", () => {
    assert.equal(crc8(Uint8Array.of(0x00), 0xba), 0x00);
    assert.equal(crc8(Uint8Array.of(0x01), 0xba), 0xba);
  });
});

describe("channel scaling", () => {
  it("centers 1500 µs on CRSF 992", () => {
    assert.equal(usToCrsf(1500), CRSF_CHANNEL_MID);
  });

  it("uses the EdgeTX endpoints", () => {
    assert.equal(usToCrsf(988), 173);
    assert.equal(usToCrsf(2012), 1811);
    assert.equal(usToCrsf(1000), 192);
  });
});

describe("frames", () => {
  it("round-trips 16 channels through a classic RC frame", () => {
    const channels = Array.from({ length: 16 }, (_, index) => 200 + index * 40);
    const frame = buildRcFrame(channels);
    assert.equal(frame.length, 26);
    assert.equal(frame[0], CRSF_ADDRESS_MODULE);
    assert.equal(frame[1], 24);
    assert.equal(frame[2], 0x16);
    assert.equal(frame[25], crc8(frame.subarray(2, 25)));

    const parsed: number[][] = [];
    const parser = new CrsfParser();
    parser.push(frame, (found) => parsed.push(unpackChannels(found.payload)));
    assert.deepEqual(parsed, [channels]);
  });

  it("builds an EdgeTX model-id command and a broadcast ping", () => {
    const model = buildModelIdFrame(7);
    assert.equal(model[0], CRSF_SYNC);
    assert.equal(model[1], 8);
    assert.equal(model[2], 0x32);
    assert.equal(model[3], CRSF_ADDRESS_MODULE);
    assert.equal(model[4], 0xea);
    assert.equal(model[5], 0x10);
    assert.equal(model[6], 0x05);
    assert.equal(model[7], 7);
    assert.equal(model[9], crc8(model.subarray(2, 9)));

    const ping = buildPingFrame();
    assert.deepEqual(Array.from(ping.subarray(0, 5)), [0xc8, 4, 0x28, 0x00, 0xea]);
    assert.equal(ping[5], crc8(ping.subarray(2, 5)));

    const frames: number[] = [];
    const parser = new CrsfParser();
    parser.push(concat(model, ping), (frame) => frames.push(frame.type));
    assert.deepEqual(frames, [0x32, 0x28]);
  });
});

describe("telemetry", () => {
  it("reads link statistics and ignores our own channel frames", () => {
    const payload = Uint8Array.of(80, 0, 95, 0xfe, 1, 4, 5, 70, 90, 5);
    let state = noteFrame(emptyTelemetry(), {
      sync: CRSF_SYNC,
      type: 0x14,
      payload,
    });
    state = noteFrame(state, {
      sync: CRSF_ADDRESS_MODULE,
      type: 0x16,
      payload: new Uint8Array(22),
    });
    assert.equal(state.moduleFrames, 1);
    assert.equal(state.link?.uplinkRssiDbm, -80);
    assert.equal(state.link?.uplinkLq, 95);
    assert.equal(state.link?.uplinkSnr, -2);
    assert.equal(state.link?.txPowerMw, 1000);
    assert.equal(state.link?.antenna, 2);
    assert.equal(state.link?.downlinkLq, 90);
  });
});

describe("outputs", () => {
  it("keeps a disarmed quad at low throttle and low channel 5", () => {
    const outputs = buildOutputs(
      { roll: 0, pitch: 0, yaw: 0, throttle: 0 },
      [0, 0, 0],
      false,
      { roll: false, pitch: false, yaw: false, throttle: false },
    );
    assert.equal(outputs.microseconds[2], 988);
    assert.equal(outputs.microseconds[4], 988);
    assert.equal(outputs.crsf[0], CRSF_CHANNEL_MID);
  });

  it("raises channel 5 only while armed", () => {
    const armed = buildOutputs(
      { roll: 0, pitch: 1, yaw: -1, throttle: 0.5 },
      [1, -1, 0],
      true,
      { roll: false, pitch: false, yaw: false, throttle: false },
    );
    assert.equal(armed.microseconds[4], 2012);
    assert.equal(armed.microseconds[1], 2012);
    assert.equal(armed.microseconds[3], 988);
    assert.equal(armed.microseconds[5], 2012);
    assert.equal(armed.microseconds[6], 988);
  });
});

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}
