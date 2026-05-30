"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMediaQuery } from "@/hooks/use-media-query";

const STORAGE_KEY = "kontexta:pane-widths:v1";
const DEFAULT_LEFT = 200;
const DEFAULT_MIDDLE = 240;
const MIN_LEFT = 160;
const MAX_LEFT = 280;
const MIN_MIDDLE = 200;
const MAX_MIDDLE = 360;

interface ThreePaneProps {
  left: ReactNode;
  leftRail?: ReactNode;
  middle: ReactNode;
  right: ReactNode;
}

export function ThreePane({ left, leftRail, middle, right }: ThreePaneProps) {
  const [leftWidth, setLeftWidth] = useState(DEFAULT_LEFT);
  const [middleWidth, setMiddleWidth] = useState(DEFAULT_MIDDLE);
  const [hydrated, setHydrated] = useState(false);

  const isTablet = useMediaQuery("(max-width: 1023px)");

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.left === "number") setLeftWidth(clamp(parsed.left, MIN_LEFT, MAX_LEFT));
        if (typeof parsed.middle === "number") setMiddleWidth(clamp(parsed.middle, MIN_MIDDLE, MAX_MIDDLE));
      }
    } catch {}
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ left: leftWidth, middle: middleWidth }));
    } catch {}
  }, [hydrated, leftWidth, middleWidth]);

  const draggingRef = useRef<"left" | "middle" | null>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const onPointerDown = (which: "left" | "middle") => (e: React.PointerEvent) => {
    draggingRef.current = which;
    startXRef.current = e.clientX;
    startWidthRef.current = which === "left" ? leftWidth : middleWidth;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - startXRef.current;
    if (draggingRef.current === "left") {
      setLeftWidth(clamp(startWidthRef.current + dx, MIN_LEFT, MAX_LEFT));
    } else {
      setMiddleWidth(clamp(startWidthRef.current + dx, MIN_MIDDLE, MAX_MIDDLE));
    }
  };

  const onPointerUp = () => {
    draggingRef.current = null;
  };

  return (
    <div className="flex flex-1 min-h-0" onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      {isTablet && leftRail ? (
        leftRail
      ) : (
        <>
          <div style={{ width: leftWidth }} className="shrink-0 overflow-auto bg-[var(--bg-primary)] border-r border-[var(--border)]">
            {left}
          </div>
          <div
            onPointerDown={onPointerDown("left")}
            className="w-1 cursor-col-resize bg-transparent hover:bg-[var(--accent)]/40 transition-colors"
          />
        </>
      )}
      <div style={{ width: middleWidth }} className="shrink-0 overflow-auto bg-[var(--bg-primary)] border-r border-[var(--border)]">
        {middle}
      </div>
      <div
        onPointerDown={onPointerDown("middle")}
        className="w-1 cursor-col-resize bg-transparent hover:bg-[var(--accent)]/40 transition-colors"
      />
      <div className="flex-1 min-w-0 overflow-auto bg-[#FFFDF7] dark:bg-[var(--bg-primary)]">{right}</div>
    </div>
  );
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
