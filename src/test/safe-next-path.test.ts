import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/auth/safe-next-path";

describe("post-login return path", () => {
  it("preserves the Bitget setup destination", () => {
    expect(safeNextPath("/onboarding/bitget/connect")).toBe("/onboarding/bitget/connect");
  });

  it("does not redirect to arbitrary or external paths", () => {
    expect(safeNextPath("//example.com")).toBe("/onboarding");
    expect(safeNextPath("/api/bitget/verify")).toBe("/onboarding");
  });
});
