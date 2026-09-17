import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/security/rate-limit", () => ({ takeRateLimit: vi.fn(() => ({ allowed: true })) }));
vi.mock("@/lib/bitget/server-clock", () => ({ getBitgetClockOffset: vi.fn().mockResolvedValue(0) }));

import { GET, POST } from "@/app/api/bitget/verify/route";
import { BitgetGatewayError } from "@/lib/bitget/client";
import { getBitgetClockOffset } from "@/lib/bitget/server-clock";
import { createSupabaseServerClient } from "@/lib/supabase/server";

describe("Bitget connection API configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const validCredentials = { apiKey: "test-api-key", apiSecret: "test-secret-key", passphrase: "test-passphrase" };
  const documentedReadOnlyAccountResponse = {
    code: "00000",
    msg: "success",
    requestTime: 1744617600000,
    data: {
      userId: "fixture-bitget-user",
      inviterId: "fixture-inviter",
      parentId: "",
      channelCode: "fixture-channel",
      channel: "official",
      ips: "192.0.2.10",
      permType: "read-only",
      permissions: ["uta_mgt", "uta_trade"],
      regisTime: "1704067200000",
    },
  };

  function setReadyAuth(user: { id: string } | null = { id: "user-1" }) {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    vi.stubEnv("BITGET_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const rpc = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: async () => ({ data: { user } }) },
      rpc,
    } as never);
    return rpc;
  }

  function submit(credentials: unknown) {
    return POST(new Request("http://localhost/api/bitget/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    }));
  }

  it.each([
    ["all fields empty", { apiKey: "", apiSecret: "", passphrase: "" }],
    ["one field missing", { apiKey: "test-api-key", apiSecret: "", passphrase: "test-passphrase" }],
    ["malformed input", { apiKey: "short", apiSecret: "test-secret-key", passphrase: "test-passphrase" }],
  ])("rejects %s before Bitget or persistence", async (_label, credentials) => {
    const rpc = setReadyAuth();
    const bitgetFetch = vi.fn();
    vi.stubGlobal("fetch", bitgetFetch);

    const response = await submit(credentials);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, code: "INVALID_CREDENTIAL_FIELDS" });
    expect(bitgetFetch).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("classifies an expired RIKKU session before any Bitget or persistence call", async () => {
    const rpc = setReadyAuth(null);
    const bitgetFetch = vi.fn();
    vi.stubGlobal("fetch", bitgetFetch);

    const response = await submit(validCredentials);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, code: "AUTH_REQUIRED" });
    expect(bitgetFetch).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("classifies Bitget credential/signature rejection without persisting", async () => {
    const rpc = setReadyAuth();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: "40009", msg: "signature error", data: null,
    }), { status: 401, headers: { "x-upstream-secret": "not-for-browser" } })));

    const response = await submit(validCredentials);
    expect(response.status).toBe(502);
    const result = await response.json();
    expect(result).toEqual({ ok: false, code: "BITGET_SIGNATURE_ERROR", category: "signature", bitgetCode: "40009" });
    expect(JSON.stringify(result)).not.toContain("signature error");
    expect(JSON.stringify(result)).not.toContain("not-for-browser");
    expect(rpc).not.toHaveBeenCalled();
    expect(response.headers.get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
    expect(warning).toHaveBeenCalledTimes(2);
    const logged = warning.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain(response.headers.get("X-Request-ID"));
    const gatewayLog = warning.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .find((record) => record.event === "rikku.bitget.gateway");
    expect(gatewayLog).toMatchObject({
      requestId: response.headers.get("X-Request-ID"),
      requestPath: "/api/v3/account/info",
      httpStatus: 401,
      bitgetCode: "40009",
      category: "signature",
      durationMs: expect.any(Number),
    });
    for (const sensitive of [validCredentials.apiKey, validCredentials.apiSecret, validCredentials.passphrase, "signature error", "not-for-browser"]) {
      expect(logged).not.toContain(sensitive);
    }
  });

  it("classifies a plain HTTP 401 as rejected credentials without reflecting its body", async () => {
    const rpc = setReadyAuth();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private upstream text", { status: 401 })));

    const response = await submit(validCredentials);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, code: "UPSTREAM_REJECTED", category: "credential", bitgetCode: null });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("classifies an upstream Bitget failure without persisting", async () => {
    const rpc = setReadyAuth();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private network detail")));

    const response = await submit(validCredentials);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, code: "UPSTREAM_UNAVAILABLE", category: "network", bitgetCode: null });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not verify or store credentials when public server-time synchronization fails", async () => {
    const rpc = setReadyAuth();
    vi.mocked(getBitgetClockOffset).mockRejectedValueOnce(new BitgetGatewayError("CLOCK_SYNC_UNAVAILABLE", {
      category: "clock", requestPath: "/api/v2/public/time", durationMs: 10,
    }));
    const bitgetFetch = vi.fn();
    vi.stubGlobal("fetch", bitgetFetch);

    const response = await submit(validCredentials);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, code: "CLOCK_SYNC_UNAVAILABLE", category: "clock", bitgetCode: null });
    expect(bitgetFetch).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not silently trim an API key before verification", async () => {
    const rpc = setReadyAuth();
    const bitgetFetch = vi.fn();
    vi.stubGlobal("fetch", bitgetFetch);

    const response = await submit({ ...validCredentials, apiKey: ` ${validCredentials.apiKey}` });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, code: "INVALID_CREDENTIAL_FIELDS" });
    expect(bitgetFetch).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("classifies a Bitget 5xx response as unavailable without reflecting its headers", async () => {
    const rpc = setReadyAuth();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream failure", {
      status: 503,
      headers: { "x-private-header": "not-for-browser" },
    })));

    const response = await submit(validCredentials);
    expect(response.status).toBe(502);
    const result = await response.json();
    expect(result).toEqual({ ok: false, code: "UPSTREAM_UNAVAILABLE", category: "system", bitgetCode: null });
    expect(JSON.stringify(result)).not.toContain("not-for-browser");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("requires HTTP 200 even when a different 2xx response has a success code", async () => {
    const rpc = setReadyAuth();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(documentedReadOnlyAccountResponse), { status: 201 })));

    const response = await submit(validCredentials);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, code: "INVALID_BITGET_RESPONSE" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(["read-and-write", "read_and_write", "read-write", "read_write"])(
    "rejects write-enabled mode %s without persisting",
    async (permType) => {
    const rpc = setReadyAuth();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...documentedReadOnlyAccountResponse,
      data: { ...documentedReadOnlyAccountResponse.data, permType },
    }), { status: 200 })));

    const response = await submit(validCredentials);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, code: "READ_WRITE_KEY" });
    expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("returns a clear JSON error when Supabase configuration is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");

    const statusResponse = await GET();
    expect(statusResponse.status).toBe(503);
    expect(await statusResponse.json()).toEqual({ ok: false, code: "SUPABASE_NOT_CONFIGURED" });

    const submitResponse = await POST(new Request("http://localhost/api/bitget/verify", { method: "POST" }));
    expect(submitResponse.status).toBe(503);
    expect(await submitResponse.json()).toEqual({ ok: false, code: "SUPABASE_NOT_CONFIGURED" });
  });

  it("returns a clear JSON error when encrypted storage is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    vi.stubEnv("BITGET_CREDENTIAL_ENCRYPTION_KEY", "");
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    } as never);

    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, code: "SECURE_STORAGE_UNAVAILABLE" });
  });

  it("verifies and stores only a read-only key through the existing endpoint", async () => {
    const rpc = setReadyAuth();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const bitgetFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(documentedReadOnlyAccountResponse), { status: 200 }));
    vi.stubGlobal("fetch", bitgetFetch);

    const response = await submit(validCredentials);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result).toMatchObject({ ok: true, connection: { externalUid: "fixture-bitget-user", permission: "read-only" } });
    expect(JSON.stringify(result)).not.toContain("test-secret-key");
    expect(bitgetFetch).toHaveBeenCalledOnce();
    expect(bitgetFetch.mock.calls[0][1].method).toBe("GET");
    expect(rpc).toHaveBeenCalledWith("upsert_bitget_connection", expect.objectContaining({ p_external_uid: "fixture-bitget-user" }));
    const stored = JSON.stringify(rpc.mock.calls[0][1]);
    expect(stored).not.toContain(validCredentials.apiKey);
    expect(stored).not.toContain(validCredentials.apiSecret);
    expect(stored).not.toContain(validCredentials.passphrase);
    expect(response.headers.get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
    expect(info).toHaveBeenCalledTimes(2);
    const permissionDiagnostic = JSON.parse(String(info.mock.calls[0][0])) as Record<string, unknown>;
    expect(permissionDiagnostic).toEqual({
      requestId: response.headers.get("X-Request-ID"),
      permType: "read-only",
      permTypeJsonType: "string",
      normalizedMode: "READ_ONLY",
    });
    const logged = info.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain(response.headers.get("X-Request-ID"));
    expect(logged).not.toContain(validCredentials.apiKey);
    expect(logged).not.toContain(validCredentials.apiSecret);
    expect(logged).not.toContain(validCredentials.passphrase);
    expect(logged).not.toContain(documentedReadOnlyAccountResponse.data.ips);
  });

  it("accepts minimal account-info data without optional account fields", async () => {
    const rpc = setReadyAuth();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: "00000",
      data: { userId: "fixture-minimal-user", permType: "read-only", permissions: ["uta_mgt", "uta_trade"] },
    }), { status: 200 })));

    const response = await submit(validCredentials);
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("upsert_bitget_connection", expect.objectContaining({ p_external_uid: "fixture-minimal-user" }));
  });

  it.each(["read_only", "readonly"])("accepts the documented %s spelling only with both required read scopes", async (permType) => {
    const rpc = setReadyAuth();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...documentedReadOnlyAccountResponse,
      data: { ...documentedReadOnlyAccountResponse.data, permType },
    }), { status: 200 })));

    const response = await submit(validCredentials);
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("upsert_bitget_connection", expect.objectContaining({ p_external_uid: "fixture-bitget-user" }));
  });

  it.each([
    { permissions: ["uta_mgt"] },
    { permissions: ["uta_trade"] },
    { permissions: [] },
  ])("rejects read-only mode without both required scopes: $permissions", async ({ permissions }) => {
    const rpc = setReadyAuth();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...documentedReadOnlyAccountResponse,
      data: { ...documentedReadOnlyAccountResponse.data, permissions },
    }), { status: 200 })));

    const response = await submit(validCredentials);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, code: "MISSING_REQUIRED_PERMISSIONS" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed with a specific error for the observed account-info shape and an unrecognized permission mode", async () => {
    const rpc = setReadyAuth();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    // The real request logged these key names and the failing path, but not the mode value or type.
    const syntheticAccountResponse = {
      ...documentedReadOnlyAccountResponse,
      data: { ...documentedReadOnlyAccountResponse.data, permType: "synthetic-unrecognized-mode" },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(syntheticAccountResponse), { status: 200 })));

    const response = await submit(validCredentials);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, code: "UNVERIFIABLE_PERMISSION_MODE" });
    expect(rpc).not.toHaveBeenCalled();

    const diagnostic = JSON.parse(String(info.mock.calls[0][0])) as Record<string, unknown>;
    expect(diagnostic).toEqual({
      requestId: response.headers.get("X-Request-ID"),
      permType: "synthetic-unrecognized-mode",
      permTypeJsonType: "string",
      normalizedMode: "UNKNOWN",
    });
    const logged = info.mock.calls.map((call) => String(call[0])).join("\n");
    for (const sensitive of [validCredentials.apiKey, validCredentials.apiSecret, validCredentials.passphrase, syntheticAccountResponse.data.userId, syntheticAccountResponse.data.ips]) {
      expect(logged).not.toContain(sensitive);
    }
  });

  it("does not treat a null permission mode as read-only", async () => {
    const rpc = setReadyAuth();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...documentedReadOnlyAccountResponse,
      data: { ...documentedReadOnlyAccountResponse.data, permType: null },
    }), { status: 200 })));

    const response = await submit(validCredentials);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, code: "UNVERIFIABLE_PERMISSION_MODE" });
    expect(rpc).not.toHaveBeenCalled();
    expect(JSON.parse(String(info.mock.calls[0][0]))).toEqual({
      requestId: response.headers.get("X-Request-ID"),
      permType: null,
      permTypeJsonType: "null",
      normalizedMode: "UNKNOWN",
    });
  });

  it("rejects a numeric permission mode without storing credentials or logging its value", async () => {
    const rpc = setReadyAuth();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...documentedReadOnlyAccountResponse,
      data: { ...documentedReadOnlyAccountResponse.data, permType: 123 },
    }), { status: 200 })));

    const response = await submit(validCredentials);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, code: "UNVERIFIABLE_PERMISSION_MODE" });
    expect(rpc).not.toHaveBeenCalled();
    expect(JSON.parse(String(info.mock.calls[0][0]))).toEqual({
      requestId: response.headers.get("X-Request-ID"),
      permType: null,
      permTypeJsonType: "number",
      normalizedMode: "UNKNOWN",
    });
  });

  it("logs field names and schema paths, never values, when account-info data is malformed", async () => {
    const rpc = setReadyAuth();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...documentedReadOnlyAccountResponse,
      data: { uid: "private-uid-value", permType: "read-only", permissions: ["uta_mgt", "uta_trade"], ips: "private-ip-value" },
    }), { status: 200, headers: { "x-private-header": "private-header-value" } })));

    const response = await submit(validCredentials);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, code: "INVALID_BITGET_RESPONSE" });
    expect(rpc).not.toHaveBeenCalled();
    const records = warning.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    const parserRecord = records.find((record) => record.event === "rikku.bitget.parser_failure");
    expect(parserRecord).toMatchObject({
      requestId: response.headers.get("X-Request-ID"),
      requestPath: "/api/v3/account/info",
      httpStatus: 200,
      bitgetCode: "00000",
      topLevelKeys: ["code", "data", "msg", "requestTime"],
      dataKeys: ["ips", "permType", "permissions", "uid"],
      schemaFailurePaths: ["userId"],
    });
    const logged = JSON.stringify(records);
    for (const sensitive of [validCredentials.apiKey, validCredentials.apiSecret, validCredentials.passphrase, "private-uid-value", "private-ip-value", "private-header-value"]) {
      expect(logged).not.toContain(sensitive);
    }
  });
});
