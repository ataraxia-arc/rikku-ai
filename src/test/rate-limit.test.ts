import { beforeEach, describe, expect, it } from "vitest";
import { clearRateLimitsForTests, takeRateLimit } from "@/lib/security/rate-limit";

describe("sensitive endpoint rate limit", () => {
  beforeEach(() => clearRateLimitsForTests());

  it("blocks attempts above the configured window limit", () => {
    expect(takeRateLimit("user", 2, 60_000, 1_000).allowed).toBe(true);
    expect(takeRateLimit("user", 2, 60_000, 1_001).allowed).toBe(true);
    expect(takeRateLimit("user", 2, 60_000, 1_002)).toMatchObject({ allowed: false, remaining: 0 });
  });

  it("opens a fresh bucket after the window expires", () => {
    takeRateLimit("user", 1, 1_000, 1_000);
    expect(takeRateLimit("user", 1, 1_000, 2_000).allowed).toBe(true);
  });
});
