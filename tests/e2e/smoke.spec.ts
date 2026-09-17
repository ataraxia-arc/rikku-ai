import { expect, test } from "@playwright/test";

test("public landing leads to RIKKU account creation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "RIKKU analyzes the market and you." })).toBeVisible();
  await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Get Started Free" }).first().click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
});

test("login keeps RIKKU and Bitget authentication separate", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByText("Google signs you into RIKKU only. Bitget is connected separately.")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
});

test("Bitget onboarding requires a session and preserves the intended destination", async ({ page }) => {
  await page.goto("/onboarding/bitget");
  await expect(page).toHaveURL(/\/login\?next=%2Fonboarding%2Fbitget$/);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
});

test("Bitget setup route and API fail clearly without a session", async ({ page, request }) => {
  await page.goto("/onboarding/bitget/connect");
  await expect(page).toHaveURL(/\/login\?next=%2Fonboarding%2Fbitget%2Fconnect$/);

  const response = await request.get("/api/bitget/verify");
  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ ok: false, code: "AUTH_REQUIRED" });

  const submitResponse = await request.post("/api/bitget/verify", {
    data: { apiKey: "", apiSecret: "", passphrase: "" },
  });
  expect(submitResponse.status()).toBe(401);
  expect(await submitResponse.json()).toEqual({ ok: false, code: "AUTH_REQUIRED" });
});
