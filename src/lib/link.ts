import { buildModelIdFrame, buildPingFrame, buildRcFrame } from "./crsf";

export const SERIAL_TIMEOUT_MS = 1000;

export type HandsetPort = {
  open: (options: { baudRate: number; flowControl: "none" }) => Promise<void>;
  setSignals: (signals: { dataTerminalReady: boolean; requestToSend: boolean }) => Promise<void>;
  close: () => Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
};

export class PortCleanupError extends Error {}

/** CP2102 control lines can hold the ESP32 in reset even after open succeeds. */
export async function openHandsetPort(port: HandsetPort, baud: number): Promise<void> {
  await port.open({ baudRate: baud, flowControl: "none" });
  try {
    await withTimeout(
      port.setSignals({ dataTerminalReady: false, requestToSend: false }),
      SERIAL_TIMEOUT_MS,
      "Releasing DTR/RTS timed out.",
    );
  } catch (error) {
    try {
      await withTimeout(port.close(), SERIAL_TIMEOUT_MS, "Closing the port timed out.");
    } catch (closeError) {
      throw new PortCleanupError(`${error instanceof Error ? error.message : error} ${closeError instanceof Error ? closeError.message : closeError} Unplug USB before reconnecting.`);
    }
    throw error;
  }
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** A rejected deadline does not cancel the operation; callers must also tear down the stream. */
export async function withTimeout<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type WriteOptions = {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  channels: () => readonly number[];
  modelId: () => number | null;
  periodMs: () => number;
  stopRequested: () => boolean;
  onSent: () => void;
  timeoutMs?: number;
  /** Monotonic scheduler; injectable so late wakeups can be tested without wall-clock jitter. */
  clock?: { now: () => number; sleep: (ms: number) => Promise<void> };
};

export async function writeControlLoop(options: WriteOptions): Promise<void> {
  const clock = options.clock ?? { now: () => performance.now(), sleep };
  let nextCycle = clock.now();
  let lastExtra: number | null = null;
  while (!options.stopRequested()) {
    const started = clock.now();
    const chunks = [buildRcFrame(options.channels())];
    if (lastExtra === null || started - lastExtra >= 2000) {
      const modelId = options.modelId();
      if (modelId !== null) chunks.push(buildModelIdFrame(modelId));
      chunks.push(buildPingFrame());
      lastExtra = started;
    }
    await withTimeout(options.writer.write(concatBytes(chunks)), options.timeoutMs ?? SERIAL_TIMEOUT_MS, "Serial write timed out.");
    options.onSent();
    const period = options.periodMs();
    if (!Number.isFinite(period) || period < 5 || period > 1000) throw new Error("Invalid channel update period.");
    nextCycle += period;
    const now = clock.now();
    // Keep the cadence after small timer oversleeps. If work overruns an entire
    // period, skip the missed slot rather than burst old frames to catch up.
    if (nextCycle <= now) nextCycle = now + period;
    if (!options.stopRequested()) await clock.sleep(nextCycle - now);
  }
}

export async function readControlLoop(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onBytes: (chunk: Uint8Array) => void,
  stopRequested: () => boolean,
): Promise<void> {
  try {
    while (!stopRequested()) {
      const { value, done } = await reader.read();
      if (done) {
        if (!stopRequested()) throw new Error("The serial port closed.");
        return;
      }
      if (value && value.byteLength > 0 && !stopRequested()) onBytes(value);
    }
  } catch (error) {
    if (!stopRequested()) throw error;
  }
}

export type ControlSession = {
  /** Settles after locks are released. A non-null result means the port must be closed. */
  done: Promise<Error | null>;
  /** Idempotent. Final safe frames follow any pending control write, never race it. */
  stop: () => Promise<Error | null>;
};

export function startControlSession(options: {
  port: HandsetPort;
  channels: () => readonly number[];
  finalChannels: () => readonly number[];
  modelId: () => number | null;
  periodMs: () => number;
  onSent: () => void;
  onBytes: (chunk: Uint8Array) => void;
  onError?: (error: Error) => void;
  timeoutMs?: number;
}): ControlSession {
  if (!options.port.readable || !options.port.writable) throw new Error("The serial port is not open.");
  const reader = options.port.readable.getReader();
  let writer: WritableStreamDefaultWriter<Uint8Array>;
  try {
    writer = options.port.writable.getWriter();
  } catch (error) {
    reader.releaseLock();
    throw error;
  }
  let stopped = false;
  let failure: Error | null = null;
  const timeout = options.timeoutMs ?? SERIAL_TIMEOUT_MS;
  const fail = (cause: unknown) => {
    if (failure) return;
    failure = cause instanceof Error ? cause : new Error(String(cause));
    stopped = true;
    void reader.cancel().catch(() => undefined);
    void writer.abort(failure).catch(() => undefined);
    try {
      options.onError?.(failure);
    } catch {
      // Error-reporting callbacks must not prevent port lock cleanup.
    }
  };
  const writeDone = (async () => {
    try {
      await writeControlLoop({ ...options, writer, stopRequested: () => stopped });
      // Never queue more bytes after a failed/stalled write. A normal Stop sends
      // the closing pattern serially, after the last ordinary frame completes.
      if (!failure) {
        const closingFrame = buildRcFrame(options.finalChannels());
        for (let index = 0; index < 3; index += 1) {
          if (failure) break;
          await withTimeout(writer.write(closingFrame), timeout, "Closing frame write timed out.");
        }
      }
    } catch (error) {
      fail(error);
    } finally {
      stopped = true;
      void reader.cancel().catch(() => undefined);
    }
  })();
  const readDone = readControlLoop(reader, options.onBytes, () => stopped).catch(fail);
  const done = writeDone.then(async () => {
    // cancel() may itself stall in a disconnected driver. Bound waiting for its
    // pending read too; releasing the lock rejects any remaining read promise.
    try {
      await withTimeout(readDone, timeout, "Serial read cancellation timed out.");
    } catch (error) {
      fail(error);
    } finally {
      writer.releaseLock();
      reader.releaseLock();
    }
    return failure;
  });
  return {
    done,
    stop: () => {
      stopped = true;
      return done;
    },
  };
}
