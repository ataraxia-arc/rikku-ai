import { NextResponse } from "next/server";
import { withSafeRequestLog } from "@/lib/security/safe-request-log";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient, importWorkerConfigured } from "@/lib/supabase/service";

export const runtime = "nodejs";

function nonnegativeCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeCoverageDate(value: unknown) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return withSafeRequestLog("import.status", async () => {
    if (!isSupabaseConfigured()) return NextResponse.json({ ok: false, code: "SUPABASE_NOT_CONFIGURED" }, { status: 503 });
    const { id } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return NextResponse.json({ ok: false, code: "INVALID_IMPORT_JOB_ID" }, { status: 400 });
    }

    try {
      const supabase = await createSupabaseServerClient();
      const { data: auth, error: authError } = await supabase.auth.getUser();
      if (authError || !auth.user) return NextResponse.json({ ok: false, code: "AUTH_REQUIRED" }, { status: 401 });

      const { data, error } = await supabase.from("import_jobs")
        .select("id,status,current_stage,progress,safe_error_code,connection_id")
        .eq("id", id)
        .eq("user_id", auth.user.id)
        .eq("job_type", "bitget_initial")
        .maybeSingle();
      if (error) return NextResponse.json({ ok: false, code: "IMPORT_STATUS_UNAVAILABLE" }, { status: 503 });
      if (!data) return NextResponse.json({ ok: false, code: "IMPORT_JOB_NOT_FOUND" }, { status: 404 });

      const progress = data.progress && typeof data.progress === "object" && !Array.isArray(data.progress)
        ? data.progress as Record<string, unknown>
        : {};
      // Import completion is the only state that advances onboarding. This is
      // idempotent so a refreshed completion page is safe, including jobs that
      // completed before the application was upgraded.
      if (data.status === "completed" && importWorkerConfigured()) {
        try {
          await createSupabaseServiceClient()
            .from("users")
            .update({ onboarding_state: "complete", updated_at: new Date().toISOString() })
            .eq("id", auth.user.id);
        } catch {
          // The import itself remains completed even if this convenience state
          // update is temporarily unavailable. Routing also checks real jobs.
        }
      }
      return NextResponse.json({
        ok: true,
        job: {
          id: data.id,
          status: data.status,
          stage: data.current_stage,
          counts: {
            orders: nonnegativeCount(progress.ordersImported),
            fills: nonnegativeCount(progress.fillsImported),
            trades: nonnegativeCount(progress.tradesReconstructed),
            fees: nonnegativeCount(progress.financialRecordsImported),
            assets: nonnegativeCount(progress.assetsImported),
            positions: nonnegativeCount(progress.positionsImported),
            instruments: nonnegativeCount(progress.instrumentsImported),
            marketCandles: nonnegativeCount(progress.marketSnapshotsImported),
          },
          coverage: {
            earliest: safeCoverageDate(progress.earliestRecordAt),
            latest: safeCoverageDate(progress.latestRecordAt),
          },
          analysis: {
            status: progress.analysisStatus === "completed" || progress.analysisStatus === "insufficient_data"
              ? progress.analysisStatus : null,
            sampleSize: nonnegativeCount(progress.analysisSampleSize),
          },
          errorCode: data.safe_error_code,
          errorStage: data.status === "failed" ? data.current_stage : null,
        },
      }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return NextResponse.json({ ok: false, code: "IMPORT_STATUS_UNAVAILABLE" }, { status: 503 });
    }
  });
}
