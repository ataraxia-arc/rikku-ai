const allowedPostLoginPaths = new Set([
  "/onboarding",
  "/onboarding/bitget",
  "/onboarding/bitget/connect",
]);

export function safeNextPath(value: unknown) {
  return typeof value === "string" && allowedPostLoginPaths.has(value)
    ? value
    : "/onboarding";
}
