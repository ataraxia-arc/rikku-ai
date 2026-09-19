import { FeatureEmptyState, FeaturePage } from "@/components/feature-page";
import { MemoryExplorer } from "@/components/memory-explorer";
import { formatRecordCount } from "@/lib/workspace/presentation";
import { readMemoryData } from "@/lib/workspace/read-workspace-data";

export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  const { connection, readable, memories } = await readMemoryData();
  const connectionStatus = connection.connected ? connection.lastSyncedAt ?? connection.verifiedAt : null;
  const sourceStatus = !readable
    ? "Memory data unavailable"
    : `${formatRecordCount(memories.length)} evidence-linked memories`;

  return (
    <FeaturePage
      active="Memory"
      eyebrow="PERSISTENT DECISION MEMORY"
      title="Memory"
      description="Evidence-linked memories saved by RIKKU. Conversation messages are not treated as validated memory unless an evidence-backed record exists."
      connectionStatus={connectionStatus}
      sideTitle="Memory principles"
      sideItems={["Memory keeps its evidence and confidence visible.", "Behavioral claims need more than a small fill sample.", "A memory can be weakened or retired as evidence changes."]}
      sourceStatus={sourceStatus}
      sourceDescription="The explorer never creates a memory merely to populate this page."
    >
      {!readable ? (
        <FeatureEmptyState
          title="RIKKU could not read saved memories safely."
          description="No memory was changed. Ask RIKKU to review the current evidence once the workspace is available."
          actionHref="/ask?prompt=What%20does%20RIKKU%20currently%20remember%20about%20my%20trading%20activity"
          actionLabel="Ask RIKKU"
        />
      ) : memories.length === 0 ? (
        <FeatureEmptyState
          title="No evidence-linked memories exist yet."
          description="Imported activity can support factual memories, but RIKKU will not create behavioral or performance claims until the required evidence exists."
          actionHref="/ask?prompt=What%20facts%20can%20RIKKU%20safely%20remember%20from%20my%20imported%20Bitget%20activity"
          actionLabel="Ask RIKKU about available memory"
        />
      ) : <MemoryExplorer memories={memories} />}
    </FeaturePage>
  );
}
