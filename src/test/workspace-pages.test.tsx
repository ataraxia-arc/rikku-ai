import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { pushMock, refreshMock, reader } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
  reader: {
    readPortfolioData: vi.fn(),
    readPatternData: vi.fn(),
    readMemoryData: vi.fn(),
    readResearchData: vi.fn(),
    readRiskData: vi.fn(),
    readPlaybookData: vi.fn(),
    readSettingsData: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock, refresh: refreshMock }) }));
vi.mock("@/lib/workspace/read-workspace-data", () => reader);
vi.mock("@/app/settings/actions", () => ({ signOut: vi.fn() }));

import PortfolioPage from "@/app/portfolio/page";
import PatternsPage from "@/app/patterns/page";
import SettingsPage from "@/app/settings/page";
import { DisconnectBitgetButton } from "@/components/disconnect-bitget-button";
import { MemoryExplorer } from "@/components/memory-explorer";

const connection = {
  configured: true,
  authenticated: true,
  connectionReadable: true,
  importReadable: true,
  connected: true,
  verifiedAt: "2026-08-04T01:02:55.542Z",
  lastSyncedAt: "2026-08-04T01:02:55.542Z",
  latestImport: {
    orders: 12,
    fills: 12,
    financialRecords: 43,
    instruments: 5,
    marketCandles: 435,
    completedTrades: 0,
    assets: 0,
    positions: 0,
    earliestRecordAt: "2026-07-08T06:26:10.790Z",
    latestRecordAt: "2026-08-04T01:02:55.542Z",
    completedAt: "2026-08-04T01:02:55.542Z",
  },
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("evidence-backed workspace pages", () => {
  it("uses the exact honest empty portfolio state and routes the next action to Ask RIKKU", async () => {
    reader.readPortfolioData.mockResolvedValue({ connection, readable: true, assets: [], positions: [] });
    const { container } = render(await PortfolioPage());

    expect(screen.getByText("No current assets were returned by the connected Bitget account.")).toBeDefined();
    expect(screen.getByRole("link", { name: /Ask RIKKU about available data/i }).getAttribute("href")).toContain("/ask?prompt=");
    expect(container.textContent).not.toContain("$48,260");
  });

  it("does not invent a pattern when the stored pattern list is empty", async () => {
    reader.readPatternData.mockResolvedValue({ connection, readable: true, patterns: [] });
    render(await PatternsPage());

    expect(screen.getByText("RIKKU has not collected enough evidence to establish a reliable pattern yet.")).toBeDefined();
    expect(screen.getByRole("link", { name: /Ask RIKKU to investigate/i }).getAttribute("href")).toContain("/ask?prompt=");
  });

  it("filters evidence-linked memories and carries selected evidence into Ask RIKKU", () => {
    render(<MemoryExplorer memories={[
      {
        id: "memory-1", type: "trade", statement: "Twelve imported fills are present.", classification: "fact", confidence: "low", status: "active", createdAt: "2026-08-04T01:02:55.542Z",
        evidence: [{ direction: "supporting", source: "Bitget fills", observedAt: "2026-08-04T01:02:55.542Z" }],
      },
      {
        id: "memory-2", type: "thesis", statement: "A stored thesis exists.", classification: "hypothesis", confidence: "low", status: "candidate", createdAt: "2026-08-04T01:02:55.542Z",
        evidence: [],
      },
    ]} />);

    fireEvent.click(screen.getByRole("button", { name: "Trades" }));
    expect(screen.getByText("Twelve imported fills are present.")).toBeDefined();
    expect(screen.queryByText("A stored thesis exists.")).toBeNull();
    expect(screen.getByRole("link", { name: /Ask RIKKU using this memory/i }).getAttribute("href")).toContain("Use+this+RIKKU+memory");
  });

  it("offers real connection controls in Settings and sends a safe disconnect request", async () => {
    reader.readSettingsData.mockResolvedValue({
      connection,
      readable: true,
      profile: { displayName: "RIKKU User", timezone: "UTC", baseCurrency: "USD" },
    });
    render(await SettingsPage());
    expect(screen.getByRole("button", { name: /Resync Bitget/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Disconnect Bitget/i })).toBeDefined();

    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    render(<DisconnectBitgetButton />);
    fireEvent.click(screen.getAllByRole("button", { name: /Disconnect Bitget/i })[1]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bitget/verify", { method: "DELETE" }));
    expect(confirmMock).toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith("/onboarding/bitget");
    expect(refreshMock).toHaveBeenCalled();
  });
});
