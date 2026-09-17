import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reconstructClosedTrades, type NormalizedTradeFill } from "@/lib/bitget/reconstruct";
import type {
  BitgetImportWriter,
  ImportAccount,
  ImportAsset,
  ImportFill,
  ImportFinancialRecord,
  ImportInstrument,
  ImportMarketSnapshot,
  ImportOrder,
  ImportPosition,
  ImportAnalysis,
} from "@/lib/bitget/import-executor";

function requireSuccess(error: { code?: string } | null) {
  if (error) throw new Error("IMPORT_DATABASE_WRITE_FAILED");
}

type RealizedTrade = { id: string; category: string; symbol: string; net_pnl: string; closed_at: string };

function decimalUnits(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,18}))?$/.exec(value);
  if (!match) throw new Error("INVALID_REALIZED_PNL");
  const amount = BigInt(match[2]) * 10n ** 18n + BigInt((match[3] ?? "").padEnd(18, "0"));
  return match[1] === "-" ? -amount : amount;
}

function tailRiskAnalysis(trades: RealizedTrade[]): ImportAnalysis {
  const groups = new Map<string, RealizedTrade[]>();
  for (const trade of trades) {
    const group = `${trade.category}:${trade.symbol}`;
    groups.set(group, [...(groups.get(group) ?? []), trade]);
  }
  const candidate = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  const sample = candidate?.[1] ?? [];
  if (sample.length < 30) return { status: "insufficient_data", summary: "Insufficient data", sampleSize: sample.length };
  const pnls = sample.map((trade) => ({ value: trade.net_pnl, units: decimalUnits(trade.net_pnl) }));
  pnls.sort((a, b) => a.units < b.units ? -1 : a.units > b.units ? 1 : 0);
  const tailIndex = Math.max(0, Math.ceil(0.05 * pnls.length) - 1);
  return {
    status: "completed",
    summary: `${candidate![0]}: empirical 5th-percentile realized net P&L ${pnls[tailIndex].value} across ${pnls.length} reconstructed trades.`,
    sampleSize: pnls.length,
  };
}

export function createBitgetImportWriter(
  supabase: SupabaseClient,
  userId: string,
  connectionId: string,
): BitgetImportWriter {
  let accountId: string | null = null;

  function requireAccountId() {
    if (!accountId) throw new Error("IMPORT_ACCOUNT_NOT_STORED");
    return accountId;
  }

  async function readAllFills(): Promise<Array<NormalizedTradeFill & { id: string }>> {
    const rows: Array<NormalizedTradeFill & { id: string }> = [];
    for (let offset = 0; offset <= 10000; offset += 1000) {
      const { data, error } = await supabase.from("trade_fills")
        .select("id,external_execution_id,external_order_id,category,symbol,side,trade_side,execution_price,execution_quantity,execution_value,execution_pnl,fee_amount,fee_coin,executed_at")
        .eq("account_id", requireAccountId())
        .eq("user_id", userId)
        .order("executed_at", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + 999);
      requireSuccess(error);
      const page = (data ?? []) as Array<NormalizedTradeFill & { id: string }>;
      rows.push(...page);
      if (rows.length > 10000) throw new Error("RECONSTRUCTION_FILL_LIMIT");
      if (page.length < 1000) break;
    }
    return rows;
  }

  async function readAllRealizedTrades(): Promise<RealizedTrade[]> {
    const rows: RealizedTrade[] = [];
    for (let offset = 0; offset <= 10000; offset += 1000) {
      const { data, error } = await supabase.from("trades")
        .select("id,category,symbol,net_pnl,closed_at")
        .eq("account_id", requireAccountId())
        .eq("user_id", userId)
        .not("net_pnl", "is", null)
        .not("closed_at", "is", null)
        .order("closed_at", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + 999);
      requireSuccess(error);
      const page = (data ?? []) as RealizedTrade[];
      rows.push(...page);
      if (rows.length > 10000) throw new Error("ANALYSIS_SAMPLE_LIMIT");
      if (page.length < 1000) break;
    }
    return rows;
  }

  return {
    async upsertAccount(account: ImportAccount) {
      const { data, error } = await supabase.from("accounts").upsert({
        ...account,
        user_id: userId,
        connection_id: connectionId,
        updated_at: new Date().toISOString(),
      }, { onConflict: "connection_id,external_account_id" }).select("id").single();
      requireSuccess(error);
      if (!data?.id) throw new Error("IMPORT_ACCOUNT_NOT_STORED");
      accountId = data.id as string;
    },

    async upsertAssets(rows: ImportAsset[]) {
      if (!rows.length) return 0;
      const { error } = await supabase.from("assets").upsert(rows.map((row) => ({
        ...row, user_id: userId, account_id: requireAccountId(),
      })), { onConflict: "account_id,coin" });
      requireSuccess(error);
      return rows.length;
    },

    async upsertOrders(rows: ImportOrder[]) {
      if (!rows.length) return 0;
      const { error } = await supabase.from("orders").upsert(rows.map((row) => ({
        ...row, user_id: userId, account_id: requireAccountId(),
      })), { onConflict: "account_id,external_order_id" });
      requireSuccess(error);
      return rows.length;
    },

    async upsertFills(rows: ImportFill[]) {
      if (!rows.length) return 0;
      const { error } = await supabase.from("trade_fills").upsert(rows.map((row) => ({
        ...row, user_id: userId, account_id: requireAccountId(),
      })), { onConflict: "account_id,external_execution_id" });
      requireSuccess(error);
      return rows.length;
    },

    async upsertFinancialRecords(rows: ImportFinancialRecord[]) {
      if (!rows.length) return 0;
      const { error } = await supabase.from("financial_records").upsert(rows.map((row) => ({
        ...row, user_id: userId, account_id: requireAccountId(),
      })), { onConflict: "account_id,external_record_id" });
      requireSuccess(error);
      return rows.length;
    },

    async replacePositions(rows: ImportPosition[]) {
      const id = requireAccountId();
      if (rows.length) {
        const { error } = await supabase.from("positions").upsert(rows.map((row) => ({
          ...row, user_id: userId, account_id: id,
        })), { onConflict: "account_id,category,symbol,position_side" });
        requireSuccess(error);
      }
      const stale = supabase.from("positions").delete().eq("account_id", id).eq("user_id", userId);
      const { error } = rows.length
        ? await stale.lt("observed_at", rows[0].observed_at)
        : await stale;
      requireSuccess(error);
      return rows.length;
    },

    async upsertInstruments(rows: ImportInstrument[]) {
      if (!rows.length) return 0;
      const { error } = await supabase.from("instruments").upsert(rows.map((row) => ({
        ...row, user_id: userId,
      })), { onConflict: "user_id,source,category,symbol" });
      requireSuccess(error);
      return rows.length;
    },

    async upsertMarketSnapshots(rows: ImportMarketSnapshot[]) {
      if (!rows.length) return 0;
      const { error } = await supabase.from("market_snapshots").upsert(rows.map((row) => ({
        ...row, user_id: userId,
      })), { onConflict: "user_id,source,category,symbol,interval,observed_at" });
      requireSuccess(error);
      return rows.length;
    },

    async reconstructTrades() {
      const fills = await readAllFills();
      // A bounded history window cannot prove the opening SPOT inventory was
      // zero. The pure reconstructor therefore omits speculative SPOT trades.
      const reconstructed = reconstructClosedTrades(fills);
      const fillIds = new Map(fills.map((fill) => [fill.external_execution_id, fill.id]));
      for (const trade of reconstructed.trades) {
        const { fillAllocations, ...persistedTrade } = trade;
        const { data, error } = await supabase.from("trades").upsert({
          ...persistedTrade,
          user_id: userId,
          account_id: requireAccountId(),
        }, { onConflict: "account_id,reconstruction_key" }).select("id").single();
        requireSuccess(error);
        if (!data?.id) throw new Error("RECONSTRUCTION_TRADE_NOT_STORED");
        const links = fillAllocations.map((allocation) => {
          const fillId = fillIds.get(allocation.external_execution_id);
          if (!fillId) throw new Error("RECONSTRUCTION_FILL_NOT_STORED");
          return {
            user_id: userId,
            trade_id: data.id,
            fill_id: fillId,
            allocated_quantity: allocation.allocated_quantity,
          };
        });
        const { error: linkError } = await supabase.from("trade_fill_links")
          .upsert(links, { onConflict: "trade_id,fill_id" });
        requireSuccess(linkError);
      }
      return reconstructed.trades.length;
    },

    async runFirstAnalysis(): Promise<ImportAnalysis> {
      const trades = await readAllRealizedTrades();
      const analysis = tailRiskAnalysis(trades);
      const fingerprint = createHash("sha256").update(JSON.stringify(trades)).digest("hex");
      const { error: writeError } = await supabase.from("analysis_results").upsert({
        user_id: userId,
        skill_key: "tail-risk-realized-pnl",
        skill_version: "1.0.0",
        input_fingerprint: fingerprint,
        result: analysis,
        sample_size: analysis.sampleSize,
        warnings: analysis.status === "insufficient_data" ? ["Insufficient data"] : [],
        confidence: analysis.status === "insufficient_data" ? "not_assessable" : "moderate",
        confidence_reasons: analysis.status === "insufficient_data"
          ? ["Fewer than 30 reconstructed trades with realized net P&L for a single market."]
          : ["Deterministic empirical quantile from imported, reconstructed realized trades."],
      }, { onConflict: "user_id,skill_key,input_fingerprint" });
      requireSuccess(writeError);
      return analysis;
    },
  };
}
