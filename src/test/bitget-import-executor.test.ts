import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  BitgetImportError,
  executeBitgetImport,
  type BitgetImportWriter,
  type ImportProgress,
} from "@/lib/bitget/import-executor";
import type { BitgetReadOnlyClient } from "@/lib/bitget/client";

const clock = Date.UTC(2026, 8, 17);
const account = { userId: "synthetic-account", permType: "readonly", permissions: ["uta_mgt", "uta_trade"] };
const order = {
  orderId: "synthetic-order", category: "SPOT", symbol: "BTCUSDT", side: "buy",
  createdTime: String(clock - 12_000),
};
const fill = {
  execId: "synthetic-fill", orderId: "synthetic-order", category: "SPOT", symbol: "BTCUSDT", side: "buy",
  execPrice: "100", execQty: "0.5", feeDetail: [{ feeCoin: "USDT", fee: "0.1" }],
  createdTime: String(clock - 10_000),
};

function makeWriter(): BitgetImportWriter {
  return {
    upsertAccount: vi.fn(async () => undefined),
    upsertAssets: vi.fn(async (rows) => rows.length),
    upsertOrders: vi.fn(async (rows) => rows.length),
    upsertFills: vi.fn(async (rows) => rows.length),
    upsertFinancialRecords: vi.fn(async (rows) => rows.length),
    replacePositions: vi.fn(async (rows) => rows.length),
    upsertInstruments: vi.fn(async (rows) => rows.length),
    upsertMarketSnapshots: vi.fn(async (rows) => rows.length),
    reconstructTrades: vi.fn(async () => 0),
    runFirstAnalysis: vi.fn(async () => ({ status: "insufficient_data" as const, summary: "Insufficient data" as const, sampleSize: 1 })),
  };
}

function makeReader(overrides?: { account?: unknown; orderCursorLoop?: boolean }) {
  const calls: Array<{ path: string; query: Record<string, string> }> = [];
  const get = vi.fn(async (path: string, query: Record<string, string>) => {
    calls.push({ path, query });
    switch (path) {
      case "/api/v3/account/info": return overrides?.account ?? account;
      case "/api/v3/account/settings": return { uid: "synthetic-account", accountMode: "unified", assetMode: "multi_assets", holdMode: "one_way_mode" };
      case "/api/v3/account/assets": return { assets: [{ coin: "USDT", balance: "5", equity: "5", available: "5" }] };
      case "/api/v3/trade/history-orders":
        if (query.category === "SPOT") return { list: [order], ...(overrides?.orderCursorLoop ? { cursor: "repeat" } : {}) };
        return { list: [], cursor: null };
      case "/api/v3/trade/fills": return { list: query.category === "SPOT" ? [fill] : [] };
      case "/api/v3/account/financial-records": return { list: [{ id: "synthetic-ledger", type: "fee", coin: "USDT", fee: "0.1", ts: String(clock - 9000) }] };
      case "/api/v3/position/current-position": return { list: null };
      case "/api/v3/market/instruments": return [{ category: query.category, symbol: query.symbol, baseCoin: "BTC", quoteCoin: "USDT" }];
      case "/api/v3/market/candles": return [[String(clock - 86_400_000), "100", "110", "90", "105", "12", "1260"]];
      default: throw new Error("UNEXPECTED_PATH");
    }
  });
  return { client: { get } as unknown as Pick<BitgetReadOnlyClient, "get">, calls };
}

describe("Bitget import executor", () => {
  it("accepts the observed fills terminal shape but rejects an ambiguous null list", async () => {
    const { client } = makeReader();
    const original = client.get.bind(client);
    const terminal = { get: vi.fn(async (path: string, query: Record<string, string>) => path === "/api/v3/trade/fills" ? { list: null, cursor: null } : original(path, query)) } as unknown as Pick<BitgetReadOnlyClient, "get">;
    const result = await executeBitgetImport({ client: terminal, writer: makeWriter(), nowMs: clock, historyDays: 1, requestSpacingMs: 0 });
    expect(result.stage).toBe("complete");
    expect(result.counts.fillsImported).toBe(0);
    const ambiguous = { get: vi.fn(async (path: string, query: Record<string, string>) => path === "/api/v3/trade/fills" ? { list: null, cursor: "still-paging" } : original(path, query)) } as unknown as Pick<BitgetReadOnlyClient, "get">;
    await expect(executeBitgetImport({ client: ambiguous, writer: makeWriter(), nowMs: clock, historyDays: 1, requestSpacingMs: 0 }))
      .rejects.toMatchObject({ boundary: "BITGET_FILLS_READ" });
  });

  it("accepts Bitget's empty terminal page with a null cursor", async () => {
    const { client } = makeReader();
    const result = await executeBitgetImport({ client, writer: makeWriter(), nowMs: clock, historyDays: 1, requestSpacingMs: 0 });
    expect(result.stage).toBe("complete");
  });

  it("keeps all history reads inside the moving 90-day limit for the worker lifetime", async () => {
    const { client, calls } = makeReader();
    await executeBitgetImport({ client, writer: makeWriter(), nowMs: clock, historyDays: 90, requestSpacingMs: 0 });
    const history = calls.filter(({ path }) => ["/api/v3/trade/history-orders", "/api/v3/trade/fills", "/api/v3/account/financial-records"].includes(path));
    expect(history.length).toBeGreaterThan(0);
    for (const { query } of history) {
      expect(Number(query.startTime)).toBeGreaterThanOrEqual(clock - 90 * 86_400_000 + 300_000);
      expect(Number(query.endTime) - Number(query.startTime)).toBeLessThanOrEqual(30 * 86_400_000);
      expect(Number(query.endTime)).toBeLessThanOrEqual(clock);
    }
  });

  it("imports real-shaped pages through read-only GETs and reports only persisted counts", async () => {
    const { client, calls } = makeReader();
    const writer = makeWriter();
    const stages: ImportProgress[] = [];
    const result = await executeBitgetImport({
      client, writer, expectedExternalUid: "synthetic-account", nowMs: clock, historyDays: 1,
      requestSpacingMs: 0, onProgress: (progress) => { stages.push(progress); },
    });

    expect(result.stage).toBe("complete");
    expect(result.counts).toMatchObject({
      assetsImported: 1, ordersImported: 1, fillsImported: 1, financialRecordsImported: 1,
      positionsImported: 0, instrumentsImported: 1, marketSnapshotsImported: 1, tradesReconstructed: 0,
    });
    expect(result.earliestRecordAt).toBe(new Date(clock - 12_000).toISOString());
    expect(result.latestRecordAt).toBe(new Date(clock - 9000).toISOString());
    expect(result.analysis).toEqual({ status: "insufficient_data", summary: "Insufficient data", sampleSize: 1 });
    const ledgerCalls = calls.filter((call) => call.path === "/api/v3/account/financial-records");
    expect(ledgerCalls).toHaveLength(6);
    expect(ledgerCalls.map((call) => call.query.category)).toEqual(["SPOT", "MARGIN", "USDT-FUTURES", "COIN-FUTURES", "USDC-FUTURES", "OTHER"]);
    expect(calls.filter((call) => call.path === "/api/v3/position/current-position").map((call) => call.query.category))
      .toEqual(["USDT-FUTURES", "COIN-FUTURES", "USDC-FUTURES"]);
    expect(calls.filter((call) => call.path === "/api/v3/trade/history-orders")).toHaveLength(5);
    expect(calls.every((call) => call.path.startsWith("/api/v3/"))).toBe(true);
    expect(stages.map((progress) => progress.stage)).toEqual(expect.arrayContaining([
      "reading_account", "importing_balances", "importing_orders", "importing_fills",
      "importing_fees", "importing_positions", "reconstructing_trades",
      "loading_market_context", "running_first_analysis", "complete",
    ]));
    expect(writer.upsertFills).toHaveBeenCalledWith([expect.objectContaining({ fee_amount: "0.1" })]);
  });

  it("rejects an account whose read-only mode cannot be positively verified before any write", async () => {
    const { client } = makeReader({ account: { ...account, permType: "unknown" } });
    const writer = makeWriter();
    await expect(executeBitgetImport({ client, writer, nowMs: clock, historyDays: 1, requestSpacingMs: 0 }))
      .rejects.toMatchObject({ boundary: "BITGET_ACCOUNT_READ", stage: "reading_account" });
    expect(writer.upsertAccount).not.toHaveBeenCalled();
  });

  it("fails explicitly on a repeated Bitget cursor instead of claiming import completion", async () => {
    const { client } = makeReader({ orderCursorLoop: true });
    const writer = makeWriter();
    await expect(executeBitgetImport({ client, writer, nowMs: clock, historyDays: 1, requestSpacingMs: 0 }))
      .rejects.toMatchObject({ boundary: "BITGET_ORDERS_READ", stage: "importing_orders" });
    expect(writer.runFirstAnalysis).not.toHaveBeenCalled();
  });

  it("keeps import errors safe and boundary-specific", () => {
    const error = new BitgetImportError("BITGET_FILLS_READ", "importing_fills", "UPSTREAM_UNAVAILABLE");
    expect(error.message).toBe("BITGET_FILLS_READ");
    expect(error.safeCode).toBe("UPSTREAM_UNAVAILABLE");
  });
});
