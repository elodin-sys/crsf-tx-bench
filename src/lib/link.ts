import { buildModelIdFrame, buildPingFrame, buildRcFrame } from "./crsf";

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
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function writeControlLoop(options: {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  channels: () => readonly number[];
  modelId: () => number;
  periodMs: () => number;
  stopRequested: () => boolean;
  onSent: () => void;
}): Promise<void> {
  let lastExtra = 0;
  while (!options.stopRequested()) {
    const started = performance.now();
    const chunks = [buildRcFrame(options.channels())];
    if (started - lastExtra >= 2000) {
      chunks.push(buildModelIdFrame(options.modelId()));
      chunks.push(buildPingFrame());
      lastExtra = started;
    }
    await options.writer.write(concatBytes(chunks));
    options.onSent();
    const remain = options.periodMs() - (performance.now() - started);
    if (remain > 0) await sleep(remain);
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
      if (done) return;
      if (value && value.byteLength > 0) onBytes(value);
    }
  } catch (error) {
    if (!stopRequested()) throw error;
  }
}
