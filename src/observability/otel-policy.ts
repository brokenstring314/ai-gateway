/**
 * OTel sampling, privacy and shutdown policy helpers.
 */

import { redactMessage } from "./redact.js";

export interface TracingPolicy {
  sampleRatio: number;
  privacyLevel: "none" | "metadata" | "full";
  shutdownGraceMs: number;
  headers?: Record<string, string>;
}

/** FNV-1a 32-bit hash — stable across calls and processes. */
function hashTraceId(traceId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < traceId.length; i++) {
    hash ^= traceId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function shouldSample(sampleRatio: number, traceId?: string): boolean {
  if (sampleRatio <= 0) return false;
  if (sampleRatio >= 1) return true;
  if (traceId === undefined || traceId.length === 0) {
    return Math.random() < sampleRatio;
  }
  return hashTraceId(traceId) / 0xffffffff < sampleRatio;
}

export function applyPrivacy(message: string, level: "none" | "metadata" | "full"): string {
  if (level === "metadata") return redactMessage(message, "metadata");
  return message;
}

const DURATION_RE = /^(\d+)\s*(ms|s|m|h)$/;

function unitMultiplierMs(unit: string): number | undefined {
  switch (unit) {
    case "ms":
      return 1;
    case "s":
      return 1_000;
    case "m":
      return 60_000;
    case "h":
      return 3_600_000;
    default:
      return undefined;
  }
}

export function parseShutdownGrace(value: string | undefined, fallbackMs?: number): number {
  const fallback = fallbackMs ?? 10_000;
  if (value === undefined) return fallback;

  const match = DURATION_RE.exec(value.trim());
  if (match === null) return fallback;

  const amountStr = match[1];
  if (amountStr === undefined) return fallback;

  const multiplier = unitMultiplierMs(match[2] ?? "");
  if (multiplier === undefined) return fallback;

  return Number(amountStr) * multiplier;
}

export function policyHeaders(policy: TracingPolicy): Record<string, string> {
  return policy.headers ?? {};
}
