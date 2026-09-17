const publicPaths = new Set(["/", "/login", "/signup"]);

export type RouteDecision = "allow" | "redirect-login" | "redirect-home";

export function decideRouteAccess(path: string, authenticated: boolean): RouteDecision {
  const publicRoute =
    publicPaths.has(path) ||
    path.startsWith("/auth/") ||
    path.startsWith("/api/");

  if (!authenticated && !publicRoute) return "redirect-login";
  if (authenticated && (path === "/login" || path === "/signup")) return "redirect-home";
  return "allow";
}
