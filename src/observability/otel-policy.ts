/**
 * OTel sampling, privacy and shutdown policy helpers.
 */

import { parseDuration } from "../config/duration.js";
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

/** Shutdown grace in ms (shared duration parser); fallback when unset or invalid. */
export function parseShutdownGrace(value: string | undefined, fallbackMs?: number): number {
  const fallback = fallbackMs ?? 10_000;
  if (value === undefined) return fallback;
  return parseDuration(value.trim()) ?? fallback;
}

export function policyHeaders(policy: TracingPolicy): Record<string, string> {
  return policy.headers ?? {};
}
