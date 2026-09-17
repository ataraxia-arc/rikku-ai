import { describe, expect, it } from "vitest";
import { normalizeBitgetPermissionMode, verifyReadOnlyAccount } from "@/lib/bitget/permissions";

describe("Bitget permission mode normalization", () => {
  it.each(["read-only", "read_only", "readonly"])("classifies %s as READ_ONLY", (value) => {
    expect(normalizeBitgetPermissionMode(value)).toBe("READ_ONLY");
  });

  it.each(["read-and-write", "read_and_write", "read-write", "read_write"])(
    "classifies %s as READ_WRITE",
    (value) => {
      expect(normalizeBitgetPermissionMode(value)).toBe("READ_WRITE");
    },
  );

  it.each([null, 123, "unknown-mode"])("classifies unsupported value %s as UNKNOWN", (value) => {
    expect(normalizeBitgetPermissionMode(value)).toBe("UNKNOWN");
  });

  it("trims whitespace and compares case-insensitively", () => {
    expect(normalizeBitgetPermissionMode("  READ_ONLY  ")).toBe("READ_ONLY");
    expect(normalizeBitgetPermissionMode("  Read-And-Write  ")).toBe("READ_WRITE");
  });
});

describe("Bitget permission gate", () => {
  it("accepts a read-only UTA key", () => {
    expect(
      verifyReadOnlyAccount({ userId: "123", permType: "read-only", permissions: ["uta_mgt", "uta_trade"] }),
    ).toEqual({ ok: true, userId: "123", permissions: ["uta_mgt", "uta_trade"] });
  });

  it("rejects any read-and-write key", () => {
    expect(
      verifyReadOnlyAccount({ userId: "123", permType: "read-and-write", permissions: ["uta_trade"] }),
    ).toEqual({ ok: false, reason: "READ_WRITE_KEY" });
  });

  it("rejects forbidden capabilities even if the key is labeled read-only", () => {
    expect(
      verifyReadOnlyAccount({ userId: "123", permType: "read-only", permissions: ["withdraw"] }),
    ).toEqual({ ok: false, reason: "FORBIDDEN_PERMISSION" });
  });
});
