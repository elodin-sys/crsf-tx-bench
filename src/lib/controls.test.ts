import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { axisUs, throttleUs, safeSticks, safeChannels, buildOutputs, DEFAULT_INVERTS, sticksFromGamepad } from "./controls";
import { usToCrsf } from "./crsf";

describe("control failure handling", () => {
  it("maps invalid numeric inputs to neutral axes and low throttle regardless of reversal", () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      for (const reverse of [true, false]) {
        assert.equal(axisUs(value, reverse), 1500);
        assert.equal(throttleUs(value, reverse), 988);
      }
    }
  });
  it("resets reversed throttle to low output", () => {
    const reversed = { ...DEFAULT_INVERTS, throttle: true };
    const outputs = buildOutputs(safeSticks(reversed), [0, 0, 0], false, reversed);
    assert.equal(outputs.microseconds[2], 988);
    assert.equal(outputs.microseconds[4], 988);
  });
  it("closing frames force throttle and arm low without changing auxiliary settings", () => {
    const channels = Array.from({ length: 16 }, () => usToCrsf(1800));
    const safe = safeChannels(channels);
    assert.equal(safe[2], usToCrsf(988));
    assert.equal(safe[4], usToCrsf(988));
    assert.equal(safe[5], channels[5]);
    assert.equal(channels[2], usToCrsf(1800));
  });
  it("rejects missing, disconnected and non-finite gamepad axes", () => {
    for (const [connected, axes] of [[false, [0, 0, 0, 0]], [true, [0]], [true, [NaN, 0, 0, 0]]] as const) {
      assert.equal(sticksFromGamepad({ connected, axes } as unknown as Gamepad), null);
    }
  });
});
