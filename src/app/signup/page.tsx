import { AuthPanel } from "@/components/auth-panel";

export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  const params = await searchParams;
  const message = params["check-email"] === "true" ? "Check your email to confirm your RIKKU account." : params.error ? "The account could not be created. Check the fields and try again." : undefined;
  return <AuthPanel mode="signup" message={message} />;
}
