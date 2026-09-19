import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type ServerSupabaseClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;
type UnknownRecord = Record<string, unknown>;

export type ImportedActivitySummary = {
  orders: number;
  fills: number;
  financialRecords: number;
  instruments: number;
  marketCandles: number;
  completedTrades: number;
  assets: number;
  positions: number;
  earliestRecordAt: string | null;
  latestRecordAt: string | null;
  completedAt: string | null;
};

export type WorkspaceConnection = {
  configured: boolean;
  authenticated: boolean;
  connectionReadable: boolean;
  importReadable: boolean;
  connected: boolean;
  verifiedAt: string | null;
  lastSyncedAt: string | null;
  latestImport: ImportedActivitySummary | null;
};

export type PortfolioAsset = {
  coin: string;
  equity: string | null;
  balance: string | null;
  available: string | null;
  observedAt: string | null;
};

export type PortfolioPosition = {
  category: string;
  symbol: string;
  side: string;
  quantity: string;
  entryPrice: string | null;
  markPrice: string | null;
  observedAt: string | null;
};

export type MemoryRecord = {
  id: string;
  type: "trade" | "market_context" | "decision" | "behavioral" | "pattern" | "rule" | "thesis";
  statement: string;
  classification: string;
  confidence: string;
  status: string;
  createdAt: string | null;
  evidence: Array<{ direction: string; source: string | null; observedAt: string | null }>;
};

export type PatternRecord = {
  id: string;
  type: string;
  claim: string;
  status: "candidate" | "promising" | "validated" | "weakened" | "retired";
  confidence: string;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  supportingEvidence: number;
  counterEvidence: number;
};

export type ResearchSource = {
  id: string;
  title: string;
  publisher: string | null;
  url: string;
  publishedAt: string | null;
  retrievedAt: string | null;
};

export type PersonalRule = {
  id: string;
  category: string;
  ifConditions: string;
  thenAction: string;
  evidence: string;
  confidence: string;
  status: string;
  createdAt: string | null;
};

export type WorkspaceProfile = {
  displayName: string | null;
  timezone: string | null;
  baseCurrency: string | null;
};

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function asRows(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.flatMap((row) => {
    const record = asRecord(row);
    return record ? [record] : [];
  }) : [];
}

function firstRecord(value: unknown): UnknownRecord | null {
  if (Array.isArray(value)) return asRecord(value[0]);
  return asRecord(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function dateValue(value: unknown): string | null {
  const date = stringValue(value);
  return date && !Number.isNaN(Date.parse(date)) ? date : null;
}

function countValue(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function numericText(value: unknown): string | null {
  return typeof value === "number" || typeof value === "string" ? String(value) : null;
}

function responseFailed(value: { error: unknown } | null | undefined) {
  return Boolean(value?.error);
}

async function withAuthenticatedClient<T>(fallback: T, read: (supabase: ServerSupabaseClient) => Promise<T>): Promise<T> {
  if (!isSupabaseConfigured()) return fallback;
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return fallback;
    return await read(supabase);
  } catch {
    return fallback;
  }
}

function emptyConnection(): WorkspaceConnection {
  return {
    configured: isSupabaseConfigured(),
    authenticated: false,
    connectionReadable: false,
    importReadable: false,
    connected: false,
    verifiedAt: null,
    lastSyncedAt: null,
    latestImport: null,
  };
}

/**
 * Safe, server-only connection and import metadata for authenticated workspace
 * pages. It deliberately excludes credentials and private account identifiers.
 */
export async function readWorkspaceConnection(): Promise<WorkspaceConnection> {
  const fallback = emptyConnection();
  if (!fallback.configured) return fallback;

  try {
    const supabase = await createSupabaseServerClient();
    const { data: auth, error: authError } = await supabase.auth.getUser();
    if (authError || !auth.user) return fallback;

    const [connectionResponse, importResponse] = await Promise.all([
      supabase.rpc("get_verified_bitget_connection_status"),
      supabase
        .from("import_jobs")
        .select("progress,completed_at")
        .eq("job_type", "bitget_initial")
        .eq("status", "completed")
        .order("completed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const connection = firstRecord(connectionResponse.data);
    const importJob = firstRecord(importResponse.data);
    const progress = asRecord(importJob?.progress) ?? {};
    const completedAt = dateValue(importJob?.completed_at);

    return {
      configured: true,
      authenticated: true,
      connectionReadable: !responseFailed(connectionResponse),
      importReadable: !responseFailed(importResponse),
      connected: Boolean(connection?.verified),
      verifiedAt: dateValue(connection?.verified_at),
      lastSyncedAt: dateValue(connection?.last_synced_at) ?? completedAt,
      latestImport: importJob ? {
        orders: countValue(progress.ordersImported),
        fills: countValue(progress.fillsImported),
        financialRecords: countValue(progress.financialRecordsImported),
        instruments: countValue(progress.instrumentsImported),
        marketCandles: countValue(progress.marketSnapshotsImported),
        completedTrades: countValue(progress.tradesReconstructed),
        assets: countValue(progress.assetsImported),
        positions: countValue(progress.positionsImported),
        earliestRecordAt: dateValue(progress.earliestRecordAt),
        latestRecordAt: dateValue(progress.latestRecordAt),
        completedAt,
      } : null,
    };
  } catch {
    return fallback;
  }
}

export async function readPortfolioData() {
  const connection = await readWorkspaceConnection();
  const fallback = { readable: false, assets: [] as PortfolioAsset[], positions: [] as PortfolioPosition[] };
  const records = await withAuthenticatedClient(fallback, async (supabase) => {
    const [assetResponse, positionResponse] = await Promise.all([
      supabase.from("assets").select("coin,equity,balance,available,observed_at").order("observed_at", { ascending: false }).limit(100),
      supabase.from("positions").select("category,symbol,position_side,quantity,entry_price,mark_price,observed_at").order("observed_at", { ascending: false }).limit(100),
    ]);
    return {
      readable: !responseFailed(assetResponse) && !responseFailed(positionResponse),
      assets: asRows(assetResponse.data).flatMap((row) => {
        const coin = stringValue(row.coin);
        return coin ? [{ coin, equity: numericText(row.equity), balance: numericText(row.balance), available: numericText(row.available), observedAt: dateValue(row.observed_at) }] : [];
      }),
      positions: asRows(positionResponse.data).flatMap((row) => {
        const category = stringValue(row.category);
        const symbol = stringValue(row.symbol);
        const side = stringValue(row.position_side);
        const quantity = numericText(row.quantity);
        return category && symbol && side && quantity ? [{ category, symbol, side, quantity, entryPrice: numericText(row.entry_price), markPrice: numericText(row.mark_price), observedAt: dateValue(row.observed_at) }] : [];
      }),
    };
  });
  return { connection, ...records };
}

const memoryTypes = new Set<MemoryRecord["type"]>(["trade", "market_context", "decision", "behavioral", "pattern", "rule", "thesis"]);

export async function readMemoryData() {
  const connection = await readWorkspaceConnection();
  const fallback = { readable: false, memories: [] as MemoryRecord[] };
  const records = await withAuthenticatedClient(fallback, async (supabase) => {
    const memoryResponse = await supabase
      .from("memories")
      .select("id,memory_type,statement,classification,confidence,status,created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    const rows = asRows(memoryResponse.data);
    const ids = rows.flatMap((row) => stringValue(row.id) ? [String(row.id)] : []);
    const evidenceResponse = ids.length > 0
      ? await supabase.from("memory_evidence").select("memory_id,direction,source_label,observed_at").in("memory_id", ids).limit(300)
      : { data: [], error: null };
    const evidenceByMemory = new Map<string, MemoryRecord["evidence"]>();
    for (const row of asRows(evidenceResponse.data)) {
      const memoryId = stringValue(row.memory_id);
      const direction = stringValue(row.direction);
      if (!memoryId || !direction) continue;
      const evidence = evidenceByMemory.get(memoryId) ?? [];
      evidence.push({ direction, source: stringValue(row.source_label), observedAt: dateValue(row.observed_at) });
      evidenceByMemory.set(memoryId, evidence);
    }
    return {
      readable: !responseFailed(memoryResponse) && !responseFailed(evidenceResponse),
      memories: rows.flatMap((row) => {
        const id = stringValue(row.id);
        const type = stringValue(row.memory_type);
        const statement = stringValue(row.statement);
        const classification = stringValue(row.classification);
        const confidence = stringValue(row.confidence);
        const status = stringValue(row.status);
        return id && type && memoryTypes.has(type as MemoryRecord["type"]) && statement && classification && confidence && status
          ? [{ id, type: type as MemoryRecord["type"], statement, classification, confidence, status, createdAt: dateValue(row.created_at), evidence: evidenceByMemory.get(id) ?? [] }]
          : [];
      }),
    };
  });
  return { connection, ...records };
}

const patternStatuses = new Set<PatternRecord["status"]>(["candidate", "promising", "validated", "weakened", "retired"]);

export async function readPatternData() {
  const connection = await readWorkspaceConnection();
  const fallback = { readable: false, patterns: [] as PatternRecord[] };
  const records = await withAuthenticatedClient(fallback, async (supabase) => {
    const patternResponse = await supabase
      .from("patterns")
      .select("id,pattern_type,claim,status,confidence,first_observed_at,last_observed_at")
      .order("updated_at", { ascending: false })
      .limit(100);
    const rows = asRows(patternResponse.data);
    const ids = rows.flatMap((row) => stringValue(row.id) ? [String(row.id)] : []);
    const evidenceResponse = ids.length > 0
      ? await supabase.from("pattern_evidence").select("pattern_id,direction").in("pattern_id", ids).limit(500)
      : { data: [], error: null };
    const evidenceCounts = new Map<string, { supporting: number; counter: number }>();
    for (const row of asRows(evidenceResponse.data)) {
      const patternId = stringValue(row.pattern_id);
      const direction = stringValue(row.direction);
      if (!patternId || !direction) continue;
      const count = evidenceCounts.get(patternId) ?? { supporting: 0, counter: 0 };
      if (direction === "supporting") count.supporting += 1;
      if (direction === "contradicting") count.counter += 1;
      evidenceCounts.set(patternId, count);
    }
    return {
      readable: !responseFailed(patternResponse) && !responseFailed(evidenceResponse),
      patterns: rows.flatMap((row) => {
        const id = stringValue(row.id);
        const type = stringValue(row.pattern_type);
        const claim = stringValue(row.claim);
        const status = stringValue(row.status);
        const confidence = stringValue(row.confidence);
        if (!id || !type || !claim || !status || !patternStatuses.has(status as PatternRecord["status"]) || !confidence) return [];
        const evidence = evidenceCounts.get(id) ?? { supporting: 0, counter: 0 };
        return [{ id, type, claim, status: status as PatternRecord["status"], confidence, firstObservedAt: dateValue(row.first_observed_at), lastObservedAt: dateValue(row.last_observed_at), supportingEvidence: evidence.supporting, counterEvidence: evidence.counter }];
      }),
    };
  });
  return { connection, ...records };
}

export async function readResearchData() {
  const connection = await readWorkspaceConnection();
  const fallback = { readable: false, sources: [] as ResearchSource[] };
  const records = await withAuthenticatedClient(fallback, async (supabase) => {
    const response = await supabase
      .from("research_sources")
      .select("id,title,publisher,url,published_at,retrieved_at")
      .order("retrieved_at", { ascending: false })
      .limit(100);
    return {
      readable: !responseFailed(response),
      sources: asRows(response.data).flatMap((row) => {
        const id = stringValue(row.id);
        const title = stringValue(row.title);
        const url = stringValue(row.url);
        return id && title && url ? [{ id, title, url, publisher: stringValue(row.publisher), publishedAt: dateValue(row.published_at), retrievedAt: dateValue(row.retrieved_at) }] : [];
      }),
    };
  });
  return { connection, ...records };
}

export async function readRiskData() {
  const connection = await readWorkspaceConnection();
  return { connection, importSummary: connection.latestImport };
}

function conditionText(value: unknown): string {
  if (typeof value === "string") return value.trim().slice(0, 500) || "Conditions were not recorded.";
  if (Array.isArray(value)) {
    const conditions = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return conditions.length > 0 ? conditions.join("; ").slice(0, 500) : "Conditions were not recorded.";
  }
  return "Conditions were not recorded.";
}

export async function readPlaybookData() {
  const connection = await readWorkspaceConnection();
  const fallback = { readable: false, rules: [] as PersonalRule[] };
  const records = await withAuthenticatedClient(fallback, async (supabase) => {
    const response = await supabase
      .from("personal_rules")
      .select("id,category,if_conditions,then_action,origin_memory_id,origin_pattern_id,confidence,status,created_at")
      .order("updated_at", { ascending: false })
      .limit(100);
    return {
      readable: !responseFailed(response),
      rules: asRows(response.data).flatMap((row) => {
        const id = stringValue(row.id);
        const category = stringValue(row.category);
        const thenAction = stringValue(row.then_action);
        const confidence = stringValue(row.confidence);
        const status = stringValue(row.status);
        const evidence = stringValue(row.origin_memory_id)
          ? "Linked RIKKU memory"
          : stringValue(row.origin_pattern_id)
            ? "Linked RIKKU pattern"
            : "Evidence link not recorded";
        return id && category && thenAction && confidence && status
          ? [{ id, category, ifConditions: conditionText(row.if_conditions), thenAction, evidence, confidence, status, createdAt: dateValue(row.created_at) }]
          : [];
      }),
    };
  });
  return { connection, ...records };
}

export async function readSettingsData() {
  const connection = await readWorkspaceConnection();
  const fallback = { readable: false, profile: null as WorkspaceProfile | null };
  const records = await withAuthenticatedClient(fallback, async (supabase) => {
    const response = await supabase.from("users").select("display_name,timezone,base_currency").maybeSingle();
    const row = firstRecord(response.data);
    return {
      readable: !responseFailed(response),
      profile: row ? {
        displayName: stringValue(row.display_name),
        timezone: stringValue(row.timezone),
        baseCurrency: stringValue(row.base_currency),
      } : null,
    };
  });
  return { connection, ...records };
}
