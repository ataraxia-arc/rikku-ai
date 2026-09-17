import { describe, expect, it } from "vitest";
import { decideRouteAccess } from "@/lib/auth/route-access";

describe("route access", () => {
  it("keeps the public homepage visible for signed-out and authenticated visitors", () => {
    expect(decideRouteAccess("/", false)).toBe("allow");
    expect(decideRouteAccess("/", true)).toBe("allow");
  });

  it("protects the application and onboarding routes", () => {
    for (const path of ["/home", "/ask", "/portfolio", "/memory", "/patterns", "/research", "/risk", "/playbook", "/settings", "/onboarding"]) {
      expect(decideRouteAccess(path, false)).toBe("redirect-login");
      expect(decideRouteAccess(path, true)).toBe("allow");
    }
  });

  it("sends authenticated visitors away from auth forms", () => {
    expect(decideRouteAccess("/login", true)).toBe("redirect-home");
    expect(decideRouteAccess("/signup", true)).toBe("redirect-home");
  });
});
