import "server-only";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { AskMode } from "@/lib/ask/types";

export const modelOutputSchema = z.object({
  answerKind: z.enum(["fact", "analysis", "investigation"]),
  finding: z.object({
    headline: z.string().min(1).max(220),
    summary: z.string().min(1).max(900),
  }).strict(),
  interpretation: z.string().min(1).max(1_200),
  reasoningPoints: z.array(z.object({
    kind: z.enum(["observation", "hypothesis", "alternative", "counter_evidence", "uncertainty", "next_investigation"]),
    statement: z.string().min(1).max(500),
    rationale: z.string().max(700),
    evidenceLabels: z.array(z.string().min(1).max(120)).max(8),
    test: z.string().max(500).nullable(),
  }).strict()).max(10),
  evidenceLabels: z.array(z.string().min(1).max(120)).max(12),
  confidence: z.enum(["low", "moderate", "high", "not_assessable"]),
  confidenceReasons: z.array(z.string().min(1).max(300)).max(6),
  limitations: z.array(z.string().min(1).max(400)).max(8),
  suggestedFollowups: z.array(z.string().min(1).max(180)).max(4),
}).strict();

export type ModelInterpretation = z.infer<typeof modelOutputSchema>;

export const ASK_MODEL_CONFIG: Record<AskMode, {
  model: "gpt-5.6-luna" | "gpt-5.6-terra" | "gpt-5.6-sol";
  effort: "low" | "medium" | "high";
  verbosity: "low" | "medium";
}> = {
  scout: { model: "gpt-5.6-luna", effort: "low", verbosity: "low" },
  analyst: { model: "gpt-5.6-terra", effort: "medium", verbosity: "medium" },
  investigator: { model: "gpt-5.6-sol", effort: "high", verbosity: "medium" },
};

export const reasoningProviderErrorCodes = [
  "AUTH",
  "QUOTA",
  "RATE_LIMIT",
  "MODEL_NOT_FOUND",
  "NETWORK",
  "TIMEOUT",
  "INVALID_RESPONSE",
  "UNKNOWN",
] as const;

export type ReasoningProviderErrorCode = (typeof reasoningProviderErrorCodes)[number];
export type ReasoningConfigurationErrorCode = "NOT_CONFIGURED";

export class ReasoningProviderError extends Error {
  constructor(
    public readonly code: ReasoningProviderErrorCode | ReasoningConfigurationErrorCode,
    public readonly safeProviderDetails?: { status: number | null; code: string; type: string },
  ) {
    super(code);
    this.name = "ReasoningProviderError";
  }
}

export type ReasoningProviderId = "openai" | "openai_compatible" | "groq";

export type ReasoningProviderRequest = {
  mode: AskMode;
  prompt: string;
  retryInstruction?: string;
};

export interface ReasoningProvider {
  readonly id: ReasoningProviderId;
  modelIdentifier(mode: AskMode): string;
  generateStructuredResponse(request: ReasoningProviderRequest): Promise<unknown>;
}

type Environment = Record<string, string | undefined>;

function value(env: Environment, name: string) {
  return env[name]?.trim() || null;
}

function errorDetails(error: unknown) {
  if (!error || typeof error !== "object") return { status: null, code: "", type: "", message: "" };
  const item = error as Record<string, unknown>;
  const nested = item.error && typeof item.error === "object" ? item.error as Record<string, unknown> : null;
  return {
    status: typeof item.status === "number" ? item.status : null,
    code: String(item.code ?? nested?.code ?? "").toLowerCase(),
    type: String(item.type ?? nested?.type ?? "").toLowerCase(),
    message: String(item.message ?? nested?.message ?? "").toLowerCase(),
  };
}

export function normalizeReasoningProviderError(error: unknown) {
  if (error instanceof ReasoningProviderError) return error;
  const details = errorDetails(error);
  const safeDetails = { status: details.status, code: details.code, type: details.type };
  const combined = `${details.code} ${details.type} ${details.message}`;
  if (error instanceof OpenAI.AuthenticationError || details.status === 401 || details.status === 403) {
    return new ReasoningProviderError("AUTH", safeDetails);
  }
  if (details.status === 429 && (details.code === "rate_limit_exceeded" || details.type === "tokens")) {
    return new ReasoningProviderError("RATE_LIMIT", safeDetails);
  }
  if (details.status === 429 && /(quota|credit|billing|balance)/.test(combined)) {
    return new ReasoningProviderError("QUOTA", safeDetails);
  }
  if (details.status === 429) return new ReasoningProviderError("RATE_LIMIT", safeDetails);
  if (details.status === 400 && details.code === "json_validate_failed") {
    return new ReasoningProviderError("INVALID_RESPONSE", safeDetails);
  }
  if ((details.status === 400 || details.status === 404) && /(model|deployment).*(not found|does not exist|unavailable)|model_not_found/.test(combined)) {
    return new ReasoningProviderError("MODEL_NOT_FOUND", safeDetails);
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError || error instanceof DOMException && error.name === "TimeoutError") {
    return new ReasoningProviderError("TIMEOUT", safeDetails);
  }
  if (error instanceof OpenAI.APIConnectionError || error instanceof TypeError) {
    return new ReasoningProviderError("NETWORK", safeDetails);
  }
  return new ReasoningProviderError("UNKNOWN", safeDetails);
}

function combinedPrompt(request: ReasoningProviderRequest) {
  return request.retryInstruction ? `${request.prompt}\n\n${request.retryInstruction}` : request.prompt;
}

class OpenAIResponsesProvider implements ReasoningProvider {
  readonly id = "openai" as const;

  constructor(private readonly apiKey: string) {}

  modelIdentifier(mode: AskMode) {
    return ASK_MODEL_CONFIG[mode].model;
  }

  async generateStructuredResponse(request: ReasoningProviderRequest) {
    const config = ASK_MODEL_CONFIG[request.mode];
    try {
      const client = new OpenAI({ apiKey: this.apiKey, timeout: 25_000, maxRetries: 0 });
      const result = await client.responses.parse({
        model: config.model,
        store: false,
        reasoning: { effort: config.effort },
        text: {
          verbosity: config.verbosity,
          format: zodTextFormat(modelOutputSchema, "rikku_answer"),
        },
        input: [
          { role: "developer", content: "Return a validated RIKKU interpretation of the supplied authoritative evidence. Never add unsupported metrics." },
          { role: "user", content: combinedPrompt(request) },
        ],
      });
      if (!result.output_parsed) throw new ReasoningProviderError("INVALID_RESPONSE");
      return result.output_parsed;
    } catch (error) {
      throw normalizeReasoningProviderError(error);
    }
  }
}

const compatibleJsonInstruction = `Return only one JSON object with every field below. Do not wrap it in Markdown.
{
  "answerKind": "fact | analysis | investigation",
  "finding": { "headline": "string", "summary": "string" },
  "interpretation": "string",
  "reasoningPoints": [{ "kind": "observation | hypothesis | alternative | counter_evidence | uncertainty | next_investigation", "statement": "string", "rationale": "string", "evidenceLabels": ["exact supplied label"], "test": "string or null" }],
  "evidenceLabels": ["exact supplied label"],
  "confidence": "low | moderate | high | not_assessable",
  "confidenceReasons": ["string"],
  "limitations": ["string"],
  "suggestedFollowups": ["string"]
}`;

export function parseCompatibleJson(content: unknown) {
  if (typeof content !== "string" || !content.trim()) throw new ReasoningProviderError("INVALID_RESPONSE");
  const trimmed = content.trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ReasoningProviderError("INVALID_RESPONSE");
  try {
    return JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    throw new ReasoningProviderError("INVALID_RESPONSE");
  }
}

class OpenAICompatibleChatProvider implements ReasoningProvider {
  constructor(
    readonly id: "openai_compatible" | "groq",
    private readonly model: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
  ) {}

  modelIdentifier() {
    return this.model;
  }

  async generateStructuredResponse(request: ReasoningProviderRequest) {
    try {
      const client = new OpenAI({ apiKey: this.apiKey, baseURL: this.baseURL, timeout: 25_000, maxRetries: 0 });
      if (this.id === "groq") {
        const result = await client.chat.completions.create({
          model: this.model,
          messages: [
            { role: "system", content: `You are RIKKU's reasoning provider. The supplied deterministic evidence is authoritative. Never invent financial metrics. ${compatibleJsonInstruction}` },
            { role: "user", content: combinedPrompt(request) },
          ],
          response_format: { type: "json_object" },
          max_completion_tokens: 2_000,
        });
        return parseCompatibleJson(result.choices[0]?.message?.content);
      }
      const result = await client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: `You are RIKKU's reasoning provider. The supplied deterministic evidence is authoritative. Never invent financial metrics. ${compatibleJsonInstruction}` },
          { role: "user", content: combinedPrompt(request) },
        ],
      });
      return parseCompatibleJson(result.choices[0]?.message?.content);
    } catch (error) {
      throw normalizeReasoningProviderError(error);
    }
  }
}

function validatedBaseUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ReasoningProviderError("NOT_CONFIGURED");
  }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.username || url.password || !(url.protocol === "https:" || localHttp)) throw new ReasoningProviderError("NOT_CONFIGURED");
  return url.toString().replace(/\/$/, "");
}

export function createReasoningProvider(env: Environment = process.env): ReasoningProvider {
  const custom = {
    apiKey: value(env, "LLM_API_KEY"),
    baseURL: value(env, "LLM_BASE_URL"),
    model: value(env, "LLM_MODEL"),
  };
  if (custom.apiKey || custom.baseURL || custom.model) {
    if (!custom.apiKey || !custom.baseURL || !custom.model) throw new ReasoningProviderError("NOT_CONFIGURED");
    const baseURL = validatedBaseUrl(custom.baseURL);
    const providerId = new URL(baseURL).hostname === "api.groq.com" ? "groq" : "openai_compatible";
    return new OpenAICompatibleChatProvider(providerId, custom.model, custom.apiKey, baseURL);
  }
  const openAiKey = value(env, "OPENAI_API_KEY");
  if (openAiKey) return new OpenAIResponsesProvider(openAiKey);
  throw new ReasoningProviderError("NOT_CONFIGURED");
}

export function isReasoningProviderConfigured(env: Environment = process.env) {
  try {
    createReasoningProvider(env);
    return true;
  } catch {
    return false;
  }
}
