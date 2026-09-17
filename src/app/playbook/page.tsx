import { FeaturePage } from "@/components/feature-page";

export default function PlaybookPage() {
  return <FeaturePage active="Playbook" eyebrow="MY RIKKU PLAYBOOK" title="Playbook" description="Evidence-backed IF→THEN rules built from your own trading history." emptyTitle="Your playbook starts empty on purpose." emptyDescription="Personal rules will appear only after RIKKU can assess conditions, outcomes, and counter-evidence from your own decisions." sideTitle="Rule quality" sideItems={["Conditions must be objectively assessable.", "Compare performance when a rule is followed and violated.", "Retire rules when their evidence no longer holds."]} />;
}
