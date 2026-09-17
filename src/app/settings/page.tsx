import { FeaturePage } from "@/components/feature-page";

export default function SettingsPage() {
  return <FeaturePage active="Settings" eyebrow="WORKSPACE CONTROLS" title="Settings" description="Manage connections, evidence preferences, privacy, and account controls." emptyTitle="Complete your connection to configure data controls." emptyDescription="Connection status, synchronization controls, and data coverage will appear here after your Bitget account is securely linked." sideTitle="Account safety" sideItems={["Use a Bitget API key created as read-only.", "Never enter your normal exchange password.", "Disconnect and rotate a key if exposure is suspected."]} />;
}
