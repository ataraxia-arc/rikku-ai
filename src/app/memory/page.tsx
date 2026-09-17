import { FeaturePage } from "@/components/feature-page";

export default function MemoryPage() {
  return <FeaturePage active="Memory" eyebrow="PERSISTENT DECISION MEMORY" title="Memory" description="The decisions, contexts, outcomes, and lessons that remain relevant to your next review." emptyTitle="Memory grows from evidence, not examples." emptyDescription="Once your history is imported, RIKKU can connect decisions and outcomes into memories that remain traceable to their source." sideTitle="Memory principles" sideItems={["Save lessons with durable future value.", "Keep evidence and counter-evidence together.", "Weaken or retire memories when conditions change."]} />;
}
