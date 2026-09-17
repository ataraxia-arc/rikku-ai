import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { BitgetGatewayError, BitgetReadOnlyClient } from "@/lib/bitget/client";
import { getBitgetClockOffset } from "@/lib/bitget/server-clock";

const fixtureCredentials = {
  apiKey: "fixture-api-key",
  apiSecret: "fixture-secret-key",
  passphrase: "fixture-passphrase",
};

function bitgetResponse(code: string, status: number) {
  return new Response(JSON.stringify({
    code,
    msg: "private upstream detail must not escape",
    data: null,
  }), {
    status,
    headers: { "x-private-upstream-header": "private upstream header" },
  });
}

describe("Bitget read-only gateway diagnostics", () => {
  it.each([
    ["40006", 401, "BITGET_INVALID_API_KEY", "credential"],
    ["40008", 401, "BITGET_TIMESTAMP_EXPIRED", "timestamp"],
    ["40009", 401, "BITGET_SIGNATURE_ERROR", "signature"],
    ["40017", 400, "BITGET_PARAMETER_ERROR", "parameter"],
    ["25000", 504, "BITGET_SYSTEM_TIMEOUT", "system"],
    ["25001", 504, "BITGET_SYSTEM_TIMEOUT", "system"],
  ] as const)("classifies Bitget code %s without exposing upstream details", async (code, status, safeCode, category) => {
    const fetcher = vi.fn().mockResolvedValue(bitgetResponse(code, status));
    const client = new BitgetReadOnlyClient(fixtureCredentials, fetcher as unknown as typeof fetch);

    let caught: unknown;
    try {
      await client.get("/api/v3/account/info");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BitgetGatewayError);
    const gatewayError = caught as BitgetGatewayError;
    expect(gatewayError.safeCode).toBe(safeCode);
    expect(gatewayError.diagnostic).toMatchObject({
      category,
      requestPath: "/api/v3/account/info",
      httpStatus: status,
      bitgetCode: code,
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(gatewayError)).not.toContain("private upstream");
    expect(gatewayError.message).not.toContain("private upstream");
  });

  it("classifies HTTP 429 even when Bitget does not return a usable envelope", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }));
    const client = new BitgetReadOnlyClient(fixtureCredentials, fetcher as unknown as typeof fetch);

    await expect(client.get("/api/v3/account/info")).rejects.toMatchObject({
      safeCode: "BITGET_RATE_LIMITED",
      diagnostic: {
        category: "rate_limit",
        requestPath: "/api/v3/account/info",
        httpStatus: 429,
      },
    });
  });

  it("sends the exact account-info URL, millisecond timestamp, and a GET with no body", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: "00000",
      data: { userId: "fixture-user", permType: "read-only", permissions: [] },
    }), { status: 200 }));
    const client = new BitgetReadOnlyClient(fixtureCredentials, fetcher as unknown as typeof fetch, () => 1_700_000_000_000);

    await client.get("/api/v3/account/info");

    const [url, options] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.bitget.com/api/v3/account/info");
    expect(options.method).toBe("GET");
    expect(options).not.toHaveProperty("body");
    const headers = options.headers as Record<string, string>;
    expect(headers["ACCESS-TIMESTAMP"]).toBe("1700000000000");
    expect(headers["ACCESS-KEY"]).toBe(fixtureCredentials.apiKey);
    expect(headers["ACCESS-PASSPHRASE"]).toBe(fixtureCredentials.passphrase);
    expect(headers["ACCESS-SIGN"]).toBe(
      createHmac("sha256", fixtureCredentials.apiSecret)
        .update("1700000000000GET/api/v3/account/info")
        .digest("base64"),
    );
  });

  it("signs the same canonical query sent on the URL and forwards values unchanged", async () => {
    const credentials = {
      apiKey: "fixture-key-with-no-transformation",
      apiSecret: "fixture-secret-with-trailing-space ",
      passphrase: "passphrase with spaces",
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "00000", data: [] }), { status: 200 }));
    const client = new BitgetReadOnlyClient(credentials, fetcher as unknown as typeof fetch, () => 1_700_000_000_001);

    await client.get("/api/v3/trade/fills", { symbol: "BTC/USDT", category: "SPOT", cursor: undefined });

    const [url, options] = fetcher.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    const pathAndQuery = "/api/v3/trade/fills?category=SPOT&symbol=BTC%2FUSDT";
    expect(url).toBe(`https://api.bitget.com${pathAndQuery}`);
    expect(options.method).toBe("GET");
    expect(options).not.toHaveProperty("body");
    expect(headers["ACCESS-KEY"]).toBe(credentials.apiKey);
    expect(headers["ACCESS-PASSPHRASE"]).toBe(credentials.passphrase);
    expect(headers["ACCESS-SIGN"]).toBe(
      createHmac("sha256", credentials.apiSecret)
        .update(`1700000000001GET${pathAndQuery}`)
        .digest("base64"),
    );
  });
});

describe("Bitget public server-clock lookup", () => {
  it("uses the midpoint of the request to measure clock offset", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: "00000",
      data: { serverTime: "1700000000100" },
    }), { status: 200 }));
    const now = vi.fn()
      .mockReturnValueOnce(1_700_000_000_000)
      .mockReturnValueOnce(1_700_000_000_080);

    await expect(getBitgetClockOffset(fetcher as unknown as typeof fetch, now)).resolves.toBe(60);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe("https://api.bitget.com/api/v2/public/time");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", cache: "no-store" });
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty("body");
  });
});
