import { describe, expect, it } from "bun:test";
import { parseDuration, parseDurationOrThrow } from "@/config/duration";

describe("parseDuration (shared config duration parser)", () => {
  it("parses every unit and compounds", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("1m30s")).toBe(90_000);
    expect(parseDuration("1h2m3s4ms")).toBe(3_723_004);
  });

  it("rejects anything that is not a positive sequence of <int><unit>", () => {
    for (const bad of ["", "30", "ms", "0s", "0ms0s", "1.5s", "-1s", "+1s", " 1s", "1s ", "1 s", "1d", "1sx", "abc"]) {
      expect(parseDuration(bad)).toBeUndefined();
    }
  });

  it("parseDurationOrThrow names the field", () => {
    expect(() => parseDurationOrThrow("requestTimeout", "500x")).toThrow(/^requestTimeout: invalid duration "500x"/);
  });
});
