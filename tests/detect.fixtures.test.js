import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectFramework } from "../src/detect.js";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

// Each fixture is a real, buildable app — see build.test.js for the Docker tier.
const EXPECTED = {
  vite: "vite",
  nextjs: "nextjs",
  node: "node",
  python: "python",
  static: "static",
  dockerfile: "dockerfile",
};

describe("detectFramework against real fixtures", () => {
  for (const [name, framework] of Object.entries(EXPECTED)) {
    it(`detects ${framework} for fixtures/${name}`, () => {
      const result = detectFramework(join(FIXTURES, name));
      expect(result.framework).toBe(framework);
      // Snapshot the full captain-definition so any change to a generated
      // Dockerfile is surfaced for review rather than silently shipped.
      expect(result.captainDef).toMatchSnapshot();
    });
  }
});
