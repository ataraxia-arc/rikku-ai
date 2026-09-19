"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";

export function DisconnectBitgetButton() {
  const router = useRouter();
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState("");

  async function disconnect() {
    if (!window.confirm("Disconnect Bitget from RIKKU? Automatic syncing will stop.")) return;
    setDisconnecting(true);
    setError("");
    try {
      const response = await fetch("/api/bitget/verify", { method: "DELETE" });
      if (!response.ok) {
        setError("RIKKU could not disconnect Bitget. Please try again.");
        return;
      }
      router.push("/onboarding/bitget");
      router.refresh();
    } catch {
      setError("RIKKU could not disconnect Bitget. Please try again.");
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div>
      <Button type="button" variant="ghost" onClick={disconnect} disabled={disconnecting}>
        {disconnecting ? <LoaderCircle className="spin" size={15} /> : <Unplug size={15} />} Disconnect Bitget
      </Button>
      {error && <p className="connection-result connection-result-error" role="alert">{error}</p>}
    </div>
  );
}
