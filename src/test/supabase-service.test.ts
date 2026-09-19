import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({})) }));

import { createClient } from "@supabase/supabase-js";
import { createSupabaseServiceClient, importWorkerConfigured } from "@/lib/supabase/service";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("server-only Supabase credentials", () => {
  it("prefers the new secret key over the legacy service-role key", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "synthetic-secret");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-legacy");
    expect(importWorkerConfigured()).toBe(true);
    createSupabaseServiceClient();
    expect(createClient).toHaveBeenCalledWith("https://example.supabase.co", "synthetic-secret", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  it("supports the legacy key when the new key is absent", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-legacy");
    createSupabaseServiceClient();
    expect(createClient).toHaveBeenCalledWith("https://example.supabase.co", "synthetic-legacy", expect.any(Object));
  });

  it("fails closed without a server key", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(importWorkerConfigured()).toBe(false);
    expect(() => createSupabaseServiceClient()).toThrow("IMPORT_WORKER_NOT_CONFIGURED");
    expect(createClient).not.toHaveBeenCalled();
  });
});
