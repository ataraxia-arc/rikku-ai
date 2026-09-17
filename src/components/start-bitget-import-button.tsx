"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

type StartImportResult =
  | { ok: true; importJobId: string }
  | { ok: false; code?: string; stage?: string };

const importErrorCopy: Record<string, string> = {
  AUTH_REQUIRED: "Your RIKKU session expired. Sign in again to start the import.",
  AUTH_UNAVAILABLE: "RIKKU could not check your session. Refresh the page and try again.",
  CONNECTION_NOT_FOUND: "No verified Bitget connection was found. Return to the connection page.",
  CONNECTION_NOT_VERIFIED: "Your Bitget connection is not verified. Return to the connection page.",
  VERIFIED_CONNECTION_REQUIRED: "No verified Bitget connection was found for this account. Return to the connection page.",
  CONNECTION_UNAVAILABLE: "RIKKU could not read your stored Bitget connection. Try again shortly.",
  SECURE_STORAGE_UNAVAILABLE: "RIKKU cannot open secure connection storage right now. Try again shortly.",
  IMPORT_STORAGE_UNAVAILABLE: "RIKKU could not create the import job. Try again shortly.",
  IMPORT_START_FAILED: "RIKKU could not start the import. Try again shortly.",
  IMPORT_WORKER_NOT_CONFIGURED: "RIKKU's secure import worker is not configured yet. Ask the app owner to complete server setup.",
  IMPORT_JOB_CREATE_FAILED: "RIKKU could not create the import job. Try again shortly.",
  IMPORT_SCHEMA_NOT_APPLIED: "RIKKU's import database setup has not been applied yet. Your Bitget connection remains active; no credentials need to be entered again.",
  CONNECTION_LOOKUP_FAILED: "RIKKU could not check the import-ready connection record. Try again shortly.",
};

export function StartBitgetImportButton({ label = "Continue to import" }: { label?: string }) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [signInNeeded, setSignInNeeded] = useState(false);

  async function startImport() {
    if (inFlight.current) return;
    inFlight.current = true;
    let navigating = false;
    setStarting(true);
    setError("");
    setSignInNeeded(false);

    try {
      const response = await fetch("/api/imports", { method: "POST", cache: "no-store" });
      const result = (await response.json()) as StartImportResult;
      if (!response.ok || !result.ok) {
        const code = result.ok ? "" : result.code ?? "";
        setError(importErrorCopy[code] ?? "RIKKU could not start the import. Try again shortly.");
        setSignInNeeded(response.status === 401 || code === "AUTH_REQUIRED");
        return;
      }
      if (typeof result.importJobId !== "string" || !result.importJobId || result.importJobId.length > 128) {
        setError("RIKKU did not return a valid import job. Try again shortly.");
        return;
      }
      router.push(`/onboarding/import?job=${encodeURIComponent(result.importJobId)}`);
      navigating = true;
    } catch {
      setError("RIKKU could not reach the import service. Try again shortly.");
    } finally {
      if (!navigating) {
        inFlight.current = false;
        setStarting(false);
      }
    }
  }

  return (
    <div>
      <Button type="button" disabled={starting} onClick={startImport}>
        {starting ? <><LoaderCircle className="spin" size={15} /> Starting import…</> : <>{label} <ArrowRight size={15} /></>}
      </Button>
      {error && <div className="connection-result connection-result-error" role="alert">{error}{signInNeeded && <> <Link href="/login">Sign in</Link></>}</div>}
    </div>
  );
}
