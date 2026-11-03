import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildOutputs } from "./controls";
import {
  CRSF_ADDRESS_MODULE,
  CRSF_ADDRESS_RADIO,
  CRSF_CHANNEL_MID,
  CRSF_SYNC,
  CrsfParser,
  DEFAULT_BAUD,
  buildFrame,
  buildModelIdFrame,
  buildPingFrame,
  buildRcFrame,
  crc8,
  emptyTelemetry,
  noteFrame,
  packChannels,
  toHex,
  unpackChannels,
  usToCrsf,
  type ParsedFrame,
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

  it("rejects non-finite input instead of silently emitting channel zero", () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      assert.throws(() => usToCrsf(value), RangeError);
    }
    assert.equal(usToCrsf(-10000), 173);
    assert.equal(usToCrsf(10000), 1811);
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
    assert.equal(toHex(frame).replaceAll(" ", ""), "ee1816c8800746808216c8e0063c0882119600852a68e10b64b3");

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
    assert.equal(toHex(model), "c8 08 32 ee ea 10 05 07 8e cc");

    const ping = buildPingFrame();
    assert.deepEqual(Array.from(ping.subarray(0, 5)), [0xc8, 4, 0x28, 0x00, 0xea]);
    assert.equal(ping[5], crc8(ping.subarray(2, 5)));

    const frames: number[] = [];
    const parser = new CrsfParser();
    parser.push(concat(model, ping), (frame) => frames.push(frame.type));
    assert.deepEqual(frames, [0x32, 0x28]);
  });

  it("enforces the CRSF frame and numeric input limits", () => {
    assert.equal(buildFrame(0x80, new Uint8Array(60)).length, 64);
    assert.throws(() => buildFrame(0x80, new Uint8Array(61)), RangeError);
    for (const invalid of [NaN, Infinity, -1, 256, 1.5]) {
      assert.throws(() => buildFrame(invalid, new Uint8Array()), RangeError);
      assert.throws(() => buildFrame(0x80, new Uint8Array(), invalid), RangeError);
    }
    assert.throws(() => buildModelIdFrame(NaN), RangeError);
    assert.equal(DEFAULT_BAUD, 115200);
  });

  it("rejects invalid packed channels and truncated channel payloads", () => {
    for (const invalid of [NaN, Infinity, -1, 2048, 1000.5]) {
      const channels = new Array<number>(16).fill(992);
      channels[2] = invalid;
      assert.throws(() => packChannels(channels), RangeError);
    }
    assert.throws(() => unpackChannels(new Uint8Array(21)), RangeError);
    assert.throws(() => unpackChannels(new Uint8Array(23)), RangeError);
    const endpoints = Array.from({ length: 16 }, (_, i) => i % 2 ? 2047 : 0);
    assert.deepEqual(unpackChannels(packChannels(endpoints)), endpoints);
  });
});

describe("stream recovery", () => {
  it("parses every split of a maximum-size frame without mistaking its payload for frames", () => {
    const payload = new Uint8Array(60).fill(0xee);
    payload.set(buildPingFrame(), 11);
    const frame = buildFrame(0x80, payload, CRSF_ADDRESS_RADIO);
    for (let split = 0; split <= frame.length; split++) {
      const found: ParsedFrame[] = [];
      const parser = new CrsfParser();
      parser.push(frame.subarray(0, split), (next) => found.push(next));
      parser.push(frame.subarray(split), (next) => found.push(next));
      assert.deepEqual(found, [{ sync: CRSF_ADDRESS_RADIO, type: 0x80, payload }]);
    }
  });

  it("recovers a frame swallowed by a corrupt candidate's declared length", () => {
    const bytes = concat(Uint8Array.of(0xc8, 8, 0x14, 0x99), buildPingFrame());
    const found: ParsedFrame[] = [];
    const parser = new CrsfParser();
    for (const byte of bytes) parser.push(Uint8Array.of(byte), (frame) => found.push(frame));
    assert.deepEqual(found.map((frame) => frame.type), [0x28]);
  });

  it("bounds corrupt-length buffering and recovers after boot noise and bad CRCs", () => {
    const bad = buildPingFrame();
    bad[bad.length - 1] ^= 0xff;
    const noise = concat(Uint8Array.of(0xc8, 62), buildPingFrame());
    const bytes = concat(concat(noise, new Uint8Array(64)), concat(bad, buildPingFrame()));
    const found: ParsedFrame[] = [];
    new CrsfParser().push(bytes, (frame) => found.push(frame));
    assert.deepEqual(found.map((frame) => frame.type), [0x28, 0x28]);
  });

  it("does not guess an inner frame from an incomplete candidate at end of stream", () => {
    const parser = new CrsfParser();
    const found: ParsedFrame[] = [];
    parser.push(concat(Uint8Array.of(0xc8, 62), buildPingFrame()), (frame) => found.push(frame));
    // These bytes could still be a prefix of a valid 64-byte outer frame. The
    // caller resets at EOF/reconnect; there is no timeout-driven inner parsing.
    assert.equal(found.length, 0);
    parser.reset();
    parser.push(buildPingFrame(), (frame) => found.push(frame));
    assert.deepEqual(found.map((frame) => frame.type), [0x28]);
  });

  it("resynchronizes consecutive addresses and resets partial input", () => {
    const found: ParsedFrame[] = [];
    const parser = new CrsfParser();
    parser.push(Uint8Array.of(0xc8, 62, 0x14), (frame) => found.push(frame));
    parser.reset();
    parser.push(concat(Uint8Array.of(0x00, 0xff, 0xea, 0xee), buildPingFrame()), (frame) => found.push(frame));
    assert.deepEqual(found.map((frame) => frame.type), [0x28]);
  });
});

describe("telemetry", () => {
  it("reads link statistics and ignores our own channel frames", () => {
    // ELRS 4.1 TX-to-handset RSSI uses signed bytes, not RX-to-FC magnitudes.
    const payload = Uint8Array.of(193, 0, 95, 0xfe, 1, 4, 5, 226, 90, 5);
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
    assert.equal(state.link?.uplinkRssiDbm, -63);
    assert.equal(state.link?.uplinkLq, 95);
    assert.equal(state.link?.uplinkSnr, -2);
    assert.equal(state.link?.txPowerMw, 1000);
    assert.equal(state.link?.antenna, 2);
    assert.equal(state.link?.downlinkLq, 90);
    assert.equal(state.link?.downlinkRssiDbm, -30);
  });

  it("handles zero, signed boundaries, and unknown power indices", () => {
    for (const [raw, expected] of [[0, 0], [128, -128], [255, -1]]) {
      const state = noteFrame(emptyTelemetry(), {
        sync: CRSF_ADDRESS_RADIO, type: 0x14,
        payload: Uint8Array.of(raw, 0, 0, 0, 0, 24, 255, raw, 0, 0),
      });
      assert.equal(state.link?.uplinkRssiDbm, expected);
      assert.equal(state.link?.downlinkRssiDbm, expected);
      assert.equal(state.link?.txPowerMw, null);
    }
  });

  it("does not treat outbound echoes or malformed known telemetry as module replies", () => {
    const initial = emptyTelemetry();
    for (const [type, length] of [[0x14, 9], [0x08, 7], [0x1e, 5], [0x02, 14], [0x21, 0], [0x29, 2]]) {
      assert.equal(noteFrame(initial, { sync: 0xea, type, payload: new Uint8Array(length) }), initial);
    }
    assert.equal(noteFrame(initial, { sync: 0xea, type: 0x21, payload: Uint8Array.of(65) }), initial);
    let state = initial;
    new CrsfParser().push(concat(buildPingFrame(), buildModelIdFrame(7)), (frame) => {
      state = noteFrame(state, frame);
    });
    assert.equal(state, initial);
  });

  it("keeps the transmitter name when a receiver also answers discovery", () => {
    const device = (name: string, origin: number): ParsedFrame => ({
      sync: 0xea,
      type: 0x29,
      payload: concat(Uint8Array.of(0xea, origin), concat(new TextEncoder().encode(name), new Uint8Array(15))),
    });
    let state = noteFrame(emptyTelemetry(), device("RM Nomad X-Band", 0xee));
    assert.equal(state.deviceName, "RM Nomad X-Band");
    state = noteFrame(state, device("RM RP3", 0xec));
    assert.equal(state.deviceName, "RM Nomad X-Band");
    assert.equal(state.moduleFrames, 2);
    const truncated = device("Bogus", 0xee);
    truncated.payload = truncated.payload.subarray(0, truncated.payload.length - 1);
    assert.equal(noteFrame(state, truncated), state);
    const elsewhere = device("Not addressed to us", 0xee);
    elsewhere.payload[0] = 0xec;
    assert.equal(noteFrame(state, elsewhere), state);
  });

  it("retains unknown inbound frame diagnostics", () => {
    const state = noteFrame(emptyTelemetry(), { sync: 0xea, type: 0x80, payload: Uint8Array.of(7) });
    assert.equal(state.moduleFrames, 1);
    assert.equal(state.lastType, 0x80);
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
