import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, readSettingsSnapshot, settingsFromSnapshot, updateSettings } from "./settings";

describe("saved settings", () => {
  it("does not opt old or fresh installations into model-ID writes", () => {
    assert.equal(DEFAULT_SETTINGS.sendModelId, false);
    assert.equal(settingsFromSnapshot('{"v":1,"modelId":7}').sendModelId, false);
    assert.equal(settingsFromSnapshot('{"v":1,"modelId":7,"sendModelId":true}').sendModelId, true);
  });
  it("accepts only typed control and override values from storage", () => {
    const settings = settingsFromSnapshot(JSON.stringify({ v: 1, modelId: "invalid", sendModelId: true,
      baud: 420000, hz: -1, inverts: { throttle: "false", yaw: true }, gamepad: "false", armWithoutReply: "false" }));
    assert.equal(settings.baud, DEFAULT_SETTINGS.baud);
    assert.equal(settings.hz, 100);
    assert.equal(settings.modelId, 0);
    assert.equal(settings.sendModelId, false);
    assert.equal(settings.inverts.throttle, false);
    assert.equal(settings.inverts.yaw, true);
    assert.equal(settings.gamepad, false);
    assert.equal(settings.armWithoutReply, false);
  });
  it("keeps current-tab changes when writes fail but old storage remains readable", () => {
    const old = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: () => '{"v":1,"hz":100}',
      setItem: () => { throw new Error("quota exceeded"); },
    } });
    try {
      updateSettings({ hz: 200 });
      assert.equal(settingsFromSnapshot(readSettingsSnapshot()).hz, 200);
    } finally {
      if (old) Object.defineProperty(globalThis, "localStorage", old);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
  it("handles corrupt JSON and unavailable browser storage", () => {
    for (const value of ["null", "42", "[]", "{bad", '{"v":2}']) assert.deepEqual(settingsFromSnapshot(value), DEFAULT_SETTINGS);
    updateSettings({ hz: 50 });
    assert.equal(settingsFromSnapshot(readSettingsSnapshot()).hz, 50);
  });
});
