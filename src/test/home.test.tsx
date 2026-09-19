import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HomeDashboard } from "@/components/home-dashboard";
import { PublicLanding } from "@/components/public-landing";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe("RIKKU public landing", () => {
  it("explains RIKKU before asking signed-out visitors to register", () => {
    render(<PublicLanding />);
    expect(screen.getByRole("heading", { name: /RIKKU analyzes.*the market.*and you/i })).toBeDefined();
    expect(screen.getAllByRole("link", { name: /Get Started Free/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Log in" })[0].getAttribute("href")).toBe("/login");
  });

  it("keeps the landing page but changes its CTA for authenticated visitors", () => {
    render(<PublicLanding authenticated />);
    expect(screen.getAllByRole("link", { name: /Ask RIKKU/i })[0].getAttribute("href")).toBe("/ask");
    expect(screen.queryByRole("link", { name: "Log in" })).toBeNull();
  });

  it("shows concepts without fictional user financial data", () => {
    const { container } = render(<PublicLanding />);
    expect(screen.getByText("Your trading history should teach you something.")).toBeDefined();
    expect(screen.getByText("15 analytical frameworks working underneath RIKKU")).toBeDefined();
    expect(container.textContent).not.toContain("$48,260");
    expect(container.textContent).not.toContain("+$3,184");
    expect(container.textContent).not.toContain("84 trades");
  });
});

describe("RIKKU authenticated home", () => {
  it("uses an honest empty state before real data is imported", () => {
    const { container } = render(<HomeDashboard />);
    expect(screen.getByText("NO TRADING DATA YET")).toBeDefined();
    expect(screen.getByText("Connect your history to begin.")).toBeDefined();
    expect(container.textContent).not.toContain("DEMO DATA");
    expect(container.textContent).not.toContain("$48,260");
  });

  it("shows only imported Bitget counts after a completed import and allows a resync", () => {
    render(<HomeDashboard importedActivity={{
      orders: 12, fills: 12, financialRecords: 43, instruments: 5, marketCandles: 435, completedTrades: 0,
      earliestRecordAt: "2026-07-08T06:26:10.790Z", latestRecordAt: "2026-08-04T01:02:55.542Z", lastSyncedAt: "2026-09-18T00:00:00.000Z",
    }} />);
    expect(screen.getByText("Your Bitget data is connected.")).toBeDefined();
    expect(screen.getByText("Jul 8 – Aug 4, 2026 coverage. Values below are imported record counts, not estimates.")).toBeDefined();
    expect(screen.getByText("Not yet reconstructable")).toBeDefined();
    expect(screen.getByRole("link", { name: /Analyze my activity/i }).getAttribute("href")).toBe("/ask?prompt=Analyze%20my%20imported%20Bitget%20activity");
    expect(screen.getByRole("button", { name: /Resync Bitget/i })).toBeDefined();
  });

  it("surfaces a validated analysis without inventing a dashboard finding", () => {
    render(<HomeDashboard importedActivity={{
      orders: 12, fills: 12, financialRecords: 43, instruments: 5, marketCandles: 435, completedTrades: 0,
      earliestRecordAt: "2026-07-08T06:26:10.790Z", latestRecordAt: "2026-08-04T01:02:55.542Z", lastSyncedAt: "2026-09-18T00:00:00.000Z",
    }} latestFinding={{
      headline: "Imported Bitget activity is available for descriptive analysis.",
      summary: "RIKKU calculated only metrics supported by the current import.",
      confidence: "low",
      createdAt: "2026-09-18T00:00:00.000Z",
    }} />);

    expect(screen.getByLabelText("Latest validated RIKKU finding").textContent).toContain("LOW");
    expect(screen.getByText("Imported Bitget activity is available for descriptive analysis.")).toBeDefined();
    expect(screen.getByRole("link", { name: /Ask RIKKU about this analysis/i }).getAttribute("href")).toContain("/ask?prompt=");
  });

  it("uses an explicit unavailable state instead of pretending that a failed workspace read is an empty account", () => {
    render(<HomeDashboard workspaceUnavailable />);
    expect(screen.getByText("RIKKU could not read your import status safely.")).toBeDefined();
    expect(screen.queryByText("Connect your history to begin.")).toBeNull();
  });
});
