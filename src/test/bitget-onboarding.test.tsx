import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BitgetConnectForm } from "@/components/bitget-connect-form";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

describe("Bitget onboarding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    pushMock.mockReset();
  });

  function openCredentialForm() {
    fireEvent.click(screen.getByRole("button", { name: /advanced connection/i }));
    return screen.getByRole("button", { name: "Complete secure connection" });
  }

  it("shows inline errors for all empty fields, focuses the first, and sends no POST", () => {
    const fetchMock = vi.fn(() => new Promise(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    render(<BitgetConnectForm guided />);
    const submit = openCredentialForm();

    fireEvent.click(submit);
    expect(screen.getByText("Complete all required Bitget API fields.")).toBeDefined();
    expect(screen.getByText("API key is required.")).toBeDefined();
    expect(screen.getByText("API secret is required.")).toBeDefined();
    expect(screen.getByText("API passphrase is required.")).toBeDefined();
    expect(document.activeElement).toBe(screen.getByLabelText("API key"));
    expect(fetchMock).toHaveBeenCalledTimes(1); // Connection-status GET only.
  });

  it("focuses the first missing field without sending credentials", () => {
    const fetchMock = vi.fn(() => new Promise(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    render(<BitgetConnectForm guided />);
    const submit = openCredentialForm();
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "test-api-key" } });
    fireEvent.change(screen.getByLabelText("API passphrase"), { target: { value: "test-passphrase" } });

    fireEvent.click(submit);
    expect(screen.getByText("API secret is required.")).toBeDefined();
    expect(document.activeElement).toBe(screen.getByLabelText("API secret"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports malformed fields inline without a POST", () => {
    const fetchMock = vi.fn(() => new Promise(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    render(<BitgetConnectForm guided />);
    const submit = openCredentialForm();
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("API secret"), { target: { value: "test-secret-key" } });
    fireEvent.change(screen.getByLabelText("API passphrase"), { target: { value: "test-passphrase" } });

    fireEvent.click(submit);
    expect(screen.getByText("Enter a valid API key.")).toBeDefined();
    expect(document.activeElement).toBe(screen.getByLabelText("API key"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["UPSTREAM_REJECTED", "Bitget rejected these credentials. Check the API key, secret, and passphrase."],
    ["BITGET_INVALID_API_KEY", "Bitget rejected the API key."],
    ["BITGET_SIGNATURE_ERROR", "Bitget rejected the request signature. RIKKU's signing or secret may be incorrect."],
    ["BITGET_TIMESTAMP_EXPIRED", "Bitget rejected the request timestamp. Check system clock synchronization."],
    ["AUTH_REQUIRED", "Your RIKKU session expired. Sign in again."],
    ["UPSTREAM_UNAVAILABLE", "RIKKU could not reach Bitget. Try again shortly."],
    ["READ_WRITE_KEY", "This API key is not read-only. Create a read-only key."],
    ["UNVERIFIABLE_PERMISSION_MODE", "RIKKU cannot verify that Bitget marked this API key read-only. Nothing was stored."],
    ["MISSING_REQUIRED_PERMISSIONS", "This key lacks the Bitget account and trade-history read permissions RIKKU needs. Nothing was stored."],
  ])("shows the correct message for %s", async (code, expected) => {
    const fetchMock = vi.fn((_url: string, options?: RequestInit) => {
      if (options?.method === "POST") return Promise.resolve({ json: async () => ({ ok: false, code }) });
      return new Promise(() => undefined);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<BitgetConnectForm guided />);
    const submit = openCredentialForm();
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "test-api-key" } });
    fireEvent.change(screen.getByLabelText("API secret"), { target: { value: "test-secret-key" } });
    fireEvent.change(screen.getByLabelText("API passphrase"), { target: { value: "test-passphrase" } });

    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText(expected)).toBeDefined());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("keeps API credentials out of the primary connection experience", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    render(<BitgetConnectForm />);

    const connectLink = screen.getByRole("link", { name: /connect bitget/i });
    expect(connectLink.getAttribute("href")).toBe("/onboarding/bitget/connect");
    expect(connectLink.getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByText("Read-only")).toBeDefined();
    expect(screen.getByText("Encrypted")).toBeDefined();
    expect(screen.getByText("Cannot trade, transfer, or withdraw")).toBeDefined();
    expect(screen.getByText("Disconnect anytime")).toBeDefined();
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  it("starts the guided workflow on the destination route and keeps credentials advanced", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    render(<BitgetConnectForm guided />);

    expect(screen.getByText("Connect your existing Bitget account")).toBeDefined();
    expect(screen.getByText(/Agentic OAuth connects a separate Agentic account/)).toBeDefined();
    expect(screen.getByText(/Google only signs you into RIKKU/)).toBeDefined();
    expect(screen.queryByLabelText("API key")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /advanced connection/i }));
    expect(screen.getByLabelText("API key")).toBeDefined();
    expect(screen.getByLabelText("API secret")).toBeDefined();
    expect(screen.getByLabelText("API passphrase")).toBeDefined();
  });

  it("shows a clear API configuration failure instead of silently ignoring it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({ ok: false, code: "SECURE_STORAGE_UNAVAILABLE" }),
    }));
    render(<BitgetConnectForm guided />);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Encrypted connection storage is not configured");
    });
  });

  it("starts one import job from a stored connection, then navigates with its ID", async () => {
    let completePost: ((response: unknown) => void) | undefined;
    const fetchMock = vi.fn((_url: string, options?: RequestInit) => options?.method === "POST"
      ? new Promise((resolve) => { completePost = resolve; })
      : Promise.resolve({ ok: true, json: async () => ({ ok: true, connected: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<BitgetConnectForm guided />);

    const start = await screen.findByRole("button", { name: /continue to import/i });
    fireEvent.click(start);
    fireEvent.click(start);
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(start.hasAttribute("disabled")).toBe(true);

    completePost?.({ ok: true, json: async () => ({ ok: true, importJobId: "synthetic-job-id" }) });
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/onboarding/import?job=synthetic-job-id"));
  });

  it("shows an actionable import-start failure without navigating", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, options?: RequestInit) => options?.method === "POST"
      ? Promise.resolve({ ok: false, status: 409, json: async () => ({ ok: false, code: "CONNECTION_NOT_VERIFIED" }) })
      : Promise.resolve({ ok: true, json: async () => ({ ok: true, connected: true }) })));
    render(<BitgetConnectForm guided />);

    fireEvent.click(await screen.findByRole("button", { name: /continue to import/i }));
    expect(await screen.findByText("Your Bitget connection is not verified. Return to the connection page.")).toBeDefined();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("names the unapplied import migration without implying the Bitget key failed", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, options?: RequestInit) => options?.method === "POST"
      ? Promise.resolve({ ok: false, status: 503, json: async () => ({ ok: false, code: "IMPORT_SCHEMA_NOT_APPLIED" }) })
      : Promise.resolve({ ok: true, json: async () => ({ ok: true, connected: true }) })));
    render(<BitgetConnectForm guided />);

    fireEvent.click(await screen.findByRole("button", { name: /continue to import/i }));
    expect(await screen.findByText(/import database setup has not been applied yet/)).toBeDefined();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
