"use client";

import { useRef } from "react";

type StickPadProps = {
  label: string;
  xLabel: string;
  yLabel: string;
  x: number;
  y: number;
  onChange: (x: number, y: number) => void;
  onDragChange?: (dragging: boolean) => void;
};

export function StickPad({
  label,
  xLabel,
  yLabel,
  x,
  y,
  onChange,
  onDragChange,
}: StickPadProps) {
  const padRef = useRef<HTMLDivElement>(null);

  function pointFromEvent(event: React.PointerEvent<HTMLDivElement>) {
    const pad = padRef.current;
    if (!pad) return;
    const rect = pad.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width;
    const py = (event.clientY - rect.top) / rect.height;
    const nextX = Math.min(1, Math.max(-1, px * 2 - 1));
    const nextY = Math.min(1, Math.max(-1, 1 - py * 2));
    onChange(nextX, nextY);
  }

  const left = 14 + ((x + 1) / 2) * 72;
  const top = 14 + ((1 - y) / 2) * 72;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium">{label}</p>
        <p className="font-mono text-[11px] text-muted-foreground">
          {xLabel} {x >= 0 ? "+" : ""}
          {x.toFixed(2)} · {yLabel} {y >= 0 ? "+" : ""}
          {y.toFixed(2)}
        </p>
      </div>
      <div
        ref={padRef}
        role="application"
        aria-label={`${label}. ${xLabel} and ${yLabel}.`}
        className="relative aspect-square w-full max-w-[280px] cursor-grab touch-none rounded-2xl border border-border bg-black/50 active:cursor-grabbing"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          onDragChange?.(true);
          pointFromEvent(event);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          pointFromEvent(event);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          onDragChange?.(false);
        }}
        onPointerCancel={() => onDragChange?.(false)}
      >
        <div className="pointer-events-none absolute inset-[14%] rounded-full border border-dashed border-primary/35" />
        <div className="pointer-events-none absolute inset-y-[14%] left-1/2 w-px bg-border" />
        <div className="pointer-events-none absolute inset-x-[14%] top-1/2 h-px bg-border" />
        <div
          className="pointer-events-none absolute size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary-foreground/30 bg-primary shadow-[0_0_18px_oklch(0.84_0.15_85_/_0.45)]"
          style={{ left: `${left}%`, top: `${top}%` }}
        />
      </div>
    </div>
  );
}
