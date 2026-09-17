import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { BitgetReadOnlyClient } from "@/lib/bitget/client";

const credentials = { apiKey: "test-api-key", apiSecret: "test-secret-key", passphrase: "test-passphrase" };

describe("Bitget read-only gateway", () => {
  it.each([
    "/api/v3/trade/place-order",
    "/api/v3/trade/cancel-order",
    "/api/v3/account/set-leverage",
    "/api/v3/account/transfer",
    "/api/v3/account/withdraw",
    "https://example.invalid/api/v3/account/info",
  ])("rejects a mutating or arbitrary path before making a request: %s", async (path) => {
    const fetcher = vi.fn();
    const client = new BitgetReadOnlyClient(credentials, fetcher as unknown as typeof fetch);

    await expect(client.get(path)).rejects.toMatchObject({ safeCode: "PATH_NOT_ALLOWED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses only GET for an allowlisted account lookup", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: "00000", data: { userId: "123", permType: "read-only", permissions: [] },
    }), { status: 200 }));
    const client = new BitgetReadOnlyClient(credentials, fetcher as unknown as typeof fetch, () => 1700000000000);

    await client.get("/api/v3/account/info");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", cache: "no-store" });
    expect(fetcher.mock.calls[0][0]).toBe("https://api.bitget.com/api/v3/account/info");
  });

  it.each(["/api/v3/market/instruments", "/api/v3/market/candles"])("uses only GET for an allowlisted market read: %s", async (path) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "00000", data: [] }), { status: 200 }));
    const client = new BitgetReadOnlyClient(credentials, fetcher as unknown as typeof fetch);

    await client.get(path);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1].method).toBe("GET");
    expect(fetcher.mock.calls[0][0]).toBe(`https://api.bitget.com${path}`);
  });
});
