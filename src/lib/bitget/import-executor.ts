import "server-only";

import { z } from "zod";
import { BitgetGatewayError, type BitgetReadOnlyClient, type BitgetSafeCode } from "@/lib/bitget/client";
import { normalizeBitgetFill, normalizeBitgetOrder } from "@/lib/bitget/normalizers";
import { verifyReadOnlyAccount } from "@/lib/bitget/permissions";
import { bitgetAccountInfoSchema, bitgetCategories, type BitgetCategory } from "@/lib/bitget/types";

const DAY_MS = 86_400_000;
const PAGE_SIZE = "100";
const MAX_REQUESTS = 300;
const MAX_MARKET_SYMBOLS = 40;
const MAX_RUNTIME_MS = 240_000;
const MIN_REQUEST_SPACING_MS = 110;
const decimalPattern = /^-?(?:\d+\.?\d*|\.\d+)$/;

const accountSettingsSchema = z.object({
  uid: z.string().min(1).optional(),
  accountMode: z.string().optional(),
  assetMode: z.string().optional(),
  holdMode: z.string().optional(),
}).passthrough();

const assetSchema = z.object({
  coin: z.string().min(1),
  equity: z.string().optional(),
  balance: z.string().optional(),
  available: z.string().optional(),
  locked: z.string().optional(),
  debt: z.string().optional(),
  usdValue: z.string().optional(),
  usdtValue: z.string().optional(),
}).passthrough();

const financialRecordSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  ts: z.string().min(1),
  category: z.string().optional(),
  symbol: z.string().optional(),
  coin: z.string().optional(),
  fee: z.string().optional(),
  amount: z.string().optional(),
  balance: z.string().optional(),
}).passthrough();

const positionSchema = z.object({
  category: z.string().min(1),
  symbol: z.string().min(1),
  posSide: z.string().optional(),
  holdSide: z.string().optional(),
  qty: z.string().optional(),
  total: z.string().optional(),
  size: z.string().optional(),
  openPriceAvg: z.string().optional(),
  markPrice: z.string().optional(),
  unrealizedPL: z.string().optional(),
  leverage: z.string().optional(),
  marginMode: z.string().optional(),
}).passthrough();

const instrumentSchema = z.object({
  category: z.string().min(1),
  symbol: z.string().min(1),
  baseCoin: z.string().optional(),
  quoteCoin: z.string().optional(),
  priceMultiplier: z.string().optional(),
  sizeMultiplier: z.string().optional(),
}).passthrough();

const pageSchema = z.union([
  z.object({ list: z.array(z.unknown()), cursor: z.string().nullish() }).passthrough(),
  // Observed successful Bitget fills terminal page; a null list with a live
  // cursor remains invalid because it cannot prove pagination is complete.
  z.object({ list: z.null(), cursor: z.null() }).passthrough()
    .transform(() => ({ list: [] as unknown[], cursor: null })),
]);
const candleSchema = z.array(z.string()).min(6);

export type ImportStage =
  | "reading_account"
  | "importing_balances"
  | "importing_orders"
  | "importing_fills"
  | "importing_fees"
  | "importing_positions"
  | "reconstructing_trades"
  | "loading_market_context"
  | "running_first_analysis"
  | "complete";

export type ImportCounts = {
  ordersImported: number;
  fillsImported: number;
  tradesReconstructed: number;
  financialRecordsImported: number;
  assetsImported: number;
  positionsImported: number;
  instrumentsImported: number;
  marketSnapshotsImported: number;
};

export type ImportAnalysis =
  | { status: "completed"; summary: string; sampleSize: number }
  | { status: "insufficient_data"; summary: "Insufficient data"; sampleSize: number };

export type ImportProgress = {
  stage: ImportStage;
  counts: ImportCounts;
  earliestRecordAt: string | null;
  latestRecordAt: string | null;
  analysis: ImportAnalysis | null;
};

export type ImportAccount = {
  external_account_id: string;
  account_mode: string | null;
  asset_mode: string | null;
  hold_mode: string | null;
};

export type ImportAsset = {
  coin: string;
  equity: string | null;
  balance: string | null;
  available: string | null;
  locked: string | null;
  debt: string | null;
  usd_value: string | null;
  observed_at: string;
};

export type ImportOrder = ReturnType<typeof normalizeBitgetOrder>;
export type ImportFill = ReturnType<typeof normalizeBitgetFill>;

export type ImportFinancialRecord = {
  external_record_id: string;
  category: string;
  symbol: string | null;
  coin: string | null;
  record_type: string;
  fee: string | null;
  amount: string | null;
  balance: string | null;
  recorded_at: string;
};

export type ImportPosition = {
  category: string;
  symbol: string;
  position_side: string;
  quantity: string;
  entry_price: string | null;
  mark_price: string | null;
  unrealized_pnl: string | null;
  leverage: string | null;
  margin_mode: string | null;
  observed_at: string;
};

export type ImportInstrument = {
  category: string;
  symbol: string;
  base_coin: string | null;
  quote_coin: string | null;
  price_increment: string | null;
  quantity_increment: string | null;
  source: "bitget";
  source_updated_at: string;
};

export type ImportMarketSnapshot = {
  category: string;
  symbol: string;
  interval: "1D";
  observed_at: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  source: "bitget";
};

export type BitgetImportWriter = {
  upsertAccount(account: ImportAccount): Promise<void>;
  upsertAssets(rows: ImportAsset[]): Promise<number>;
  upsertOrders(rows: ImportOrder[]): Promise<number>;
  upsertFills(rows: ImportFill[]): Promise<number>;
  upsertFinancialRecords(rows: ImportFinancialRecord[]): Promise<number>;
  replacePositions(rows: ImportPosition[]): Promise<number>;
  upsertInstruments(rows: ImportInstrument[]): Promise<number>;
  upsertMarketSnapshots(rows: ImportMarketSnapshot[]): Promise<number>;
  reconstructTrades(): Promise<number>;
  runFirstAnalysis(): Promise<ImportAnalysis>;
};

export type ImportBoundary =
  | "BITGET_ACCOUNT_READ"
  | "BITGET_ASSETS_READ"
  | "BITGET_ORDERS_READ"
  | "BITGET_FILLS_READ"
  | "BITGET_FINANCIAL_READ"
  | "BITGET_POSITIONS_READ"
  | "BITGET_MARKET_READ"
  | "DATABASE_WRITE"
  | "TRADE_RECONSTRUCTION"
  | "FIRST_ANALYSIS"
  | "IMPORT_LIMIT";

/** Only safe codes cross the importer boundary; never include upstream bodies or credentials. */
export class BitgetImportError extends Error {
  constructor(
    public readonly boundary: ImportBoundary,
    public readonly stage: ImportStage,
    public readonly safeCode?: BitgetSafeCode,
  ) {
    super(boundary);
    this.name = "BitgetImportError";
  }
}

type ImportReader = Pick<BitgetReadOnlyClient, "get">;

export type ExecuteBitgetImportOptions = {
  client: ImportReader;
  writer: BitgetImportWriter;
  expectedExternalUid?: string;
  nowMs?: number;
  historyDays?: number;
  /** Persist progress; a rejected callback stops the import rather than claiming success. */
  onProgress?: (progress: ImportProgress) => Promise<void> | void;
  /** Tests can disable spacing; production requests stay below Bitget's 10/s account-record limit. */
  requestSpacingMs?: number;
};

function decimalOrNull(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  if (!decimalPattern.test(value)) throw new Error("INVALID_DECIMAL");
  return value;
}

function timestampToIso(value: string): string {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error("INVALID_TIMESTAMP");
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) throw new Error("INVALID_TIMESTAMP");
  return date.toISOString();
}

function dataList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (Array.isArray(object.list)) return object.list;
    if (object.list === null && (object.cursor === undefined || object.cursor === null)) return [];
  }
  throw new Error("INVALID_LIST_RESPONSE");
}

function assetList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (Array.isArray(object.assets)) return object.assets;
    if (Array.isArray(object.assetList)) return object.assetList;
  }
  throw new Error("INVALID_ASSET_RESPONSE");
}

function historyWindows(endMs: number, historyDays: number) {
  if (!Number.isSafeInteger(endMs) || historyDays < 1 || historyDays > 90 || !Number.isInteger(historyDays)) {
    throw new Error("INVALID_IMPORT_WINDOW");
  }
  // The 90-day cutoff moves while this bounded worker runs. Keep five minutes
  // inside it (four-minute runtime plus clock/network margin), rather than
  // requesting a timestamp that expires before Bitget receives the request.
  const historyBoundaryMarginMs = historyDays === 90 ? MAX_RUNTIME_MS + 60_000 : 1;
  const oldestMs = endMs - historyDays * DAY_MS + historyBoundaryMarginMs;
  const windows: Array<{ startTime: string; endTime: string }> = [];
  let windowEnd = endMs;
  while (windowEnd >= oldestMs) {
    const windowStart = Math.max(oldestMs, windowEnd - 30 * DAY_MS + 1);
    windows.unshift({ startTime: String(windowStart), endTime: String(windowEnd) });
    windowEnd = windowStart - 1;
  }
  return windows;
}

function normalizedFinancialRecord(raw: unknown): ImportFinancialRecord {
  const record = financialRecordSchema.parse(raw);
  return {
    external_record_id: record.id,
    category: record.category ?? "UTA",
    symbol: record.symbol ?? null,
    coin: record.coin ?? null,
    record_type: record.type,
    fee: decimalOrNull(record.fee),
    amount: decimalOrNull(record.amount),
    balance: decimalOrNull(record.balance),
    recorded_at: timestampToIso(record.ts),
  };
}

function normalizedPosition(raw: unknown, observedAt: string): ImportPosition {
  const position = positionSchema.parse(raw);
  const side = position.posSide ?? position.holdSide;
  const quantity = position.qty ?? position.total ?? position.size;
  if (!side || !quantity || !decimalPattern.test(quantity)) throw new Error("INVALID_POSITION_RESPONSE");
  return {
    category: position.category.toUpperCase(),
    symbol: position.symbol.toUpperCase(),
    position_side: side.toLowerCase(),
    quantity,
    entry_price: decimalOrNull(position.openPriceAvg),
    mark_price: decimalOrNull(position.markPrice),
    unrealized_pnl: decimalOrNull(position.unrealizedPL),
    leverage: decimalOrNull(position.leverage),
    margin_mode: position.marginMode ?? null,
    observed_at: observedAt,
  };
}

function normalizedInstrument(raw: unknown, category: BitgetCategory, symbol: string, observedAt: string): ImportInstrument {
  const instrument = instrumentSchema.parse(raw);
  if (instrument.category.toUpperCase() !== category || instrument.symbol.toUpperCase() !== symbol) {
    throw new Error("INVALID_INSTRUMENT_RESPONSE");
  }
  return {
    category,
    symbol,
    base_coin: instrument.baseCoin ?? null,
    quote_coin: instrument.quoteCoin ?? null,
    price_increment: decimalOrNull(instrument.priceMultiplier),
    quantity_increment: decimalOrNull(instrument.sizeMultiplier),
    source: "bitget",
    source_updated_at: observedAt,
  };
}

function normalizedCandle(raw: unknown, category: BitgetCategory, symbol: string): ImportMarketSnapshot {
  const candle = candleSchema.parse(raw);
  for (const value of candle.slice(1, 6)) {
    if (!decimalPattern.test(value)) throw new Error("INVALID_CANDLE_RESPONSE");
  }
  return {
    category,
    symbol,
    interval: "1D",
    observed_at: timestampToIso(candle[0]),
    open: candle[1],
    high: candle[2],
    low: candle[3],
    close: candle[4],
    volume: candle[5],
    source: "bitget",
  };
}

export async function executeBitgetImport({
  client,
  writer,
  expectedExternalUid,
  nowMs = Date.now(),
  historyDays = 90,
  onProgress,
  requestSpacingMs = MIN_REQUEST_SPACING_MS,
}: ExecuteBitgetImportOptions): Promise<ImportProgress> {
  const counts: ImportCounts = {
    ordersImported: 0,
    fillsImported: 0,
    tradesReconstructed: 0,
    financialRecordsImported: 0,
    assetsImported: 0,
    positionsImported: 0,
    instrumentsImported: 0,
    marketSnapshotsImported: 0,
  };
  const progress: ImportProgress = {
    stage: "reading_account",
    counts,
    earliestRecordAt: null,
    latestRecordAt: null,
    analysis: null,
  };
  const windows = historyWindows(nowMs, historyDays);
  const startedAt = Date.now();
  let requests = 0;
  let lastRequestAt = 0;
  const symbols = new Map<string, { category: BitgetCategory; symbol: string }>();
  const seenOrderIds = new Set<string>();
  const seenFillIds = new Set<string>();
  const seenFinancialIds = new Set<string>();

  async function emit(stage: ImportStage) {
    progress.stage = stage;
    if (onProgress) {
      try {
        await onProgress({ ...progress, counts: { ...counts } });
      } catch {
        throw new BitgetImportError("DATABASE_WRITE", stage);
      }
    }
  }

  async function read<T>(path: string, query: Record<string, string>, boundary: ImportBoundary): Promise<T> {
    if (requests >= MAX_REQUESTS || Date.now() - startedAt >= MAX_RUNTIME_MS) {
      throw new BitgetImportError("IMPORT_LIMIT", progress.stage);
    }
    const delay = lastRequestAt + requestSpacingMs - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    lastRequestAt = Date.now();
    requests++;
    try {
      return await client.get<T>(path, query);
    } catch (error) {
      if (error instanceof BitgetGatewayError) {
        throw new BitgetImportError(boundary, progress.stage, error.safeCode);
      }
      throw new BitgetImportError(boundary, progress.stage);
    }
  }

  async function persist<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      throw new BitgetImportError("DATABASE_WRITE", progress.stage);
    }
  }

  function noteCoverage(iso: string) {
    if (progress.earliestRecordAt === null || iso < progress.earliestRecordAt) progress.earliestRecordAt = iso;
    if (progress.latestRecordAt === null || iso > progress.latestRecordAt) progress.latestRecordAt = iso;
  }

  function noteSymbol(category: string, symbol: string) {
    const categoryValue = bitgetCategories.find((value) => value === category.toUpperCase());
    if (!categoryValue) throw new BitgetImportError("BITGET_MARKET_READ", progress.stage);
    const key = `${categoryValue}:${symbol.toUpperCase()}`;
    symbols.set(key, { category: categoryValue, symbol: symbol.toUpperCase() });
    if (symbols.size > MAX_MARKET_SYMBOLS) throw new BitgetImportError("IMPORT_LIMIT", progress.stage);
  }

  async function pages(
    path: string,
    boundary: ImportBoundary,
    query: Record<string, string>,
    receive: (rows: unknown[]) => Promise<void>,
  ) {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (;;) {
      const payload = await read<unknown>(path, { ...query, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }, boundary);
      const parsed = pageSchema.safeParse(payload);
      if (!parsed.success) throw new BitgetImportError(boundary, progress.stage);
      const { list, cursor: nextCursor } = parsed.data;
      if (list.length > Number(PAGE_SIZE)) throw new BitgetImportError(boundary, progress.stage);
      if (list.length === 0) return;
      try {
        await receive(list);
      } catch (error) {
        if (error instanceof BitgetImportError) throw error;
        throw new BitgetImportError(boundary, progress.stage);
      }
      await emit(progress.stage);
      if (!nextCursor) {
        if (list.length === Number(PAGE_SIZE)) throw new BitgetImportError(boundary, progress.stage);
        return;
      }
      if (nextCursor === cursor || seenCursors.has(nextCursor)) throw new BitgetImportError(boundary, progress.stage);
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  await emit("reading_account");
  const accountPayload = await read<unknown>("/api/v3/account/info", {}, "BITGET_ACCOUNT_READ");
  const parsedAccount = bitgetAccountInfoSchema.safeParse(accountPayload);
  if (!parsedAccount.success) throw new BitgetImportError("BITGET_ACCOUNT_READ", progress.stage);
  const permission = verifyReadOnlyAccount(parsedAccount.data);
  if (!permission.ok || (expectedExternalUid && permission.userId !== expectedExternalUid)) {
    throw new BitgetImportError("BITGET_ACCOUNT_READ", progress.stage);
  }
  const settingsPayload = await read<unknown>("/api/v3/account/settings", {}, "BITGET_ACCOUNT_READ");
  const settings = accountSettingsSchema.safeParse(settingsPayload);
  if (!settings.success || (settings.data.uid && settings.data.uid !== permission.userId)) {
    throw new BitgetImportError("BITGET_ACCOUNT_READ", progress.stage);
  }
  await persist(() => writer.upsertAccount({
    external_account_id: permission.userId,
    account_mode: settings.data.accountMode ?? null,
    asset_mode: settings.data.assetMode ?? null,
    hold_mode: settings.data.holdMode ?? null,
  }));

  await emit("importing_balances");
  const assetsPayload = await read<unknown>("/api/v3/account/assets", {}, "BITGET_ASSETS_READ");
  let assets: ImportAsset[];
  try {
    assets = assetList(assetsPayload).map((raw) => {
      const asset = assetSchema.parse(raw);
      return {
        coin: asset.coin,
        equity: decimalOrNull(asset.equity),
        balance: decimalOrNull(asset.balance),
        available: decimalOrNull(asset.available),
        locked: decimalOrNull(asset.locked),
        debt: decimalOrNull(asset.debt),
        usd_value: decimalOrNull(asset.usdValue ?? asset.usdtValue),
        observed_at: new Date(nowMs).toISOString(),
      };
    });
  } catch {
    throw new BitgetImportError("BITGET_ASSETS_READ", progress.stage);
  }
  counts.assetsImported = await persist(() => writer.upsertAssets(assets));
  await emit("importing_balances");

  await emit("importing_orders");
  for (const category of bitgetCategories) {
    for (const window of windows) {
      await pages("/api/v3/trade/history-orders", "BITGET_ORDERS_READ", { category, ...window }, async (rawRows) => {
        const rows = rawRows.map((raw) => normalizeBitgetOrder(raw)).filter((row) => {
          if (seenOrderIds.has(row.external_order_id)) return false;
          seenOrderIds.add(row.external_order_id);
          return true;
        });
        for (const row of rows) {
          noteCoverage(row.source_created_at);
          noteSymbol(row.category, row.symbol);
        }
        counts.ordersImported += await persist(() => writer.upsertOrders(rows));
      });
    }
  }

  await emit("importing_fills");
  for (const category of bitgetCategories) {
    for (const window of windows) {
      await pages("/api/v3/trade/fills", "BITGET_FILLS_READ", { category, ...window }, async (rawRows) => {
        const rows = rawRows.map((raw) => normalizeBitgetFill(raw)).filter((row) => {
          if (seenFillIds.has(row.external_execution_id)) return false;
          seenFillIds.add(row.external_execution_id);
          return true;
        });
        for (const row of rows) {
          noteCoverage(row.executed_at);
          noteSymbol(row.category, row.symbol);
        }
        counts.fillsImported += await persist(() => writer.upsertFills(rows));
      });
    }
  }

  await emit("importing_fees");
  // Bitget requires category for this endpoint, including OTHER ledger events.
  for (const category of [...bitgetCategories, "OTHER"]) {
    for (const window of windows) {
      await pages("/api/v3/account/financial-records", "BITGET_FINANCIAL_READ", { category, ...window }, async (rawRows) => {
        const rows = rawRows.map((raw) => normalizedFinancialRecord(raw)).filter((row) => {
          if (seenFinancialIds.has(row.external_record_id)) return false;
          seenFinancialIds.add(row.external_record_id);
          return true;
        });
        for (const row of rows) noteCoverage(row.recorded_at);
        counts.financialRecordsImported += await persist(() => writer.upsertFinancialRecords(rows));
      });
    }
  }

  await emit("importing_positions");
  const positions: ImportPosition[] = [];
  for (const category of bitgetCategories.filter((value) => value.endsWith("-FUTURES"))) {
    const positionsPayload = await read<unknown>("/api/v3/position/current-position", { category }, "BITGET_POSITIONS_READ");
    try {
      const rows = dataList(positionsPayload).map((raw) => normalizedPosition(raw, new Date(nowMs).toISOString()));
      for (const row of rows) noteSymbol(row.category, row.symbol);
      positions.push(...rows);
    } catch (error) {
      if (error instanceof BitgetImportError) throw error;
      throw new BitgetImportError("BITGET_POSITIONS_READ", progress.stage);
    }
  }
  counts.positionsImported = await persist(() => writer.replacePositions(positions));
  await emit("importing_positions");

  await emit("reconstructing_trades");
  try {
    counts.tradesReconstructed = await writer.reconstructTrades();
  } catch {
    throw new BitgetImportError("TRADE_RECONSTRUCTION", progress.stage);
  }
  await emit("reconstructing_trades");

  await emit("loading_market_context");
  for (const { category, symbol } of symbols.values()) {
    const instrumentsPayload = await read<unknown>("/api/v3/market/instruments", { category, symbol }, "BITGET_MARKET_READ");
    if (!Array.isArray(instrumentsPayload)) throw new BitgetImportError("BITGET_MARKET_READ", progress.stage);
    let instruments: ImportInstrument[];
    try {
      instruments = instrumentsPayload.map((raw) => normalizedInstrument(raw, category, symbol, new Date(nowMs).toISOString()));
    } catch {
      throw new BitgetImportError("BITGET_MARKET_READ", progress.stage);
    }
    counts.instrumentsImported += await persist(() => writer.upsertInstruments(instruments));
    // Bitget's UTA candle endpoint supports SPOT and futures, not MARGIN.
    const candleCategory = category === "MARGIN" ? "SPOT" : category;
    const candlesPayload = await read<unknown>("/api/v3/market/candles", {
      category: candleCategory, symbol, interval: "1D", limit: "100",
      startTime: String(nowMs - historyDays * DAY_MS), endTime: String(nowMs),
    }, "BITGET_MARKET_READ");
    if (!Array.isArray(candlesPayload)) throw new BitgetImportError("BITGET_MARKET_READ", progress.stage);
    let candles: ImportMarketSnapshot[];
    try {
      candles = candlesPayload.map((raw) => normalizedCandle(raw, candleCategory, symbol));
    } catch {
      throw new BitgetImportError("BITGET_MARKET_READ", progress.stage);
    }
    counts.marketSnapshotsImported += await persist(() => writer.upsertMarketSnapshots(candles));
    await emit("loading_market_context");
  }

  await emit("running_first_analysis");
  try {
    progress.analysis = await writer.runFirstAnalysis();
  } catch {
    throw new BitgetImportError("FIRST_ANALYSIS", progress.stage);
  }
  await emit("complete");
  return { ...progress, counts: { ...counts } };
}
