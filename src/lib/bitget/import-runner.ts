import "server-only";

import { BitgetReadOnlyClient, BitgetGatewayError } from "@/lib/bitget/client";
import { executeBitgetImport, BitgetImportError, type ImportProgress } from "@/lib/bitget/import-executor";
import { createBitgetImportWriter } from "@/lib/bitget/import-writer";
import { getBitgetClockOffset } from "@/lib/bitget/server-clock";
import { bitgetCredentialsSchema } from "@/lib/bitget/types";
import { decryptBitgetCredentials, parseCredentialEncryptionKey } from "@/lib/security/credential-vault-server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

type RunArgs = { jobId: string; connectionId: string; userId: string; requestId: string };

type EncryptedConnection = {
  credential_ciphertext: unknown;
  credential_iv: unknown;
  credential_auth_tag: unknown;
  wrapped_data_key: unknown;
  wrapped_data_key_iv: unknown;
  key_version: number;
  external_uid: string;
};

function byteaToBase64(value: unknown): string {
  if (typeof value !== "string") throw new Error("INVALID_ENCRYPTED_BLOB");
  if (/^\\x(?:[a-f\d]{2})+$/i.test(value)) return Buffer.from(value.slice(2), "hex").toString("base64");
  if (/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value) && value.length > 0) {
    return value;
  }
  throw new Error("INVALID_ENCRYPTED_BLOB");
}

function safeProgress(progress: ImportProgress) {
  return {
    ...progress.counts,
    ...(progress.earliestRecordAt ? { earliestRecordAt: progress.earliestRecordAt } : {}),
    ...(progress.latestRecordAt ? { latestRecordAt: progress.latestRecordAt } : {}),
    ...(progress.analysis ? {
      analysisStatus: progress.analysis.status,
      analysisSampleSize: progress.analysis.sampleSize,
    } : {}),
  };
}

export async function runBitgetImportJob({ jobId, connectionId, userId, requestId }: RunArgs): Promise<void> {
  const startedAt = Date.now();
  // Service-role material and decrypted credentials are never returned, logged,
  // or passed into a client component.
  const supabase = createSupabaseServiceClient();
  const { data: claimData, error: claimError } = await supabase.rpc("claim_bitget_import_job", { p_job_id: jobId });
  if (claimError) {
    console.warn(JSON.stringify({ event: "rikku.import.claim_failed", requestId, jobId, boundary: "IMPORT_JOB_CLAIM" }));
    return;
  }
  const claim = Array.isArray(claimData) ? claimData[0] : claimData;
  if (!claim?.claimed || !claim.lease_token) return;
  const leaseToken: string = claim.lease_token;
  let stage = "connection_verified";
  let lastProgress: ReturnType<typeof safeProgress> = {
    ordersImported: 0, fillsImported: 0, tradesReconstructed: 0, financialRecordsImported: 0,
    assetsImported: 0, positionsImported: 0, instrumentsImported: 0, marketSnapshotsImported: 0,
  };

  async function update(status: "running" | "completed" | "failed", safeErrorCode: string | null = null) {
    const { data, error } = await supabase.rpc("update_bitget_import_job", {
      p_job_id: jobId,
      p_lease_token: leaseToken,
      p_status: status,
      p_current_stage: stage,
      p_progress: lastProgress,
      p_safe_error_code: safeErrorCode,
      p_completed_at: status === "running" ? null : new Date().toISOString(),
    });
    if (error || data !== true) throw new Error("IMPORT_PROGRESS_WRITE_FAILED");
  }

  try {
    stage = "reading_account";
    const { data: connectionData, error: connectionError } = await supabase.rpc("get_bitget_import_connection", {
      p_connection_id: connectionId, p_user_id: userId,
    });
    const connection: EncryptedConnection | undefined = Array.isArray(connectionData) ? connectionData[0] : connectionData;
    if (connectionError || !connection || connection.key_version !== 1 || !connection.external_uid) {
      throw new Error("CONNECTION_LOOKUP_FAILED");
    }

    let credentials;
    try {
      credentials = bitgetCredentialsSchema.parse(decryptBitgetCredentials({
        credentialCiphertext: byteaToBase64(connection.credential_ciphertext),
        credentialIv: byteaToBase64(connection.credential_iv),
        credentialAuthTag: byteaToBase64(connection.credential_auth_tag),
        wrappedDataKey: byteaToBase64(connection.wrapped_data_key),
        wrappedDataKeyIv: byteaToBase64(connection.wrapped_data_key_iv),
        keyVersion: 1,
      }, parseCredentialEncryptionKey()));
    } catch {
      throw new Error("CREDENTIAL_DECRYPTION_FAILED");
    }

    const clockOffset = await getBitgetClockOffset();
    const client = new BitgetReadOnlyClient(credentials, fetch, () => Date.now() + clockOffset);
    const writer = createBitgetImportWriter(supabase, userId, connectionId);
    await executeBitgetImport({
      client,
      writer,
      expectedExternalUid: connection.external_uid,
      onProgress: async (progress) => {
        stage = progress.stage;
        lastProgress = safeProgress(progress);
        const { data, error } = await supabase.rpc("heartbeat_bitget_import_job", {
          p_job_id: jobId, p_lease_token: leaseToken,
        });
        if (error || data !== true) throw new Error("IMPORT_LEASE_LOST");
        await update("running");
      },
    });
    stage = "complete";
    await update("completed");
    const { error: onboardingError } = await supabase
      .from("users")
      .update({ onboarding_state: "complete", updated_at: new Date().toISOString() })
      .eq("id", userId);
    if (onboardingError) {
      console.warn(JSON.stringify({ event: "rikku.import.onboarding_state_update_failed", requestId, jobId }));
    }
    console.info(JSON.stringify({ event: "rikku.import.completed", requestId, jobId, durationMs: Date.now() - startedAt, counts: lastProgress }));
  } catch (error) {
    const safeCode = error instanceof BitgetImportError
      ? error.boundary
      : error instanceof BitgetGatewayError ? "BITGET_CLOCK_SYNC" :
        error instanceof Error && ["CONNECTION_LOOKUP_FAILED", "CREDENTIAL_DECRYPTION_FAILED"].includes(error.message)
          ? error.message : "IMPORT_WORKER_FAILURE";
    if (error instanceof BitgetImportError) stage = error.stage;
    console.warn(JSON.stringify({
      event: "rikku.import.failed", requestId, jobId, boundary: safeCode,
      upstreamCode: error instanceof BitgetImportError ? error.safeCode ?? null : null,
      durationMs: Date.now() - startedAt,
    }));
    try { await update("failed", safeCode); } catch {
      console.warn(JSON.stringify({ event: "rikku.import.failure_status_write_failed", requestId, jobId }));
    }
  }
}
