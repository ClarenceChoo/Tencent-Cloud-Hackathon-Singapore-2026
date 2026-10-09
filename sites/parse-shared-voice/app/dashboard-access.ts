export type DashboardIdentity = { userId: string; email: string };
export type DashboardAccessBindings = { DASHBOARD_ALLOWED_EMAILS?: string };

export function dashboardAccess(
  user: DashboardIdentity | null,
  bindings: DashboardAccessBindings,
): "allowed" | "anonymous" | "denied" {
  if (!user?.userId || !user.email) return "anonymous";
  const allowed = (bindings.DASHBOARD_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(user.email.trim().toLowerCase()) ? "allowed" : "denied";
}
