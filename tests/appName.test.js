import { describe, it, expect } from "vitest";
import { generateAppName } from "../src/appName.js";

describe("generateAppName", () => {
  it("matches the CapRover-safe naming shape: lowercase, alphanumeric, hyphen-separated", () => {
    const name = generateAppName();
    expect(name).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
  });

  it("produces different names across calls (not a fixed string)", () => {
    const names = new Set(Array.from({ length: 20 }, () => generateAppName()));
    expect(names.size).toBeGreaterThan(1);
  });
});
