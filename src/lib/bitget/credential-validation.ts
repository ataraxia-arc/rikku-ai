import { bitgetCredentialsSchema, type BitgetCredentials } from "@/lib/bitget/types";

export const credentialFieldNames = ["apiKey", "apiSecret", "passphrase"] as const;
export type CredentialFieldName = (typeof credentialFieldNames)[number];
export type CredentialFieldErrors = Partial<Record<CredentialFieldName, string>>;

const fieldLabels: Record<CredentialFieldName, string> = {
  apiKey: "API key",
  apiSecret: "API secret",
  passphrase: "API passphrase",
};

export function validateBitgetCredentials(input: unknown):
  | { ok: true; data: BitgetCredentials }
  | { ok: false; fieldErrors: CredentialFieldErrors } {
  const parsed = bitgetCredentialsSchema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };

  const values = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const fieldErrors: CredentialFieldErrors = {};
  for (const field of credentialFieldNames) {
    const value = values[field];
    if (typeof value !== "string" || !value.trim()) {
      fieldErrors[field] = `${fieldLabels[field]} is required.`;
    } else if (parsed.error.issues.some((issue) => issue.path[0] === field)) {
      fieldErrors[field] = `Enter a valid ${fieldLabels[field]}.`;
    }
  }
  return { ok: false, fieldErrors };
}
