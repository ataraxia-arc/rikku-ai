import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BitgetImportStatus } from "@/components/bitget-import-status";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

describe("Bitget import status", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    pushMock.mockReset();
  });

  it("recognizes an existing verified connection when no job is selected", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, connected: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<BitgetImportStatus jobId={null} />);

    expect(await screen.findByText("Ready to import real Bitget data")).toBeDefined();
    expect(screen.getByText("Bitget connection verified")).toBeDefined();
    expect(screen.getByRole("button", { name: /start import/i })).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/bitget/verify", { cache: "no-store" });
  });

  it("shows only server-reported progress, counts and coverage", async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve({
      ok: true,
      json: async () => url === "/api/bitget/verify"
        ? { ok: true, connected: true }
        : {
          ok: true,
          job: {
            id: "synthetic-job-id",
            status: "completed",
            stage: "completed",
            counts: { orders: 12, fills: 12, trades: 0, fees: 43, assets: 0, positions: 0, instruments: 5, marketCandles: 435 },
            coverage: { earliest: "2026-07-08T06:26:10.790Z", latest: "2026-08-04T01:02:55.542Z" },
            errorCode: null,
            errorStage: null,
          },
        },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<BitgetImportStatus jobId="synthetic-job-id" />);

    expect(await screen.findByText("Your Bitget data is connected.")).toBeDefined();
    expect(screen.getAllByText("12")).toHaveLength(2);
    expect(screen.getByText("43")).toBeDefined();
    expect(screen.getByText("435")).toBeDefined();
    expect(screen.getByText("Jul 8 – Aug 4, 2026")).toBeDefined();
    expect(screen.getByText("Completed trades: not yet reconstructable.")).toBeDefined();
    expect(screen.getByRole("link", { name: "Continue to RIKKU" }).getAttribute("href")).toBe("/home");
    expect(screen.getByRole("link", { name: "Analyze my activity" }).getAttribute("href")).toBe("/ask?prompt=Analyze%20my%20imported%20Bitget%20activity");
    expect(fetchMock).toHaveBeenCalledWith("/api/imports/synthetic-job-id", { cache: "no-store" });
  });

  it("shows a specific failed stage without fabricated counts or coverage", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve({
      ok: true,
      json: async () => url === "/api/bitget/verify"
        ? { ok: true, connected: true }
        : {
          ok: true,
          job: {
            id: "synthetic-job-id",
            status: "failed",
            stage: "importing_fills",
            counts: { orders: 1 },
            coverage: { earliest: null, latest: null },
            errorCode: "BITGET_FILLS_UNAVAILABLE",
            errorStage: "importing_fills",
          },
        },
    })));
    render(<BitgetImportStatus jobId="synthetic-job-id" />);

    expect(await screen.findByText("Import needs attention")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain("Import stopped during importing fills (BITGET_FILLS_UNAVAILABLE)");
    expect(screen.getAllByText("Not reported").length).toBeGreaterThan(1);
  });
});
