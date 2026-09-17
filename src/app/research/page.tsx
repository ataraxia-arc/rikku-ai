import { FeaturePage } from "@/components/feature-page";

export default function ResearchPage() {
  return <FeaturePage active="Research" eyebrow="SOURCE-AWARE RESEARCH" title="Research" description="Market evidence connected to your open questions and theses, with source quality kept visible." emptyTitle="Research begins with a real question." emptyDescription="Connected data will let RIKKU relate market evidence to your positions, decisions, and tracked theses without fabricating context." sideTitle="Research discipline" sideItems={["Prefer primary sources and exact publication time.", "Separate reported facts from interpretation.", "Link each thesis change to its evidence."]} />;
}
