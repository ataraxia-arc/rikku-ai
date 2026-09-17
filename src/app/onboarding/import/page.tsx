import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { BitgetImportStatus } from "@/components/bitget-import-status";

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ job?: string | string[] }> }) {
  const params = await searchParams;
  const jobId = typeof params.job === "string" && params.job.length <= 128 ? params.job : null;
  return (
    <main className="onboarding-page">
      <header className="onboarding-header">
        <Link className="brand-lockup" href="/home"><span className="brand-mark">R</span><div><p className="brand-name">RIKKU</p><p className="brand-ai">AI</p></div></Link>
        <Badge>SECURE IMPORT</Badge>
      </header>
      <BitgetImportStatus jobId={jobId} />
    </main>
  );
}
