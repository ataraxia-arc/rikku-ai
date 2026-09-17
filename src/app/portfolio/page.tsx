import { FeaturePage } from "@/components/feature-page";

export default function PortfolioPage() {
  return <FeaturePage active="Portfolio" eyebrow="PORTFOLIO INTELLIGENCE" title="Portfolio" description="Allocation, concentration, and contribution measured against the risk you actually took." emptyTitle="Your portfolio view will begin with real balances." emptyDescription="Connect Bitget to import supported balances and positions. Until then, RIKKU will not invent portfolio values or exposures." sideTitle="What will appear" sideItems={["Account balances and supported positions.", "Allocation and concentration derived from holdings.", "Coverage dates and source timestamps."]} />;
}
