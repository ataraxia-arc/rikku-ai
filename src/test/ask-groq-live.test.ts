// @vitest-environment node
// Opt-in, read-only integration check. Never runs on CI or normal test runs.
import { expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
vi.mock("server-only", () => ({}));
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { createSupabaseAskDataSource } from "@/lib/ask/supabase-data-source";
import { createReasoningProvider, ReasoningProviderError, type ReasoningProvider } from "@/lib/ask/reasoning-provider";
import { isDirectImportFactPlan, planAskSemantically } from "@/lib/ask/semantic-planner";
import { orchestrateAsk } from "@/lib/ask/orchestrator";
import { reasonAboutEvidence, type RecentAskExchange } from "@/lib/ask/openai-reasoner";

it.skipIf(process.env.RIKKU_LIVE_GROQ !== "1")("validates the requested conversation against real imported evidence", async () => {
  process.loadEnvFile(".env.local");
  const service = createSupabaseServiceClient();
  // Never read the credential table, decrypt credentials, write records, or call Bitget.
  const importJobId = process.env.RIKKU_LIVE_IMPORT_JOB;
  if (!importJobId) throw new Error("EXPLICIT_REAL_IMPORT_JOB_REQUIRED");
  const { data: jobs, error } = await service.from("import_jobs")
    .select("user_id,connection_id,completed_at")
    .eq("id", importJobId).eq("job_type", "bitget_initial").eq("status", "completed");
  if (error || !jobs?.length) throw new Error("REAL_IMPORT_UNAVAILABLE");
  const owners = [...new Set(jobs.map((job) => job.user_id))];
  if (owners.length !== 1) throw new Error("REAL_IMPORT_OWNER_AMBIGUOUS");
  const job = jobs[0];
  if (!job.connection_id) throw new Error("REAL_IMPORT_CONNECTION_MISSING");
  const source = createSupabaseAskDataSource(service, owners[0]);
  // Offline evidence harness, not an auth test: the completed import's FK proves
  // its linked connection. The authenticated production RPC is not bypassed/changed.
  source.getConnectionStatus = async () => ({ connected: true, lastSyncedAt: job.completed_at });
  const summary = await source.getLatestCompletedImport();
  if (!summary || !summary.fills) throw new Error("REAL_FILLS_UNAVAILABLE");
  const report = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
  report({ event: "live_evidence", fills: summary.fills, orders: summary.orders, completedTrades: summary.completedTrades, windowStart: summary.earliestRecordAt, windowEnd: summary.latestRecordAt });

  const raw = createReasoningProvider();
  expect(raw.id).toBe("groq");
  expect(raw.modelIdentifier("analyst")).toBe("openai/gpt-oss-120b");
  let lastCall = 0;
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    const response = await realFetch(...args);
    if (String(args[0]).startsWith("https://api.groq.com/") && response.ok) {
      const body = await response.clone().json();
      report({ event: "live_transport", status: response.status, finishReason: body.choices?.[0]?.finish_reason, completionTokens: body.usage?.completion_tokens, reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens });
    }
    return response;
  });
  // Avoid spending the Free Tier's per-minute allowance in a burst. No hidden retries.
  async function paced<T>(call: () => Promise<T>) {
    const wait = Math.max(0, lastCall + 61_000 - Date.now());
    if (wait) await delay(wait);
    lastCall = Date.now();
    try { return await call(); } catch (error) {
      if (error instanceof ReasoningProviderError) report({ event: "live_provider_failure", category: error.code, status: error.safeProviderDetails?.status, code: error.safeProviderDetails?.code, type: error.safeProviderDetails?.type });
      throw error instanceof ReasoningProviderError ? error : new Error("LIVE_PROVIDER_FAILURE");
    }
  }
  const provider: ReasoningProvider = {
    id: raw.id, modelIdentifier: (mode) => raw.modelIdentifier(mode),
    generateStructuredPlan: (request) => paced(() => raw.generateStructuredPlan(request)),
    generateStructuredResponse: (request) => paced(() => raw.generateStructuredResponse(request)),
  };
  const recent: RecentAskExchange[] = [];
  const questions = [
    "how many fills do i got",
    "anything stand out about how ive been trading lately?",
    "could there be another explanation?",
    "what evidence makes that idea weaker?",
    "what can you not tell from my data?",
  ];
  for (const [index, question] of questions.entries()) {
    const plan = await planAskSemantically({ question, mode: "analyst", conversationContext: recent, provider });
    if (index === 2 || index === 3) expect(plan.needsConversationContext).toBe(true);
    report({ event: "live_plan", query: index + 1, tools: plan.toolRequests, context: plan.needsConversationContext });
    const evidence = await orchestrateAsk({ source, question, mode: "analyst", plan, initialImport: summary, history: recent.map((turn) => turn.question) });
    expect(["completed", "insufficient_data"]).toContain(evidence.status);
    const directFact = isDirectImportFactPlan(plan) && evidence.status === "completed";
    const answer = directFact ? evidence : await reasonAboutEvidence({ response: evidence, recent, semanticPlan: plan, provider, correlationId: `local-live-${index + 1}` });
    if (directFact) {
      expect(plan.requestedImportMetric).toBe("fills");
      expect(`${answer.finding.headline} ${answer.finding.summary}`).toContain(String(summary.fills));
    } else {
      expect(answer.reasoningStatus).toBe("external_llm");
      expect(answer.reasoningProvider?.id).toBe("groq");
    }
    expect(answer.evidence).toEqual(evidence.evidence);
    expect(answer.interpretation.trim()).not.toMatch(/^(?:\{|```)/);
    report({ event: "live_validated_answer", query: index + 1, provider: raw.id, directFact, fallback: false, answer: answer.interpretation });
    recent.push({ question, conclusion: `${answer.finding.headline} ${answer.finding.summary} ${answer.interpretation} ${answer.reasoningPoints.map((point) => point.statement).join(" ")}`.slice(0, 2500) });
  }
}, 1_200_000);
