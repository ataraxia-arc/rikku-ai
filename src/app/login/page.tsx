import { AuthPanel } from "@/components/auth-panel";
import { safeNextPath } from "@/lib/auth/safe-next-path";

const messages: Record<string, string> = {
  "invalid-fields": "Enter a valid email and a password of at least 8 characters.",
  credentials: "The email or password was not accepted.",
  google: "Google sign-in could not be started. Please try again.",
  callback: "The sign-in link could not be verified. Please try again.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const message = params.setup === "required" ? "Authentication is ready for setup. Connect a Supabase project to enable sign-in." : typeof params.error === "string" ? messages[params.error] : undefined;
  return <AuthPanel mode="login" message={message} next={safeNextPath(params.next)} />;
}
