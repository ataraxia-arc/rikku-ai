import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/app-shell";
import { PublicLanding } from "@/components/public-landing";

describe("Ask RIKKU entry points", () => {
  it("sends every authenticated landing Ask RIKKU CTA to the Ask workspace", () => {
    render(<PublicLanding authenticated />);

    const askLinks = screen.getAllByRole("link", { name: /^Ask RIKKU$/i });
    expect(askLinks).toHaveLength(3);
    expect(askLinks.map((link) => link.getAttribute("href"))).toEqual(["/ask", "/ask", "/ask"]);
  });

  it("provides a real settings link instead of a profile-menu dead end", () => {
    render(<AppShell active="Ask RIKKU"><p>Workspace content</p></AppShell>);

    expect(screen.getByRole("link", { name: "Open workspace settings" }).getAttribute("href")).toBe("/settings");
    expect(screen.queryByRole("button", { name: "Open workspace settings" })).toBeNull();
  });
});
