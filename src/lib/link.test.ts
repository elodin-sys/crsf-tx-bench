import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CrsfParser, CRSF_CHANNEL_MID, unpackChannels, usToCrsf } from "./crsf";
import { safeChannels } from "./controls";
import { type HandsetPort, PortCleanupError, openHandsetPort, readControlLoop, startControlSession, writeControlLoop } from "./link";

const controls = Array.from({ length: 16 }, () => CRSF_CHANNEL_MID);
controls[2] = usToCrsf(1900);
controls[4] = usToCrsf(2000);

function portFixture(write?: (bytes: Uint8Array) => Promise<void> | void) {
  const writes: Uint8Array[] = [];
  let input!: ReadableStreamDefaultController<Uint8Array>;
  const port: HandsetPort = {
    open: async () => {}, setSignals: async () => {}, close: async () => {},
    readable: new ReadableStream<Uint8Array>({ start(controller) { input = controller; } }),
    writable: new WritableStream<Uint8Array>({ write(bytes) { writes.push(bytes.slice()); return write?.(bytes); } }),
  };
  return { port, writes, input };
}

function frames(bytes: Uint8Array[]) {
  const result: { type: number; payload: Uint8Array }[] = [];
  const parser = new CrsfParser();
  for (const chunk of bytes) parser.push(chunk, (frame) => result.push(frame));
  return result;
}

function start(port: HandsetPort, onSent = () => {}) {
  return startControlSession({ port, channels: () => controls, finalChannels: () => safeChannels(controls),
    modelId: () => null, periodMs: () => 10, onSent, onBytes: () => {}, timeoutMs: 30 });
}

describe("serial lifecycle", () => {
  it("explicitly releases both modem lines after open", async () => {
    const fixture = portFixture();
    const calls: unknown[] = [];
    fixture.port.open = async (options) => { calls.push(options); };
    fixture.port.setSignals = async (signals) => { calls.push(signals); };
    await openHandsetPort(fixture.port, 115200);
    assert.deepEqual(calls, [{ baudRate: 115200, flowControl: "none" }, { dataTerminalReady: false, requestToSend: false }]);
  });

  it("closes an opened port if releasing modem lines fails", async () => {
    const fixture = portFixture();
    let closed = false;
    fixture.port.setSignals = async () => { throw new Error("signal failure"); };
    fixture.port.close = async () => { closed = true; };
    await assert.rejects(openHandsetPort(fixture.port, 115200), /signal failure/);
    assert.equal(closed, true);
  });

  it("reports failed open cleanup so the caller cannot blindly reopen", async () => {
    const fixture = portFixture();
    fixture.port.setSignals = async () => { throw new Error("signal failure"); };
    fixture.port.close = async () => { throw new Error("close failure"); };
    await assert.rejects(openHandsetPort(fixture.port, 115200), PortCleanupError);
  });

  it("bounds a driver that never resolves read cancellation", async () => {
    const fixture = portFixture();
    let released = false;
    fixture.port.readable = { getReader: () => ({
      read: () => new Promise(() => {}), cancel: () => new Promise(() => {}),
      releaseLock: () => { released = true; },
    }) } as unknown as ReadableStream<Uint8Array>;
    const session = start(fixture.port);
    const failure = await session.stop();
    assert.match(failure!.message, /read cancellation timed out/);
    assert.equal(released, true);
  });

  it("pings immediately without sending an unsolicited model ID", async () => {
    const fixture = portFixture();
    const writer = fixture.port.writable!.getWriter();
    let stop = false;
    await writeControlLoop({ writer, channels: () => controls, modelId: () => null,
      periodMs: () => 10, stopRequested: () => stop, onSent: () => { stop = true; } });
    assert.deepEqual(frames(fixture.writes).map((frame) => frame.type), [0x16, 0x28]);
    writer.releaseLock();
  });

  it("sends a model ID only when explicitly selected", async () => {
    const fixture = portFixture();
    const writer = fixture.port.writable!.getWriter();
    let stop = false;
    await writeControlLoop({ writer, channels: () => controls, modelId: () => 7,
      periodMs: () => 10, stopRequested: () => stop, onSent: () => { stop = true; } });
    assert.deepEqual(frames(fixture.writes).map((frame) => frame.type), [0x16, 0x32, 0x28]);
    writer.releaseLock();
  });

  it("keeps an absolute cadence instead of accumulating timer oversleep", async () => {
    let now = 0;
    const sentAt: number[] = [];
    const fixture = portFixture(() => { now += 1; });
    const writer = fixture.port.writable!.getWriter();
    await writeControlLoop({ writer,
      channels: () => { sentAt.push(now); return controls; },
      modelId: () => null, periodMs: () => 10,
      stopRequested: () => sentAt.length === 4, onSent: () => {},
      clock: { now: () => now, sleep: async (ms) => { now += ms + 2; } },
    });
    assert.deepEqual(sentAt, [0, 12, 22, 32]);
    writer.releaseLock();
  });

  it("skips missed slots after a slow write without a catch-up burst", async () => {
    let now = 0;
    const sentAt: number[] = [];
    const fixture = portFixture(() => { if (sentAt.length === 2) now += 25; });
    const writer = fixture.port.writable!.getWriter();
    await writeControlLoop({ writer,
      channels: () => { sentAt.push(now); return controls; },
      modelId: () => null, periodMs: () => 10,
      stopRequested: () => sentAt.length === 4, onSent: () => {},
      clock: { now: () => now, sleep: async (ms) => { now += ms; } },
    });
    assert.deepEqual(sentAt, [0, 10, 45, 55]);
    writer.releaseLock();
  });

  it("serializes three safe closing frames and releases both stream locks", async () => {
    const fixture = portFixture();
    const session = start(fixture.port);
    assert.equal(session.stop(), session.stop());
    assert.equal(await session.done, null);
    const channelFrames = frames(fixture.writes).filter((frame) => frame.type === 0x16);
    assert.equal(channelFrames.length, 4);
    for (const frame of channelFrames.slice(-3)) {
      const channels = unpackChannels(frame.payload);
      assert.equal(channels[2], usToCrsf(988));
      assert.equal(channels[4], usToCrsf(988));
    }
    assert.equal(fixture.port.readable!.locked, false);
    assert.equal(fixture.port.writable!.locked, false);
  });

  it("treats unexpected reader EOF as failure and stops the sender", async () => {
    const fixture = portFixture();
    const session = start(fixture.port);
    fixture.input.close();
    assert.match((await session.done)!.message, /serial port closed/);
    assert.equal(fixture.port.readable!.locked, false);
    assert.equal(fixture.port.writable!.locked, false);
    const count = fixture.writes.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(fixture.writes.length, count);
  });

  it("bounds a stalled write and never queues closing frames behind it", async () => {
    let release!: () => void;
    const fixture = portFixture(() => new Promise<void>((resolve) => { release = resolve; }));
    const session = start(fixture.port);
    const failure = await session.stop();
    assert.match(failure!.message, /write timed out/);
    assert.equal(fixture.writes.length, 1);
    assert.equal(fixture.port.writable!.locked, false);
    release();
  });

  it("releases the reader when a previously locked writer prevents startup", () => {
    const fixture = portFixture();
    const existing = fixture.port.writable!.getWriter();
    assert.throws(() => start(fixture.port), /locked/);
    assert.equal(fixture.port.readable!.locked, false);
    existing.releaseLock();
  });

  it("does not report intentional reader cancellation as disconnect", async () => {
    const fixture = portFixture();
    const reader = fixture.port.readable!.getReader();
    let stopped = false;
    const done = readControlLoop(reader, () => {}, () => stopped);
    stopped = true;
    await reader.cancel();
    await done;
    reader.releaseLock();
  });
});
