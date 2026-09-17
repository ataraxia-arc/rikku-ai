import { FeaturePage } from "@/components/feature-page";

export default function RiskPage() {
  return <FeaturePage active="Risk" eyebrow="DOWNSIDE INTELLIGENCE" title="Risk" description="Loss size, clusters, concentration, and tail conditions grounded in your own account history." emptyTitle="Risk estimates need your positions and outcomes." emptyDescription="RIKKU will not present drawdowns, expected shortfall, or alerts until those values can be calculated from imported evidence." sideTitle="Risk review" sideItems={["Compare proposed size with normal exposure.", "Check correlated downside, not just position count.", "Treat historical tail estimates as uncertain."]} />;
}
