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
            counts: { orders: 12, fills: 9, trades: 4, fees: 3, assets: 2, positions: 0 },
            coverage: { earliest: "2026-06-01T00:00:00.000Z", latest: "2026-09-01T00:00:00.000Z" },
            errorCode: null,
            errorStage: null,
          },
        },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<BitgetImportStatus jobId="synthetic-job-id" />);

    expect(await screen.findByText("Real-data import completed")).toBeDefined();
    expect(screen.getByText("12")).toBeDefined();
    expect(screen.getByText("9")).toBeDefined();
    expect(screen.getByText("4")).toBeDefined();
    expect(screen.getByText(/Jun 1, 2026/)).toBeDefined();
    expect(screen.getByText(/Sep 1, 2026/)).toBeDefined();
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
