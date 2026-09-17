import "server-only";

import { z } from "zod";
import { buildBitgetPrehash, canonicalQuery, signBitgetRequest, type QueryValue } from "@/lib/bitget/signing";
import type { BitgetCredentials } from "@/lib/bitget/types";

const BITGET_BASE_URL = "https://api.bitget.com";
const REQUEST_TIMEOUT_MS = 10_000;

const allowedReadPaths = new Set([
  "/api/v3/account/info",
  "/api/v3/account/settings",
  "/api/v3/account/assets",
  "/api/v3/account/financial-records",
  "/api/v3/trade/history-orders",
  "/api/v3/trade/fills",
  "/api/v3/position/current-position",
  "/api/v3/market/instruments",
  "/api/v3/market/candles",
]);

const envelopeSchema = z.object({
  code: z.string(),
  msg: z.string().optional(),
  requestTime: z.number().optional(),
  data: z.unknown().optional(),
});

const safeTopLevelKeys = new Set(["code", "msg", "requestTime", "data"]);
const safeAccountDataKeys = new Set([
  "userId", "uid", "inviterId", "parentId", "channelCode", "channel", "ips",
  "permType", "permissions", "regisTime", "accountMode", "assetMode", "holdMode",
]);

function knownKeyNames(value: unknown, allowed: Set<string>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => allowed.has(key)).sort();
}

function responseShape(payload: unknown, httpStatus: number): BitgetResponseMetadata {
  const envelope = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const bitgetCode = typeof envelope.code === "string" ? safeBitgetCode(envelope.code) : undefined;
  return {
    httpStatus,
    bitgetCode,
    topLevelKeys: knownKeyNames(payload, safeTopLevelKeys),
    dataKeys: knownKeyNames(envelope.data, safeAccountDataKeys),
  };
}

export type BitgetResponseMetadata = {
  httpStatus: number;
  bitgetCode?: string;
  topLevelKeys: string[];
  dataKeys: string[];
};

export type BitgetSafeCode =
  | "PATH_NOT_ALLOWED"
  | "CLOCK_SYNC_UNAVAILABLE"
  | "BITGET_INVALID_API_KEY"
  | "BITGET_TIMESTAMP_EXPIRED"
  | "BITGET_SIGNATURE_ERROR"
  | "BITGET_PARAMETER_ERROR"
  | "BITGET_RATE_LIMITED"
  | "BITGET_SYSTEM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_REJECTED"
  | "INVALID_RESPONSE";

export type BitgetErrorCategory =
  | "path" | "clock" | "credential" | "timestamp" | "signature"
  | "parameter" | "rate_limit" | "system" | "network" | "response";

type SafeDiagnostic = {
  category: BitgetErrorCategory;
  requestPath: string;
  httpStatus?: number;
  bitgetCode?: string;
  durationMs: number;
  topLevelKeys?: string[];
  dataKeys?: string[];
  schemaFailurePaths?: string[];
};

const knownCodes: Record<string, [BitgetSafeCode, BitgetErrorCategory]> = {
  "40006": ["BITGET_INVALID_API_KEY", "credential"],
  "40008": ["BITGET_TIMESTAMP_EXPIRED", "timestamp"],
  "40009": ["BITGET_SIGNATURE_ERROR", "signature"],
  "40017": ["BITGET_PARAMETER_ERROR", "parameter"],
  "429": ["BITGET_RATE_LIMITED", "rate_limit"],
  "25000": ["BITGET_SYSTEM_TIMEOUT", "system"],
  "25001": ["BITGET_SYSTEM_TIMEOUT", "system"],
};

function safeBitgetCode(value: string | undefined) {
  return value && /^\d{3,6}$/.test(value) ? value : undefined;
}

function classifyError(httpStatus: number, bitgetCode?: string): [BitgetSafeCode, BitgetErrorCategory] {
  if (bitgetCode && knownCodes[bitgetCode]) return knownCodes[bitgetCode];
  if (httpStatus === 429) return ["BITGET_RATE_LIMITED", "rate_limit"];
  if (httpStatus === 401 || httpStatus === 403 || ["40001", "40002", "40003"].includes(bitgetCode ?? "")) {
    return ["UPSTREAM_REJECTED", "credential"];
  }
  return ["UPSTREAM_UNAVAILABLE", "system"];
}

export class BitgetGatewayError extends Error {
  constructor(
    public readonly safeCode: BitgetSafeCode,
    public readonly diagnostic: SafeDiagnostic,
  ) {
    super(safeCode);
    this.name = "BitgetGatewayError";
  }
}

export class BitgetReadOnlyClient {
  constructor(
    private readonly credentials: BitgetCredentials,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get<T>(path: string, query: Record<string, QueryValue> = {}): Promise<T> {
    const response = await this.getWithMetadata<T>(path, query);
    return response.data;
  }

  async getWithMetadata<T>(path: string, query: Record<string, QueryValue> = {}): Promise<{
    data: T;
    metadata: BitgetResponseMetadata;
  }> {
    const startedAt = Date.now();
    const durationMs = () => Date.now() - startedAt;
    if (!allowedReadPaths.has(path)) {
      throw new BitgetGatewayError("PATH_NOT_ALLOWED", {
        category: "path", requestPath: "not-allowlisted", durationMs: durationMs(),
      });
    }

    const queryString = canonicalQuery(query);
    const timestamp = String(this.now());
    const prehash = buildBitgetPrehash({ timestamp, method: "GET", path, queryString });
    const signature = signBitgetRequest(prehash, this.credentials.apiSecret);
    const url = `${BITGET_BASE_URL}${path}${queryString ? `?${queryString}` : ""}`;

    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          "ACCESS-KEY": this.credentials.apiKey,
          "ACCESS-SIGN": signature,
          "ACCESS-TIMESTAMP": timestamp,
          "ACCESS-PASSPHRASE": this.credentials.passphrase,
          "Content-Type": "application/json",
          locale: "en-US",
        },
      });
    } catch {
      throw new BitgetGatewayError("UPSTREAM_UNAVAILABLE", {
        category: "network", requestPath: path, durationMs: durationMs(),
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      const [safeCode, category] = response.ok
        ? ["INVALID_RESPONSE", "response"] as const
        : classifyError(response.status);
      throw new BitgetGatewayError(safeCode, {
        category, requestPath: path, httpStatus: response.status, durationMs: durationMs(),
      });
    }

    const parsed = envelopeSchema.safeParse(payload);
    const metadata = responseShape(payload, response.status);
    if (!parsed.success) {
      const [safeCode, category] = response.ok
        ? ["INVALID_RESPONSE", "response"] as const
        : classifyError(response.status);
      throw new BitgetGatewayError(safeCode, {
        category, requestPath: path, httpStatus: response.status, durationMs: durationMs(),
        bitgetCode: metadata.bitgetCode,
        topLevelKeys: metadata.topLevelKeys,
        dataKeys: metadata.dataKeys,
        schemaFailurePaths: parsed.error.issues.map((issue) => issue.path.join(".")),
      });
    }
    if (!response.ok || parsed.data.code !== "00000") {
      const bitgetCode = safeBitgetCode(parsed.data.code);
      const [safeCode, category] = classifyError(response.status, bitgetCode);
      throw new BitgetGatewayError(safeCode, {
        category, requestPath: path, httpStatus: response.status, bitgetCode, durationMs: durationMs(),
      });
    }
    return { data: parsed.data.data as T, metadata };
  }
}
