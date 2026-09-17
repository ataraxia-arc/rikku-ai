"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StartBitgetImportButton } from "@/components/start-bitget-import-button";
import { credentialFieldNames, validateBitgetCredentials, type CredentialFieldErrors, type CredentialFieldName } from "@/lib/bitget/credential-validation";

type VerifyResult =
  | { ok: true; connection: { externalUid: string; permission: string; keyFingerprint: string } }
  | { ok: false; code: string };

type ConnectionStatus = {
  ok: boolean;
  connected?: boolean;
  code?: string;
  storageReady?: boolean;
};

const errorCopy: Record<string, string> = {
  AUTH_REQUIRED: "Your RIKKU session expired. Sign in again.",
  AUTH_UNAVAILABLE: "RIKKU could not check your sign-in session. Refresh the page and try again.",
  INVALID_CREDENTIAL_FIELDS: "Complete all required Bitget API fields.",
  RATE_LIMITED: "Too many attempts. Wait one minute and try again.",
  READ_WRITE_KEY: "This API key is not read-only. Create a read-only key.",
  FORBIDDEN_PERMISSION: "This API key is not read-only. Create a read-only key.",
  UNVERIFIABLE_PERMISSION_MODE: "RIKKU cannot verify that Bitget marked this API key read-only. Nothing was stored.",
  MISSING_REQUIRED_PERMISSIONS: "This key lacks the Bitget account and trade-history read permissions RIKKU needs. Nothing was stored.",
  BITGET_INVALID_API_KEY: "Bitget rejected the API key.",
  BITGET_SIGNATURE_ERROR: "Bitget rejected the request signature. RIKKU's signing or secret may be incorrect.",
  BITGET_TIMESTAMP_EXPIRED: "Bitget rejected the request timestamp. Check system clock synchronization.",
  BITGET_PARAMETER_ERROR: "Bitget rejected a request parameter. Nothing was stored.",
  BITGET_RATE_LIMITED: "Bitget is rate limiting connection checks. Wait and try again.",
  BITGET_SYSTEM_TIMEOUT: "RIKKU could not reach Bitget. Try again shortly.",
  CLOCK_SYNC_UNAVAILABLE: "RIKKU could not check Bitget server time. Try again shortly.",
  UPSTREAM_REJECTED: "Bitget rejected these credentials. Check the API key, secret, and passphrase.",
  UPSTREAM_UNAVAILABLE: "RIKKU could not reach Bitget. Try again shortly.",
  INVALID_BITGET_RESPONSE: "Bitget returned an unexpected response. Nothing was stored.",
  SECURE_STORAGE_UNAVAILABLE: "Encrypted connection storage is not configured yet. Nothing was stored.",
  SUPABASE_NOT_CONFIGURED: "RIKKU sign-in is not configured. Ask the app owner to set up Supabase before connecting Bitget.",
  INVALID_REQUEST: "The connection request was invalid. Please try again.",
  REQUEST_TOO_LARGE: "The connection request was too large. Please check the fields and try again.",
  VERIFICATION_FAILED: "The connection could not be verified. Nothing was stored. Please try again.",
};

const trustPoints = [
  { icon: ShieldCheck, label: "Read-only" },
  { icon: LockKeyhole, label: "Encrypted" },
  { icon: Unplug, label: "Cannot trade, transfer, or withdraw" },
  { icon: CheckCircle2, label: "Disconnect anytime" },
];

export function BitgetConnectForm({ guided = false }: { guided?: boolean }) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "checking" | "verified" | "error">("idle");
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<CredentialFieldErrors>({});

  function clearFieldError(field: CredentialFieldName) {
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  }

  useEffect(() => {
    let active = true;
    void fetch("/api/bitget/verify", { cache: "no-store" })
      .then((response) => response.json() as Promise<ConnectionStatus>)
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          setConnectionError(errorCopy[result.code ?? ""] ?? "RIKKU could not check the connection. Please try again.");
        } else if (result.storageReady === false) {
          setConnectionError(errorCopy.SECURE_STORAGE_UNAVAILABLE);
        } else if (result.connected) {
          setConnected(true);
        }
      })
      .catch(() => {
        if (active) setConnectionError("RIKKU could not check the connection. Refresh the page and try again.");
      });
    return () => {
      active = false;
    };
  }, []);

  async function verify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const validation = validateBitgetCredentials({
      apiKey: formData.get("apiKey"),
      apiSecret: formData.get("apiSecret"),
      passphrase: formData.get("passphrase"),
    });

    if (!validation.ok) {
      setFieldErrors(validation.fieldErrors);
      setStatus("error");
      setMessage(errorCopy.INVALID_CREDENTIAL_FIELDS);
      const firstInvalid = credentialFieldNames.find((field) => validation.fieldErrors[field]);
      if (firstInvalid) (form.elements.namedItem(firstInvalid) as HTMLInputElement | null)?.focus();
      return;
    }

    setFieldErrors({});
    setStatus("checking");
    setMessage("");

    try {
      const response = await fetch("/api/bitget/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validation.data),
      });
      const result = (await response.json()) as VerifyResult;
      form.reset();

      if (!result.ok) {
        setStatus("error");
        setMessage(errorCopy[result.code] ?? "The connection could not be completed safely.");
        return;
      }

      setConnected(true);
      setStatus("verified");
      setMessage("Read-only Bitget access verified and stored securely.");
    } catch {
      form.reset();
      setStatus("error");
      setMessage("The connection did not complete. Nothing was stored.");
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect Bitget from RIKKU? Automatic syncing will stop.")) return;
    setDisconnecting(true);
    try {
      const response = await fetch("/api/bitget/verify", { method: "DELETE" });
      if (response.ok) {
        setConnected(false);
        setAdvancedOpen(false);
        setStatus("idle");
        setMessage("");
      } else {
        setMessage("RIKKU could not disconnect Bitget. Please try again.");
      }
    } catch {
      setMessage("RIKKU could not disconnect Bitget. Please try again.");
    } finally {
      setDisconnecting(false);
    }
  }

  if (connected) {
    return (
      <div className="bitget-connected" role="status">
        <span className="connected-orbit"><Check size={22} /></span>
        <p className="connection-eyebrow">BITGET CONNECTED</p>
        <h2>Your read-only connection is active.</h2>
        <p>RIKKU will reconnect automatically when you sign in. You will only need the credentials again if the key is revoked or expires.</p>
        <div className="connected-actions">
          <StartBitgetImportButton />
          <Button type="button" variant="ghost" onClick={disconnect} disabled={disconnecting}>
            {disconnecting ? <LoaderCircle className="spin" size={15} /> : <Unplug size={15} />} Disconnect
          </Button>
        </div>
        {message && <div className="connection-result connection-result-error" role="alert">{message}</div>}
      </div>
    );
  }

  return (
    <div className="bitget-connect-shell">
      <div className="connection-primary">
        <div className="trust-list" aria-label="Connection protections">
          {trustPoints.map(({ icon: Icon, label }) => (
            <div key={label}><Icon size={15} /><span>{label}</span></div>
          ))}
        </div>

        {!guided && (
          <>
            <Button className="connect-bitget-button" asChild>
              <Link href="/onboarding/bitget/connect">Connect Bitget <ArrowRight size={16} /></Link>
            </Button>
            <p className="connection-reassurance">One-time setup. RIKKU reconnects automatically on future sign-ins.</p>
          </>
        )}
      </div>

      {connectionError && <div className="connection-result connection-result-error" role="alert">{connectionError}</div>}

      {guided && (
        <section className="guided-connection" aria-labelledby="guided-connection-title">
          <div className="guided-heading">
            <span><KeyRound size={18} /></span>
            <div>
              <p>ONE-TIME CONNECTION</p>
              <h2 id="guided-connection-title">Connect your existing Bitget account</h2>
            </div>
          </div>
          <p className="connection-limit-note">Bitget Agentic OAuth connects a separate Agentic account and cannot import your main account’s past trades. For historical analysis, RIKKU currently supports a one-time, read-only main-account API connection.</p>
          <ol className="connection-steps">
            <li><span>1</span><p><strong>Create a Bitget API key</strong>Use the API management area for your existing main account.</p></li>
            <li><span>2</span><p><strong>Select read-only permissions</strong>Leave trading, transfers, and withdrawals disabled.</p></li>
            <li><span>3</span><p><strong>Enter it once in RIKKU</strong>RIKKU verifies the permissions before encrypting and storing it.</p></li>
          </ol>
          <div className="google-boundary"><ShieldCheck size={15} /><p>Google only signs you into RIKKU. It is never presented as Bitget authorization.</p></div>

          <button
            className="advanced-toggle"
            type="button"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((value) => !value)}
          >
            <span><strong>Advanced connection</strong><small>Use your secure read-only API credentials</small></span>
            <ChevronDown className={advancedOpen ? "advanced-chevron-open" : ""} size={17} />
          </button>

          {advancedOpen && (
            <form className="bitget-form" onSubmit={verify} noValidate>
              <div className="advanced-warning"><LockKeyhole size={14} /><span>Never enter your normal Bitget password. These are API credentials only.</span></div>
              <label htmlFor="bitget-api-key">API key</label>
              <Input id="bitget-api-key" name="apiKey" autoComplete="off" required aria-invalid={Boolean(fieldErrors.apiKey)} aria-describedby={fieldErrors.apiKey ? "bitget-api-key-error" : undefined} onChange={() => clearFieldError("apiKey")} />
              {fieldErrors.apiKey && <p id="bitget-api-key-error" className="field-error">{fieldErrors.apiKey}</p>}
              <label htmlFor="bitget-api-secret">API secret</label>
              <Input id="bitget-api-secret" name="apiSecret" type="password" autoComplete="off" required aria-invalid={Boolean(fieldErrors.apiSecret)} aria-describedby={fieldErrors.apiSecret ? "bitget-api-secret-error" : undefined} onChange={() => clearFieldError("apiSecret")} />
              {fieldErrors.apiSecret && <p id="bitget-api-secret-error" className="field-error">{fieldErrors.apiSecret}</p>}
              <label htmlFor="bitget-passphrase">API passphrase</label>
              <Input id="bitget-passphrase" name="passphrase" type="password" autoComplete="off" required aria-invalid={Boolean(fieldErrors.passphrase)} aria-describedby={fieldErrors.passphrase ? "bitget-passphrase-error" : undefined} onChange={() => clearFieldError("passphrase")} />
              {fieldErrors.passphrase && <p id="bitget-passphrase-error" className="field-error">{fieldErrors.passphrase}</p>}

              <Button className="w-full" type="submit" disabled={status === "checking"}>
                {status === "checking" ? <><LoaderCircle className="spin" size={15} /> Verifying and encrypting…</> : "Complete secure connection"}
              </Button>

              {status !== "idle" && (
                <div className={`connection-result connection-result-${status}`} role="status">
                  {status === "verified" && <CheckCircle2 size={16} />}
                  <span>{message}</span>
                </div>
              )}
              <p className="connection-footnote">Credentials are sent only to the RIKKU server, verified as read-only, encrypted, and never returned to the browser.</p>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
