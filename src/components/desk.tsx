"use client";

import { Radio, Usb } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { SetupGuide } from "@/components/setup-guide";
import { StickPad } from "@/components/stick-pad";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type Sticks,
  type SwitchPosition,
  DEFAULT_STICKS,
  buildOutputs,
  sticksFromGamepad,
} from "@/lib/controls";
import {
  type ModuleTelemetry,
  CrsfParser,
  HANDSET_BAUDS,
  buildRcFrame,
  emptyTelemetry,
  frameTypeName,
  noteFrame,
  toHex,
} from "@/lib/crsf";
import { readControlLoop, sleep, writeControlLoop } from "@/lib/link";
import {
  settingsFromSnapshot,
  subscribeSettings,
  readSettingsSnapshot,
  updateSettings,
} from "@/lib/settings";
import { cn } from "cn";

const HOLD_MS = 700;
const THROTTLE_ARM_LIMIT_US = 1100;

const CHANNELS = [
  ["CH1", "Roll"],
  ["CH2", "Pitch"],
  ["CH3", "Throttle"],
  ["CH4", "Yaw"],
  ["CH5", "Arm"],
  ["CH6", "Switch"],
  ["CH7", "Switch"],
  ["CH8", "Switch"],
] as const;

type Status = "closed" | "opening" | "open" | "live";

type PortInfo = { usbVendorId?: number; usbProductId?: number };

type OpenPort = {
  open: (options: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo?: () => PortInfo;
};

const VENDORS: Record<number, string> = {
  0x10c4: "Silicon Labs",
  0x1a86: "QinHeng",
  0x303a: "Espressif",
};

function getSerial(): { requestPort: () => Promise<OpenPort> } | null {
  const nav = navigator as Navigator & {
    serial?: { requestPort: () => Promise<OpenPort> };
  };
  return nav.serial ?? null;
}

function portLabel(info: PortInfo | null): string {
  if (!info?.usbVendorId) return "Serial port";
  const vendor = VENDORS[info.usbVendorId] ?? "USB";
  const id = `${info.usbVendorId.toString(16).padStart(4, "0")}:${(info.usbProductId ?? 0).toString(16).padStart(4, "0")}`;
  return `${vendor} ${id}`;
}

function meterPercent(us: number): number {
  return Math.min(100, Math.max(0, ((us - 988) / (2012 - 988)) * 100));
}

export function Desk() {
  const rawSettings = useSyncExternalStore(
    subscribeSettings,
    readSettingsSnapshot,
    () => "",
  );
  const settings = useMemo(() => settingsFromSnapshot(rawSettings), [rawSettings]);
  const { baud, hz, modelId, inverts, gamepad, armWithoutReply } = settings;
  const serialAvailable = useSyncExternalStore(
    () => () => {},
    () => getSerial() !== null,
    () => null as boolean | null,
  );

  const [status, setStatus] = useState<Status>("closed");
  const [error, setError] = useState<string | null>(null);
  const [portName, setPortName] = useState("No port");
  const [sticks, setSticks] = useState<Sticks>(DEFAULT_STICKS);
  const [switches, setSwitches] = useState<
    [SwitchPosition, SwitchPosition, SwitchPosition]
  >([0, 0, 0]);
  const [armed, setArmed] = useState(false);
  const [propsOff, setPropsOff] = useState(false);
  const [gamepadName, setGamepadName] = useState<string | null>(null);
  const [hold, setHold] = useState(0);
  const [telemetry, setTelemetry] = useState<ModuleTelemetry>(emptyTelemetry);
  const [moduleAt, setModuleAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [wire, setWire] = useState({ frames: 0, bytesIn: 0, rate: 0 });

  const sticksRef = useRef(sticks);
  const switchesRef = useRef(switches);
  const invertsRef = useRef(inverts);
  const armedRef = useRef(armed);
  const outputsRef = useRef(buildOutputs(sticks, switches, armed, inverts));
  const hzRef = useRef(hz);
  const modelRef = useRef(modelId);
  const armBlockerRef = useRef<string | null>(null);
  const stopRef = useRef(false);
  const dragCount = useRef(0);
  const holdRaf = useRef<number | null>(null);
  const parserRef = useRef(new CrsfParser());
  const sentRef = useRef(0);
  const bytesInRef = useRef(0);
  const rateWindowRef = useRef(0);
  const portRef = useRef<OpenPort | null>(null);
  const sessionRef = useRef<{
    reader: ReadableStreamDefaultReader<Uint8Array>;
    writer: WritableStreamDefaultWriter<Uint8Array>;
    done: Promise<void>;
  } | null>(null);
  const stopPromiseRef = useRef<Promise<void> | null>(null);

  const outputs = useMemo(
    () => buildOutputs(sticks, switches, armed, inverts),
    [sticks, switches, armed, inverts],
  );

  const preview = useMemo(() => buildRcFrame(outputs.crsf), [outputs]);
  const throttleUs = outputs.microseconds[2] ?? 988;
  const moduleFresh = moduleAt !== null && now - moduleAt < 2500;

  let armBlocker: string | null = null;
  if (status !== "live") armBlocker = "Start the link before arming.";
  else if (!propsOff) armBlocker = "Confirm the props are off and the model is bound.";
  else if (throttleUs > THROTTLE_ARM_LIMIT_US) {
    armBlocker = `Throttle output is ${throttleUs} µs. Bring it under ${THROTTLE_ARM_LIMIT_US}.`;
  } else if (!moduleFresh && !armWithoutReply) {
    armBlocker = "Wait until the module answers, or allow arming without a reply.";
  }

  useEffect(() => {
    sticksRef.current = sticks;
    switchesRef.current = switches;
    invertsRef.current = inverts;
    armedRef.current = armed;
    hzRef.current = hz;
    modelRef.current = modelId;
    outputsRef.current = outputs;
    armBlockerRef.current = armBlocker;
  }, [armBlocker, armed, hz, inverts, modelId, outputs, sticks, switches]);

  useEffect(() => {
    if (!gamepad) return;
    let frame = 0;
    const tick = () => {
      const pads = navigator.getGamepads?.() ?? [];
      let pad: Gamepad | null = null;
      for (const candidate of pads) {
        if (!candidate?.connected || candidate.axes.length < 4) continue;
        if (candidate.mapping === "standard") {
          pad = candidate;
          break;
        }
        pad ??= candidate;
      }
      setGamepadName(pad ? pad.id : null);
      if (pad && dragCount.current === 0) {
        const next = sticksFromGamepad(pad);
        if (next) {
          setSticks((current) =>
            current.roll === next.roll &&
            current.pitch === next.pitch &&
            current.yaw === next.yaw &&
            current.throttle === next.throttle
              ? current
              : next,
          );
        }
        if (armedRef.current && pad.buttons[1]?.pressed) setArmed(false);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [gamepad]);

  useEffect(() => {
    if (status !== "live") return;
    const id = window.setInterval(() => {
      setNow(Date.now());
      setWire({
        frames: sentRef.current,
        bytesIn: bytesInRef.current,
        rate: rateWindowRef.current * 2,
      });
      rateWindowRef.current = 0;
    }, 500);
    return () => window.clearInterval(id);
  }, [status]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setArmed(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (status !== "live") return;
    function onUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [status]);

  useEffect(() => {
    return () => {
      stopRef.current = true;
      if (holdRaf.current !== null) cancelAnimationFrame(holdRaf.current);
      void sessionRef.current?.reader.cancel().catch(() => undefined);
      void portRef.current?.close().catch(() => undefined);
    };
  }, []);

  function noteDrag(dragging: boolean) {
    dragCount.current += dragging ? 1 : -1;
    if (dragCount.current < 0) dragCount.current = 0;
  }

  function disarmOutputs() {
    armedRef.current = false;
    setArmed(false);
    outputsRef.current = buildOutputs(
      sticksRef.current,
      switchesRef.current,
      false,
      invertsRef.current,
    );
  }

  function stopLoops() {
    if (stopPromiseRef.current) return stopPromiseRef.current;
    const run = (async () => {
      const session = sessionRef.current;
      if (!session) return;
      disarmOutputs();
      await sleep(120);
      stopRef.current = true;
      try {
        await session.reader.cancel();
      } catch {
        /* The read loop treats cancel as a stop. */
      }
      await session.done;
      try {
        session.writer.releaseLock();
      } catch {
        /* Already released. */
      }
      try {
        session.reader.releaseLock();
      } catch {
        /* Cancel releases the reader. */
      }
      sessionRef.current = null;
    })();
    stopPromiseRef.current = run.finally(() => {
      stopPromiseRef.current = null;
    });
    return stopPromiseRef.current;
  }

  async function disconnect() {
    await stopLoops();
    const port = portRef.current;
    portRef.current = null;
    if (port) {
      try {
        await port.close();
      } catch {
        /* Already closed. */
      }
    }
    setStatus("closed");
    setModuleAt(null);
    setTelemetry(emptyTelemetry());
  }

  async function connect() {
    setError(null);
    const serial = getSerial();
    if (!serial) {
      setError("This browser cannot open a USB serial port. Use Chrome or Edge.");
      return;
    }
    setStatus("opening");
    try {
      const port = await serial.requestPort();
      await port.open({ baudRate: baud });
      portRef.current = port;
      setPortName(portLabel(port.getInfo?.() ?? null));
      setStatus("open");
    } catch (caught) {
      setStatus("closed");
      if (caught instanceof DOMException && caught.name === "NotFoundError") {
        setError(null);
        return;
      }
      setError(caught instanceof Error ? caught.message : "Could not open the port.");
    }
  }

  async function startLink() {
    const port = portRef.current;
    if (!port?.readable || !port.writable || status !== "open") return;
    setError(null);
    disarmOutputs();
    parserRef.current.reset();
    setTelemetry(emptyTelemetry());
    setModuleAt(null);
    sentRef.current = 0;
    bytesInRef.current = 0;
    rateWindowRef.current = 0;
    setWire({ frames: 0, bytesIn: 0, rate: 0 });
    stopRef.current = false;

    const reader = port.readable.getReader();
    const writer = port.writable.getWriter();
    const fail = (error: unknown) => {
      if (stopRef.current) return;
      stopRef.current = true;
      void reader.cancel().catch(() => undefined);
      setError(error instanceof Error ? error.message : "The serial port closed.");
    };
    const writeDone = writeControlLoop({
      writer,
      channels: () => outputsRef.current.crsf,
      modelId: () => modelRef.current,
      periodMs: () => 1000 / hzRef.current,
      stopRequested: () => stopRef.current,
      onSent: () => {
        sentRef.current += 1;
        rateWindowRef.current += 1;
      },
    }).catch((error: unknown) => {
      fail(error);
      throw error;
    });
    const readDone = readControlLoop(
      reader,
      (chunk) => {
        bytesInRef.current += chunk.byteLength;
        parserRef.current.push(chunk, (frame) => {
          if (frame.type === 0x16) return;
          setModuleAt(Date.now());
          setTelemetry((current) => noteFrame(current, frame));
        });
      },
      () => stopRef.current,
    ).catch((error: unknown) => {
      fail(error);
      throw error;
    });
    const done = Promise.allSettled([writeDone, readDone]).then(() => undefined);
    sessionRef.current = { reader, writer, done };
    setStatus("live");
  }

  async function stopLink() {
    if (status !== "live") return;
    await stopLoops();
    if (portRef.current) setStatus("open");
  }

  function beginHold() {
    if (armBlocker || holdRaf.current !== null) return;
    const started = performance.now();
    const tick = (time: number) => {
      if (armBlockerRef.current) {
        holdRaf.current = null;
        setHold(0);
        return;
      }
      const progress = Math.min(1, (time - started) / HOLD_MS);
      setHold(progress);
      if (progress >= 1) {
        setArmed(true);
        setHold(0);
        holdRaf.current = null;
        return;
      }
      holdRaf.current = requestAnimationFrame(tick);
    };
    holdRaf.current = requestAnimationFrame(tick);
  }

  function cancelHold() {
    if (holdRaf.current !== null) cancelAnimationFrame(holdRaf.current);
    holdRaf.current = null;
    setHold(0);
  }

  function setSwitch(index: 0 | 1 | 2, position: SwitchPosition) {
    setSwitches((current) => {
      const next = [...current] as [SwitchPosition, SwitchPosition, SwitchPosition];
      next[index] = position;
      return next;
    });
  }

  const statusLabel =
    status === "live"
      ? moduleFresh
        ? "Module answering"
        : "Sending"
      : status === "open"
        ? "Port open"
        : status === "opening"
          ? "Choosing port"
          : "Disconnected";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6">
      {armed ? (
        <div
          className="rounded-lg bg-destructive px-3 py-2 text-center text-sm font-medium text-white"
          role="status"
        >
          Armed. Channel 5 is high. Escape, or Disarm, drops it immediately.
        </div>
      ) : null}

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-xs tracking-[0.18em] text-primary uppercase">
            <Radio className="size-3.5" aria-hidden />
            RadioMaster Nomad
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Nomad Desk</h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            A desk transmitter for the Nomad&apos;s USB-C port. Sticks leave
            this browser as CRSF, and the module sends them over ExpressLRS.
          </p>
        </div>
        <Badge variant={status === "live" ? "default" : "outline"}>{statusLabel}</Badge>
      </header>

      <Tabs defaultValue="fly">
        <TabsList>
          <TabsTrigger value="fly">Fly</TabsTrigger>
          <TabsTrigger value="setup">Setup</TabsTrigger>
        </TabsList>

        <TabsContent value="fly" className="mt-4 flex flex-col gap-4">
          {serialAvailable === false ? (
            <Alert>
              <Usb />
              <AlertTitle>Chrome or Edge is required</AlertTitle>
              <AlertDescription>
                Web Serial is how this page reaches the Nomad. Open it in
                Chrome or Edge on the computer the module is plugged into.
              </AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Port error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="order-2 xl:order-1">
              <CardHeader>
                <CardTitle>Left stick</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <StickPad
                  label="Yaw and throttle"
                  xLabel="Yaw"
                  yLabel="Thr"
                  x={sticks.yaw}
                  y={sticks.throttle * 2 - 1}
                  onChange={(x, y) =>
                    setSticks((current) => ({
                      ...current,
                      yaw: x,
                      throttle: (y + 1) / 2,
                    }))
                  }
                  onDragChange={(dragging) => {
                    noteDrag(dragging);
                    if (!dragging) setSticks((current) => ({ ...current, yaw: 0 }));
                  }}
                />
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <Label htmlFor="throttle">Throttle</Label>
                    <span className="font-mono tabular-nums">{throttleUs} µs</span>
                  </div>
                  <Slider
                    id="throttle"
                    min={0}
                    max={1000}
                    value={[Math.round(sticks.throttle * 1000)]}
                    onValueChange={(value) => {
                      const next = Array.isArray(value) ? value[0] : value;
                      setSticks((current) => ({
                        ...current,
                        throttle: (next ?? 0) / 1000,
                      }));
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Yaw springs back. Throttle stays where you leave it. Channel
                    3 is live as soon as the link starts.
                  </p>
                </div>
                <div className="space-y-2">
                  {(
                    [
                      [0, "CH6"],
                      [1, "CH7"],
                      [2, "CH8"],
                    ] as const
                  ).map(([index, name]) => (
                    <div key={name} className="flex items-center justify-between gap-2">
                      <span className="text-sm">{name}</span>
                      <div className="flex rounded-lg bg-muted p-0.5">
                        {([-1, 0, 1] as const).map((position) => (
                          <button
                            key={position}
                            type="button"
                            className={cn(
                              "h-7 rounded-md px-2.5 text-xs text-muted-foreground",
                              switches[index] === position &&
                                "bg-background text-foreground shadow-sm",
                            )}
                            onClick={() => setSwitch(index, position)}
                          >
                            {position < 0 ? "Low" : position > 0 ? "High" : "Mid"}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="order-3 xl:order-2">
              <CardHeader>
                <CardTitle>Right stick</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <StickPad
                  label="Roll and pitch"
                  xLabel="Roll"
                  yLabel="Pitch"
                  x={sticks.roll}
                  y={sticks.pitch}
                  onChange={(x, y) =>
                    setSticks((current) => ({ ...current, roll: x, pitch: y }))
                  }
                  onDragChange={(dragging) => {
                    noteDrag(dragging);
                    if (!dragging) {
                      setSticks((current) => ({ ...current, roll: 0, pitch: 0 }));
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setSticks(DEFAULT_STICKS)}
                >
                  Center sticks and drop throttle
                </Button>
                <div className="grid grid-cols-2 gap-3">
                  {(
                    [
                      ["roll", "Reverse roll"],
                      ["pitch", "Reverse pitch"],
                      ["yaw", "Reverse yaw"],
                      ["throttle", "Reverse throttle"],
                    ] as const
                  ).map(([key, label]) => (
                    <div key={key} className="flex items-center justify-between gap-2">
                      <Label htmlFor={`invert-${key}`} className="text-xs">
                        {label}
                      </Label>
                      <Switch
                        id={`invert-${key}`}
                        checked={inverts[key]}
                        onCheckedChange={(checked) =>
                          updateSettings({
                            inverts: { ...inverts, [key]: checked },
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label htmlFor="gamepad">Use a gamepad</Label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {gamepadName ??
                        "Left stick throttle rests in the middle. Button B disarms."}
                    </p>
                  </div>
                  <Switch
                    id="gamepad"
                    checked={gamepad}
                    onCheckedChange={(checked) => updateSettings({ gamepad: checked })}
                  />
                </div>
              </CardContent>
            </Card>

            <Card className="order-1 xl:order-3">
              <CardHeader>
                <CardTitle>Link</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Baud. 400000 is the handset rate.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {HANDSET_BAUDS.map((rate) => (
                      <Button
                        key={rate}
                        type="button"
                        size="sm"
                        variant={baud === rate ? "default" : "outline"}
                        disabled={status !== "closed"}
                        onClick={() => updateSettings({ baud: rate })}
                      >
                        {rate >= 1000000 ? `${rate / 1000000}M` : rate}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Label htmlFor="model-id" className="shrink-0">
                    Model id
                  </Label>
                  <Input
                    id="model-id"
                    type="number"
                    min={0}
                    max={63}
                    value={modelId}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (Number.isNaN(next)) return;
                      updateSettings({
                        modelId: Math.min(63, Math.max(0, Math.round(next))),
                      });
                    }}
                  />
                </div>
                <div>
                  <p className="mb-2 text-xs text-muted-foreground">Packet rate</p>
                  <div className="flex gap-1.5">
                    {([50, 100, 200] as const).map((rate) => (
                      <Button
                        key={rate}
                        type="button"
                        size="sm"
                        variant={hz === rate ? "default" : "outline"}
                        onClick={() => updateSettings({ hz: rate })}
                      >
                        {rate} Hz
                      </Button>
                    ))}
                  </div>
                </div>
                <p className="font-mono text-xs text-muted-foreground">
                  {portName}
                  {status === "live"
                    ? ` · ${wire.rate} pkt/s · ${wire.bytesIn} bytes in`
                    : ""}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    disabled={status !== "closed" || serialAvailable === false}
                    onClick={() => void connect()}
                  >
                    Connect Nomad
                  </Button>
                  {status === "live" ? (
                    <Button type="button" variant="outline" onClick={() => void stopLink()}>
                      Stop link
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={status !== "open"}
                      onClick={() => void startLink()}
                    >
                      Start link
                    </Button>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={status === "closed" || status === "opening"}
                  onClick={() => void disconnect()}
                >
                  Disconnect
                </Button>

                <div className="rounded-xl border border-border p-3">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="props-off"
                      checked={propsOff}
                      onCheckedChange={(checked) => setPropsOff(checked)}
                    />
                    <Label htmlFor="props-off" className="text-sm font-normal">
                      Props are off, and this receiver is the one I mean to fly.
                    </Label>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <Checkbox
                      id="arm-without-reply"
                      checked={armWithoutReply}
                      onCheckedChange={(checked) =>
                        updateSettings({ armWithoutReply: checked })
                      }
                    />
                    <Label htmlFor="arm-without-reply" className="text-sm font-normal">
                      Allow arming before the module answers.
                    </Label>
                  </div>
                  {armed ? (
                    <Button
                      type="button"
                      variant="destructive"
                      className="mt-3 h-12 w-full text-base"
                      onClick={() => setArmed(false)}
                    >
                      Disarm
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      className="relative mt-3 h-12 w-full overflow-hidden text-base"
                      disabled={armBlocker !== null}
                      onPointerDown={(event) => {
                        event.currentTarget.setPointerCapture(event.pointerId);
                        beginHold();
                      }}
                      onPointerUp={cancelHold}
                      onPointerCancel={cancelHold}
                      onKeyDown={(event) => {
                        if (event.repeat) return;
                        if (event.key === " " || event.key === "Enter") {
                          event.preventDefault();
                          beginHold();
                        }
                      }}
                      onKeyUp={(event) => {
                        if (event.key === " " || event.key === "Enter") cancelHold();
                      }}
                    >
                      <span
                        className="absolute inset-y-0 left-0 bg-primary-foreground/20"
                        style={{ width: `${hold * 100}%` }}
                      />
                      <span className="relative">Hold to arm</span>
                    </Button>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    {armed
                      ? "Channel 5 is high. Escape disarms."
                      : (armBlocker ?? "Hold for a moment. Channel 5 goes high.")}
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,0.7fr)]">
            <Card>
              <CardHeader>
                <CardTitle>Commanded channels</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                {CHANNELS.map(([name, hint], index) => {
                  const us = outputs.microseconds[index] ?? 1500;
                  return (
                    <div key={name}>
                      <div className="flex items-baseline justify-between text-xs">
                        <span>
                          {name}{" "}
                          <span className="text-muted-foreground">{hint}</span>
                        </span>
                        <span className="font-mono tabular-nums">{us} µs</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${meterPercent(us)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>From the module</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="font-mono text-4xl tabular-nums">
                    {telemetry.link ? `${telemetry.link.uplinkLq}%` : "—"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Uplink quality
                    {telemetry.link?.uplinkLq === 0
                      ? ". The module is sending, and no receiver is locked."
                      : ""}
                  </p>
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Uplink RSSI</dt>
                    <dd className="font-mono tabular-nums">
                      {telemetry.link ? `${telemetry.link.uplinkRssiDbm} dBm` : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Uplink SNR</dt>
                    <dd className="font-mono tabular-nums">
                      {telemetry.link ? `${telemetry.link.uplinkSnr} dB` : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Downlink</dt>
                    <dd className="font-mono tabular-nums">
                      {telemetry.link ? `${telemetry.link.downlinkLq}%` : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">TX power</dt>
                    <dd className="font-mono tabular-nums">
                      {telemetry.link?.txPowerMw == null
                        ? "—"
                        : `${telemetry.link.txPowerMw} mW`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Last reply</dt>
                    <dd className="font-mono tabular-nums">
                      {moduleAt ? `${Math.max(0, now - moduleAt)} ms` : "none"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Last frame</dt>
                    <dd>
                      {telemetry.lastType == null
                        ? "—"
                        : frameTypeName(telemetry.lastType)}
                    </dd>
                  </div>
                </dl>
                {telemetry.deviceName ? (
                  <p className="text-sm">
                    Device <span className="font-medium">{telemetry.deviceName}</span>
                  </p>
                ) : null}
                {telemetry.battery ? (
                  <p className="font-mono text-sm tabular-nums">
                    {telemetry.battery.volts.toFixed(1)} V · {telemetry.battery.amps.toFixed(1)} A ·{" "}
                    {telemetry.battery.mah} mAh · {telemetry.battery.remaining}%
                  </p>
                ) : null}
                {telemetry.flightMode ? (
                  <p className="text-sm">Mode {telemetry.flightMode}</p>
                ) : null}
                {telemetry.gps ? (
                  <p className="font-mono text-xs tabular-nums text-muted-foreground">
                    {telemetry.gps.lat.toFixed(5)}, {telemetry.gps.lon.toFixed(5)} ·{" "}
                    {telemetry.gps.sats} sats
                  </p>
                ) : null}
                {status === "live" && !moduleFresh ? (
                  <p className="text-xs text-muted-foreground">
                    No reply yet. The module searches baud rates for a few
                    seconds. If it stays quiet, check serial_rx 3, serial_tx 1,
                    and that this baud is one of the handset rates.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </div>

          <details className="rounded-xl border border-border px-3 py-2 text-sm">
            <summary className="cursor-pointer font-medium">
              Frame on the wire
            </summary>
            <p className="mt-2 font-mono text-xs break-all text-muted-foreground">
              {toHex(preview)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              26 bytes. Address EE, type 16, sixteen 11-bit channels. Channels
              9 through 16 stay at 1500 µs.
            </p>
          </details>
        </TabsContent>

        <TabsContent value="setup" className="mt-4">
          <SetupGuide />
        </TabsContent>
      </Tabs>
    </div>
  );
}
