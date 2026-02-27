import { describe, expect, test } from "bun:test";
import { calculateBackoffMs } from "../pipeline/retry.js";

describe("calculateBackoffMs", () => {
  test("returns bounded jittered exponential delay", () => {
    const first = calculateBackoffMs(1, 100, 800);
    const second = calculateBackoffMs(2, 100, 800);
    const fifth = calculateBackoffMs(5, 100, 800);

    expect(first).toBeGreaterThanOrEqual(100);
    expect(first).toBeLessThan(150);

    expect(second).toBeGreaterThanOrEqual(200);
    expect(second).toBeLessThan(300);

    expect(fifth).toBeGreaterThanOrEqual(800);
    expect(fifth).toBeLessThan(1200);
  });
});
