import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HomeDashboard } from "@/components/home-dashboard";
import { PublicLanding } from "@/components/public-landing";

describe("RIKKU public landing", () => {
  it("explains RIKKU before asking signed-out visitors to register", () => {
    render(<PublicLanding />);
    expect(screen.getByRole("heading", { name: /RIKKU analyzes.*the market.*and you/i })).toBeDefined();
    expect(screen.getAllByRole("link", { name: /Get Started Free/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Log in" })[0].getAttribute("href")).toBe("/login");
  });

  it("keeps the landing page but changes its CTA for authenticated visitors", () => {
    render(<PublicLanding authenticated />);
    expect(screen.getAllByRole("link", { name: /Open App/i })[0].getAttribute("href")).toBe("/home");
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
});
