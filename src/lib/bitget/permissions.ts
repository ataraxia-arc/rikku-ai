import type { BitgetAccountInfo } from "@/lib/bitget/types";

const forbiddenPermissions = new Set([
  "withdraw",
  "transfer",
  "copy_futures_order",
]);

const requiredReadPermissions = ["uta_mgt", "uta_trade"] as const;

export type NormalizedPermissionMode = "READ_ONLY" | "READ_WRITE" | "UNKNOWN";

export function normalizeBitgetPermissionMode(value: unknown): NormalizedPermissionMode {
  if (typeof value !== "string") return "UNKNOWN";

  switch (value.trim().toLowerCase()) {
    case "read-only":
    case "read_only":
    case "readonly":
      return "READ_ONLY";
    case "read-and-write":
    case "read_and_write":
    case "read-write":
    case "read_write":
      return "READ_WRITE";
    default:
      return "UNKNOWN";
  }
}

export type ReadOnlyCheck =
  | { ok: true; userId: string; permissions: string[] }
  | { ok: false; reason: "READ_WRITE_KEY" | "UNVERIFIABLE_PERMISSION_MODE" | "FORBIDDEN_PERMISSION" | "MISSING_REQUIRED_PERMISSIONS" };

export function verifyReadOnlyAccount(info: BitgetAccountInfo): ReadOnlyCheck {
  const mode = normalizeBitgetPermissionMode(info.permType);
  if (mode === "READ_WRITE") return { ok: false, reason: "READ_WRITE_KEY" };
  if (mode === "UNKNOWN") return { ok: false, reason: "UNVERIFIABLE_PERMISSION_MODE" };

  const permissions = new Set(info.permissions.map((permission) => permission.toLowerCase()));
  if ([...permissions].some((permission) => forbiddenPermissions.has(permission))) {
    return { ok: false, reason: "FORBIDDEN_PERMISSION" };
  }
  if (requiredReadPermissions.some((permission) => !permissions.has(permission))) {
    return { ok: false, reason: "MISSING_REQUIRED_PERMISSIONS" };
  }
  return { ok: true, userId: info.userId, permissions: info.permissions };
}
