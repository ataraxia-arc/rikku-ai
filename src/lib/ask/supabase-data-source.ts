import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AskDataAccessError,
  type AskConnectionStatus,
  type AskDataSource,
  type AskFill,
  type AskFinancialRecord,
  type AskImportSummary,
  type AskInstrument,
  type AskMarketCandle,
  type AskMemory,
  type AskPattern,
} from "@/lib/ask/types";

const MAX_ANALYSIS_ROWS = 5_000;
const MAX_MEMORIES = 20;
const PAGE_SIZE = 500;

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : value === null || value === undefined ? null : String(value);
}

function nonnegativeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeTimestamp(value: unknown): string | null {
  const stringValue = asString(value);
  return stringValue && Number.isFinite(Date.parse(stringValue)) ? stringValue : null;
}

function progressObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function queryError(error: unknown): never {
  // Never propagate PostgREST detail, which may include operational metadata.
  void error;
  throw new AskDataAccessError("DATA_UNAVAILABLE");
}

/**
 * PostgREST can enforce a server-side maximum row count. Page explicitly so
 * Ask never mistakes that cap for the end of a user's history. One extra page
 * proves the bounded result is complete; otherwise analysis fails closed.
 */
async function readAllPages<T>(readPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; from <= MAX_ANALYSIS_ROWS; from += PAGE_SIZE) {
    const result = await readPage(from, from + PAGE_SIZE - 1);
    if (result.error) queryError(result.error);
    const page = result.data ?? [];
    rows.push(...page);
    if (rows.length > MAX_ANALYSIS_ROWS) throw new AskDataAccessError("DATASET_TOO_LARGE");
    if (page.length < PAGE_SIZE) return rows;
  }
  throw new AskDataAccessError("DATASET_TOO_LARGE");
}

/**
 * Read-only adapter for the Ask endpoint. Every select is constrained to the
 * authenticated user in addition to Supabase RLS, so a service-role cache can
 * never broaden the data returned to a browser session.
 */
export function createSupabaseAskDataSource(
  supabase: SupabaseClient,
  userId: string,
): AskDataSource {
  return {
    async getConnectionStatus(): Promise<AskConnectionStatus> {
      const { data, error } = await supabase.rpc("get_verified_bitget_connection_status");
      if (error) queryError(error);
      const row = Array.isArray(data) ? data[0] : data;
      return {
        connected: Boolean(row?.verified),
        lastSyncedAt: safeTimestamp(row?.last_synced_at),
      };
    },

    async getLatestCompletedImport(): Promise<AskImportSummary | null> {
      const { data, error } = await supabase
        .from("import_jobs")
        .select("id,progress,completed_at")
        .eq("user_id", userId)
        .eq("job_type", "bitget_initial")
        .eq("status", "completed")
        .order("completed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) queryError(error);
      if (!data?.id) return null;

      const progress = progressObject(data.progress);
      return {
        id: String(data.id),
        completedAt: safeTimestamp(data.completed_at),
        orders: nonnegativeCount(progress.ordersImported),
        fills: nonnegativeCount(progress.fillsImported),
        financialRecords: nonnegativeCount(progress.financialRecordsImported),
        assets: nonnegativeCount(progress.assetsImported),
        positions: nonnegativeCount(progress.positionsImported),
        instruments: nonnegativeCount(progress.instrumentsImported),
        marketCandles: nonnegativeCount(progress.marketSnapshotsImported),
        completedTrades: nonnegativeCount(progress.tradesReconstructed),
        earliestRecordAt: safeTimestamp(progress.earliestRecordAt),
        latestRecordAt: safeTimestamp(progress.latestRecordAt),
      };
    },

    async getFills(): Promise<AskFill[]> {
      const data = await readAllPages((from, to) => supabase
        .from("trade_fills")
        .select("category,symbol,side,execution_price,execution_quantity,execution_value,fee_amount,fee_coin,executed_at")
        .eq("user_id", userId)
        .order("executed_at", { ascending: true })
        .range(from, to));
      return data.map((row) => ({
        category: asString(row.category),
        symbol: asString(row.symbol),
        side: asString(row.side),
        executionPrice: asString(row.execution_price),
        executionQuantity: asString(row.execution_quantity),
        executionValue: asString(row.execution_value),
        feeAmount: asString(row.fee_amount),
        feeCoin: asString(row.fee_coin),
        executedAt: safeTimestamp(row.executed_at),
      }));
    },

    async getFinancialRecords(): Promise<AskFinancialRecord[]> {
      const data = await readAllPages((from, to) => supabase
        .from("financial_records")
        .select("coin,record_type,fee,amount,recorded_at")
        .eq("user_id", userId)
        .order("recorded_at", { ascending: true })
        .range(from, to));
      return data.map((row) => ({
        coin: asString(row.coin),
        recordType: asString(row.record_type),
        fee: asString(row.fee),
        amount: asString(row.amount),
        recordedAt: safeTimestamp(row.recorded_at),
      }));
    },

    async getInstruments(): Promise<AskInstrument[]> {
      const data = await readAllPages((from, to) => supabase
        .from("instruments")
        .select("category,symbol,quote_coin")
        .eq("user_id", userId)
        .eq("source", "bitget")
        .range(from, to));
      return data.map((row) => ({
        category: asString(row.category),
        symbol: asString(row.symbol),
        quoteCoin: asString(row.quote_coin),
      }));
    },

    async getMarketCandles(): Promise<AskMarketCandle[]> {
      const data = await readAllPages((from, to) => supabase
        .from("market_snapshots")
        .select("category,symbol,observed_at,open,high,low,close")
        .eq("user_id", userId)
        .eq("source", "bitget")
        .eq("interval", "1D")
        .order("observed_at", { ascending: true })
        .range(from, to));
      return data.map((row) => ({
        category: asString(row.category),
        symbol: asString(row.symbol),
        observedAt: safeTimestamp(row.observed_at),
        open: asString(row.open),
        high: asString(row.high),
        low: asString(row.low),
        close: asString(row.close),
      }));
    },

    async getMemories(limit: number): Promise<AskMemory[]> {
      const safeLimit = Math.max(1, Math.min(MAX_MEMORIES, Math.floor(limit)));
      const { data, error } = await supabase
        .from("memories")
        .select("memory_type,statement,classification,confidence,status,created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(safeLimit);
      if (error) queryError(error);
      return (data ?? []).map((row) => ({
        memoryType: asString(row.memory_type),
        statement: asString(row.statement),
        classification: asString(row.classification),
        confidence: asString(row.confidence),
        status: asString(row.status),
        createdAt: safeTimestamp(row.created_at),
      }));
    },

    async getPatterns(limit: number): Promise<AskPattern[]> {
      const safeLimit = Math.max(1, Math.min(MAX_MEMORIES, Math.floor(limit)));
      const { data, error } = await supabase
        .from("patterns")
        .select("claim,status,confidence,updated_at")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(safeLimit);
      if (error) queryError(error);
      return (data ?? []).map((row) => ({
        claim: asString(row.claim),
        status: asString(row.status),
        confidence: asString(row.confidence),
        updatedAt: safeTimestamp(row.updated_at),
      }));
    },
  };
}
