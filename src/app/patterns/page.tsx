import { FeaturePage } from "@/components/feature-page";

export default function PatternsPage() {
  return <FeaturePage active="Patterns" eyebrow="BEHAVIORAL PATTERN VALIDATION" title="Patterns" description="Repeated behavior separated from coincidence with stability and counter-evidence checks." emptyTitle="Patterns require repeated observations." emptyDescription="RIKKU will wait for enough authenticated trading history before proposing patterns, confidence, or behavioral findings." sideTitle="Skeptic checks" sideItems={["Is the sample large enough to matter?", "Does the effect survive different regimes?", "Could repeated testing explain the result?"]} />;
}
