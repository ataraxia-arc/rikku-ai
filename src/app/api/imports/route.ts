import { after, NextResponse } from "next/server";
import { runBitgetImportJob } from "@/lib/bitget/import-runner";
import { withSafeRequestLog } from "@/lib/security/safe-request-log";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { importWorkerConfigured } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 300;

function errorResponse(status: number, code: string) {
  return NextResponse.json({ ok: false, code }, { status });
}

export async function POST() {
  return withSafeRequestLog("import.start", async (requestId) => {
    if (!isSupabaseConfigured()) return errorResponse(503, "SUPABASE_NOT_CONFIGURED");

    let supabase;
    let user;
    try {
      supabase = await createSupabaseServerClient();
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user) return errorResponse(401, "AUTH_REQUIRED");
      user = data.user;
    } catch {
      return errorResponse(503, "AUTH_UNAVAILABLE");
    }

    const { data: connectionData, error: connectionError } = await supabase.rpc("get_verified_bitget_connection_status");
    if (connectionError?.code === "PGRST202") return errorResponse(503, "IMPORT_SCHEMA_NOT_APPLIED");
    if (connectionError) return errorResponse(503, "CONNECTION_LOOKUP_FAILED");
    const connection = Array.isArray(connectionData) ? connectionData[0] : connectionData;
    if (!connection?.verified || !connection.connection_id) return errorResponse(409, "VERIFIED_CONNECTION_REQUIRED");
    if (!importWorkerConfigured()) return errorResponse(503, "IMPORT_WORKER_NOT_CONFIGURED");

    const { data: jobData, error: jobError } = await supabase.rpc("start_or_resume_bitget_import");
    if (jobError) return errorResponse(503, "IMPORT_JOB_CREATE_FAILED");
    const job = Array.isArray(jobData) ? jobData[0] : jobData;
    if (!job?.job_id || job.connection_id !== connection.connection_id) {
      return errorResponse(503, "IMPORT_JOB_CREATE_FAILED");
    }

    const jobId: string = job.job_id;
    const connectionId: string = job.connection_id;
    const userId: string = user.id;
    after(async () => {
      try {
        await runBitgetImportJob({ jobId, connectionId, userId, requestId });
      } catch {
        // The worker records its own safe failure stage. Never log thrown data.
        console.warn(JSON.stringify({ event: "rikku.import.worker_unhandled", requestId, jobId }));
      }
    });

    return NextResponse.json({ ok: true, importJobId: jobId }, { status: 202 });
  });
}
