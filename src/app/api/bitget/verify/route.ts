import { NextResponse } from "next/server";
import { BitgetReadOnlyClient, BitgetGatewayError } from "@/lib/bitget/client";
import { getBitgetClockOffset } from "@/lib/bitget/server-clock";
import { validateBitgetCredentials } from "@/lib/bitget/credential-validation";
import { normalizeBitgetPermissionMode, verifyReadOnlyAccount } from "@/lib/bitget/permissions";
import { bitgetAccountInfoSchema } from "@/lib/bitget/types";
import { encryptBitgetCredentials, fingerprintApiKey, parseCredentialEncryptionKey } from "@/lib/security/credential-vault-server";
import { takeRateLimit } from "@/lib/security/rate-limit";
import { withSafeRequestLog } from "@/lib/security/safe-request-log";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function asBytea(base64: string) {
  return `\\x${Buffer.from(base64, "base64").toString("hex")}`;
}

function jsonError(status: number, code: string, retryAfter?: number) {
  return NextResponse.json(
    { ok: false, code },
    {
      status,
      headers: retryAfter ? { "Retry-After": String(retryAfter) } : undefined,
    },
  );
}

async function authenticatedClient() {
  if (!isSupabaseConfigured()) return { error: jsonError(503, "SUPABASE_NOT_CONFIGURED") } as const;

  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    if (!data.user) return { error: jsonError(401, "AUTH_REQUIRED") } as const;
    return { supabase, user: data.user } as const;
  } catch {
    return { error: jsonError(503, "AUTH_UNAVAILABLE") } as const;
  }
}

function secureStorageReady() {
  try {
    parseCredentialEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

function observedTypeAtPath(value: unknown, path: PropertyKey[]) {
  const observed = path.reduce<unknown>((current, key) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<PropertyKey, unknown>)[key];
  }, value);
  if (observed === null) return "null";
  if (Array.isArray(observed)) return "array";
  return typeof observed;
}

function safePermissionModeForLog(value: unknown) {
  return typeof value === "string" && /^[A-Za-z _-]{1,64}$/.test(value) ? value : null;
}

function permissionModeJsonType(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value === undefined) return "missing";
  return typeof value;
}

export async function POST(request: Request) {
  return withSafeRequestLog("connection.verify", (requestId) => verifyConnection(request, requestId));
}

async function verifyConnection(request: Request, requestId: string) {
  const auth = await authenticatedClient();
  if (auth.error) return auth.error;
  const { supabase, user } = auth;

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 4096) return jsonError(413, "REQUEST_TOO_LARGE");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "INVALID_REQUEST");
  }

  const parsedCredentials = validateBitgetCredentials(body);
  if (!parsedCredentials.ok) return jsonError(400, "INVALID_CREDENTIAL_FIELDS");
  if (!secureStorageReady()) return jsonError(503, "SECURE_STORAGE_UNAVAILABLE");

  const rateLimit = takeRateLimit(`bitget-verify:${user.id}`);
  if (!rateLimit.allowed) return jsonError(429, "RATE_LIMITED", rateLimit.retryAfterSeconds);

  try {
    const clockOffsetMs = await getBitgetClockOffset();
    const client = new BitgetReadOnlyClient(parsedCredentials.data, fetch, () => Date.now() + clockOffsetMs);
    const { data: rawAccount, metadata } = await client.getWithMetadata<unknown>("/api/v3/account/info");
    if (metadata.httpStatus !== 200) {
      console.warn(JSON.stringify({
        event: "rikku.bitget.unexpected_success_status",
        requestId,
        requestPath: "/api/v3/account/info",
        httpStatus: metadata.httpStatus,
        bitgetCode: metadata.bitgetCode ?? null,
      }));
      return jsonError(502, "INVALID_BITGET_RESPONSE");
    }
    const rawPermissionMode = rawAccount && typeof rawAccount === "object" && !Array.isArray(rawAccount)
      ? (rawAccount as Record<string, unknown>).permType
      : undefined;
    // Temporary controlled diagnostic: permission mode only, never credentials or account values.
    console.info(JSON.stringify({
      requestId,
      permType: safePermissionModeForLog(rawPermissionMode),
      permTypeJsonType: permissionModeJsonType(rawPermissionMode),
      normalizedMode: normalizeBitgetPermissionMode(rawPermissionMode),
    }));
    const account = bitgetAccountInfoSchema.safeParse(rawAccount);
    if (!account.success) {
      const schemaFailures = account.error.issues.map((issue) => ({
        path: issue.path.join("."),
        reason: issue.code,
        observedType: observedTypeAtPath(rawAccount, issue.path),
      }));
      const permissionModeOnly = account.error.issues.every((issue) => issue.path[0] === "permType");
      console.warn(JSON.stringify({
        event: "rikku.bitget.parser_failure",
        requestId,
        requestPath: "/api/v3/account/info",
        httpStatus: metadata.httpStatus,
        bitgetCode: metadata.bitgetCode ?? null,
        category: permissionModeOnly ? "unverifiable_permission_mode" : "schema",
        topLevelKeys: metadata.topLevelKeys,
        dataKeys: metadata.dataKeys,
        schemaFailurePaths: schemaFailures.map((failure) => failure.path),
        schemaFailures,
      }));
      return permissionModeOnly
        ? jsonError(422, "UNVERIFIABLE_PERMISSION_MODE")
        : jsonError(502, "INVALID_BITGET_RESPONSE");
    }

    const permissionCheck = verifyReadOnlyAccount(account.data);
    if (!permissionCheck.ok) return jsonError(422, permissionCheck.reason);

    let encrypted;
    try {
      encrypted = encryptBitgetCredentials(parsedCredentials.data);
    } catch {
      return jsonError(503, "SECURE_STORAGE_UNAVAILABLE");
    }

    const apiKeyFingerprint = fingerprintApiKey(parsedCredentials.data.apiKey);
    const { error: storageError } = await supabase.rpc("upsert_bitget_connection", {
      p_credential_ciphertext: asBytea(encrypted.credentialCiphertext),
      p_credential_iv: asBytea(encrypted.credentialIv),
      p_credential_auth_tag: asBytea(encrypted.credentialAuthTag),
      p_wrapped_data_key: asBytea(encrypted.wrappedDataKey),
      p_wrapped_data_key_iv: asBytea(encrypted.wrappedDataKeyIv),
      p_key_version: encrypted.keyVersion,
      p_api_key_fingerprint: apiKeyFingerprint,
      p_external_uid: permissionCheck.userId,
      p_adapter_version: "uta-v3",
    });
    if (storageError) return jsonError(503, "SECURE_STORAGE_UNAVAILABLE");

    return NextResponse.json({
      ok: true,
      connection: {
        permission: "read-only",
        adapterVersion: "uta-v3",
      },
    });
  } catch (error) {
    if (error instanceof BitgetGatewayError) {
      const diagnostic = error.diagnostic;
      console.warn(JSON.stringify({
        event: "rikku.bitget.gateway",
        requestId,
        requestPath: diagnostic.requestPath,
        httpStatus: diagnostic.httpStatus ?? null,
        bitgetCode: diagnostic.bitgetCode ?? null,
        category: diagnostic.category,
        durationMs: diagnostic.durationMs,
        topLevelKeys: diagnostic.topLevelKeys,
        dataKeys: diagnostic.dataKeys,
        schemaFailurePaths: diagnostic.schemaFailurePaths,
      }));
      return NextResponse.json({
        ok: false,
        code: error.safeCode,
        category: diagnostic.category,
        bitgetCode: diagnostic.bitgetCode ?? null,
      }, { status: error.safeCode === "BITGET_RATE_LIMITED" ? 429 : 502 });
    }
    return jsonError(500, "VERIFICATION_FAILED");
  }
}

export async function GET() {
  return withSafeRequestLog("connection.status", readConnectionStatus);
}

async function readConnectionStatus() {
  const auth = await authenticatedClient();
  if (auth.error) return auth.error;
  const { supabase } = auth;
  if (!secureStorageReady()) return jsonError(503, "SECURE_STORAGE_UNAVAILABLE");

  const { data, error } = await supabase.rpc("get_verified_bitget_connection_status");
  if (error?.code === "PGRST202") {
    // Preserve the live connection status while migration 003 is being
    // installed. This RPC reads the same private row, but lacks its safe ID.
    const legacy = await supabase.rpc("get_bitget_connection_status");
    if (legacy.error) return jsonError(503, "SECURE_STORAGE_UNAVAILABLE");
    const row = Array.isArray(legacy.data) ? legacy.data[0] : legacy.data;
    const verified = Boolean(row?.connected && row?.verified_at);
    return NextResponse.json({
      ok: true, connected: verified, verified,
      storageReady: true, verifiedAt: row?.verified_at ?? null,
      lastSyncedAt: row?.last_synced_at ?? null,
    });
  }
  if (error) return jsonError(503, "SECURE_STORAGE_UNAVAILABLE");

  const status = Array.isArray(data) ? data[0] : data;
  return NextResponse.json({
    ok: true,
    connected: Boolean(status?.verified),
    verified: Boolean(status?.verified),
    storageReady: true,
    verifiedAt: status?.verified_at ?? null,
    lastSyncedAt: status?.last_synced_at ?? null,
  });
}

export async function DELETE() {
  return withSafeRequestLog("connection.disconnect", disconnectConnection);
}

async function disconnectConnection() {
  const auth = await authenticatedClient();
  if (auth.error) return auth.error;
  const { supabase } = auth;

  const { error } = await supabase.rpc("revoke_bitget_connection");
  if (error) return jsonError(503, "SECURE_STORAGE_UNAVAILABLE");
  return NextResponse.json({ ok: true, connected: false });
}
