"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, CircleDashed, Database, LoaderCircle } from "lucide-react";
import { StartBitgetImportButton } from "@/components/start-bitget-import-button";

type ConnectionState = "checking" | "connected" | "disconnected" | "error";
type ImportStage =
  | "reading_account"
  | "importing_balances"
  | "importing_positions"
  | "importing_orders"
  | "importing_fills"
  | "importing_fees"
  | "reconstructing_trades"
  | "loading_market_context"
  | "running_first_analysis"
  | "complete";
type ImportStatus = "queued" | "running" | "completed" | "failed";

type ImportJob = {
  id: string;
  status: ImportStatus;
  stage: string | null;
  counts: {
    orders: number;
    fills: number;
    trades: number;
    fees: number;
    assets: number;
    positions: number;
  };
  coverage: { earliest: string | null; latest: string | null };
  analysis: { status: "completed" | "insufficient_data" | null; sampleSize: number };
  errorCode: string | null;
  errorStage: string | null;
};

const stages: { id: ImportStage; label: string }[] = [
  { id: "reading_account", label: "Reading account" },
  { id: "importing_balances", label: "Importing balances" },
  { id: "importing_orders", label: "Importing orders" },
  { id: "importing_fills", label: "Importing fills" },
  { id: "importing_fees", label: "Importing fees" },
  { id: "importing_positions", label: "Importing positions" },
  { id: "reconstructing_trades", label: "Reconstructing trades" },
  { id: "loading_market_context", label: "Loading market context" },
  { id: "running_first_analysis", label: "Running first analysis" },
];

function stageLabel(stage: string | null) {
  if (stage === "complete") return "Completed";
  return stages.find((item) => item.id === stage)?.label ?? "Import processing";
}

function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : "Not reported";
}

function dateLabel(value: string | null) {
  if (!value) return "Not reported";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Not reported";
  return `${date.toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC`;
}

function jobErrorCopy(job: ImportJob) {
  const boundary = stageLabel(job.errorStage ?? job.stage);
  const safeCode = job.errorCode && /^[A-Z][A-Z0-9_]{0,63}$/.test(job.errorCode) ? ` (${job.errorCode})` : "";
  return `Import stopped during ${boundary.toLowerCase()}${safeCode}. No missing records or analysis results have been fabricated.`;
}

export function BitgetImportStatus({ jobId }: { jobId: string | null }) {
  const [connection, setConnection] = useState<ConnectionState>("checking");
  const [connectionError, setConnectionError] = useState("");
  const [job, setJob] = useState<ImportJob | null>(null);
  const [jobError, setJobError] = useState("");

  useEffect(() => {
    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    async function readConnection() {
      try {
        const response = await fetch("/api/bitget/verify", { cache: "no-store" });
        const result = await response.json() as { ok: boolean; connected?: boolean; code?: string };
        if (!active) return;
        if (!response.ok || !result.ok) {
          setConnection("error");
          setConnectionError(response.status === 401 || result.code === "AUTH_REQUIRED"
            ? "Your RIKKU session expired. Sign in again."
            : "RIKKU could not check your stored Bitget connection. Refresh the page to retry.");
          return;
        }
        setConnection(result.connected ? "connected" : "disconnected");
      } catch {
        if (active) {
          setConnection("error");
          setConnectionError("RIKKU could not check your stored Bitget connection. Refresh the page to retry.");
        }
      }
    }

    async function readJob() {
      if (!jobId || !active) return;
      try {
        const response = await fetch(`/api/imports/${encodeURIComponent(jobId)}`, { cache: "no-store" });
        const result = await response.json() as { ok: boolean; job?: ImportJob; code?: string };
        if (!active) return;
        if (!response.ok || !result.ok || !result.job) {
          setJobError(response.status === 401 || result.code === "AUTH_REQUIRED"
            ? "Your RIKKU session expired. Sign in again to view this import."
            : response.status === 404
              ? "This import job was not found for your account. Return to the connection page and start a new import."
              : "RIKKU could not read import progress. Retrying shortly.");
        } else if (!["queued", "running", "completed", "failed"].includes(result.job.status)) {
          setJobError("RIKKU returned an unsupported import status. Retrying shortly.");
        } else {
          setJob(result.job);
          setJobError("");
          if (result.job.status === "completed" || result.job.status === "failed") return;
        }
      } catch {
        if (active) setJobError("RIKKU could not reach the import service. Retrying shortly.");
      }
      if (active) pollTimer = setTimeout(readJob, 2500);
    }

    void readConnection();
    void readJob();
    return () => {
      active = false;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [jobId]);

  const activeStageIndex = stages.findIndex((item) => item.id === job?.stage);
  const failedStage = job?.errorStage ?? job?.stage;

  return (
    <section className="import-card" aria-live="polite">
      <span className="onboarding-icon"><Database size={22} /></span>
      <p className="section-kicker">BUILDING YOUR MEMORY</p>
      {!jobId ? (
        <>
          <h1>{connection === "connected" ? "Ready to import real Bitget data" : connection === "checking" ? "Checking your connection" : "No import is running"}</h1>
          {connection === "connected" ? (
            <>
              <p>Your verified read-only connection is available. Start an import to read the account history Bitget makes available.</p>
              <div className="import-awaiting"><CheckCircle2 size={17} /><span>Bitget connection verified</span></div>
              <StartBitgetImportButton label="Start import" />
            </>
          ) : connection === "checking" ? (
            <div className="import-awaiting"><LoaderCircle className="spin" size={17} /><span>Checking the stored connection</span></div>
          ) : (
            <>
              <p>{connectionError || "No verified Bitget connection is available for this RIKKU account."}</p>
              <Link className="landing-cta-primary" href={connectionError.includes("expired") ? "/login" : "/onboarding/bitget/connect"}>Return to connection</Link>
            </>
          )}
        </>
      ) : (
        <>
          <h1>{job?.status === "completed" ? "Real-data import completed" : job?.status === "failed" ? "Import needs attention" : "Importing real Bitget data"}</h1>
          <p>{job?.status === "queued" ? "The secure import job is queued." : job?.status === "running" ? `Current stage: ${stageLabel(job.stage)}.` : job?.status === "completed" ? "The available records have been imported. Review the actual coverage below." : "Progress below reflects only confirmed server results."}</p>
          {connection === "connected" && <div className="import-awaiting"><CheckCircle2 size={17} /><span>Bitget connection verified</span></div>}
          {connection === "checking" && <div className="import-awaiting"><LoaderCircle className="spin" size={17} /><span>Checking stored connection</span></div>}
          {connection === "disconnected" && <div className="connection-result connection-result-error" role="alert">The stored Bitget connection is no longer active.</div>}
          {connectionError && <div className="connection-result connection-result-error" role="alert">{connectionError}</div>}
          {jobError && <div className="connection-result connection-result-error" role="alert">{jobError}</div>}
          {job && (
            <>
              {job.status === "failed" && <div className="connection-result connection-result-error" role="alert">{jobErrorCopy(job)}</div>}
              <div className="import-list" aria-label="Import stages">
                {stages.map((stage, index) => {
                  const failed = job.status === "failed" && stage.id === failedStage;
                  const completed = job.status === "completed" || (activeStageIndex > index && job.status !== "queued");
                  const current = job.status === "running" && activeStageIndex === index;
                  return <div key={stage.id}><span>{stage.label}</span><span aria-label={failed ? "Failed" : completed ? "Complete" : current ? "In progress" : "Pending"}>{failed ? <AlertCircle size={16} /> : completed ? <CheckCircle2 size={16} /> : current ? <LoaderCircle className="spin" size={16} /> : <CircleDashed size={16} />}</span></div>;
                })}
              </div>
              <div className="import-list" aria-label="Actual imported counts">
                <div><span>Orders imported</span><strong>{count(job.counts?.orders)}</strong></div>
                <div><span>Fills imported</span><strong>{count(job.counts?.fills)}</strong></div>
                <div><span>Trades reconstructed</span><strong>{count(job.counts?.trades)}</strong></div>
                <div><span>Financial records imported</span><strong>{count(job.counts?.fees)}</strong></div>
                <div><span>Assets imported</span><strong>{count(job.counts?.assets)}</strong></div>
                <div><span>Positions imported</span><strong>{count(job.counts?.positions)}</strong></div>
              </div>
              <div className="import-list" aria-label="Actual data coverage">
                <div><span>Earliest record</span><strong>{dateLabel(job.coverage?.earliest)}</strong></div>
                <div><span>Latest record</span><strong>{dateLabel(job.coverage?.latest)}</strong></div>
              </div>
              <p className="coverage-note">Coverage reflects returned Bitget records, not a claim of all trading history.</p>
              {job.analysis?.status && (
                <p className="coverage-note">First deterministic analysis: {job.analysis.status === "completed"
                  ? `completed using ${count(job.analysis.sampleSize)} reconstructed trades.`
                  : "Insufficient data."}</p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
