import { Hono } from "hono";
import { accountRoutes } from "./account.js";
import { apiRoutes } from "./api.js";
import { adminRoutes } from "./admin.js";
import { fleetAdminRoutes } from "./fleet-admin.js";
import { authRoutes, requireUser } from "./auth.js";
import { createAuth, handleAuthRequest } from "./better-auth.js";
import { codexAuthRoutes } from "./codexauth.js";
import { githubConfigured, githubRoutes } from "./github.js";
import { requestBodyLimit } from "./http.js";
import { getContainerForUser } from "./jobs.js";
import { credentialsView } from "./container-view.js";
import { notificationsForUser, unreadNotificationCount } from "./notifications.js";
import { DashboardPage } from "./pages/dashboard.js";
import { AccountPage, LandingPage, NotFoundPage, OnboardingPage } from "./pages/views.js";
import { reconcile } from "./reconciler.js";
import { subscriptionRoutes } from "./subscriptions.js";
import type { AppContext } from "./types.js";

export const app = new Hono<AppContext>();

app.use("*", requestBodyLimit);
app.use("*", async (c, next) => {
  await next();
  c.header("referrer-policy", "no-referrer");
  c.header("x-content-type-options", "nosniff");
  c.header("x-frame-options", "DENY");
  c.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
});

app.onError((err, c) => {
  console.error(JSON.stringify({ event: "unhandled_error", path: c.req.path, error: String(err) }));
  if (c.req.path.startsWith("/api")) {
    return c.json({ error: "internal error" }, 500);
  }
  return c.text("Something went wrong.", 500);
});

app.get("/", async (c) => {
  const session = await createAuth(c.env, c.req.url).api.getSession({ headers: c.req.raw.headers });
  if (session) return c.redirect("/account/continue");
  return c.html(<LandingPage devAuth={c.env.DEV_AUTH === "1"} />);
});

app.get("/onboarding", requireUser, async (c) => {
  const userId = c.get("user").id;
  const [container, notificationCount] = await Promise.all([
    getContainerForUser(c.env, userId),
    unreadNotificationCount(c.env, userId),
  ]);
  if (container) return c.redirect("/dashboard");
  return c.html(
    <OnboardingPage
      githubAvailable={githubConfigured(c.env)}
      notificationCount={notificationCount}
    />,
  );
});

app.get("/dashboard", requireUser, async (c) => {
  const notificationCount = await unreadNotificationCount(c.env, c.get("user").id);
  return c.html(<DashboardPage notificationCount={notificationCount} />);
});

const renderAccountPage = async (c: Parameters<typeof requireUser>[0]) => {
  const user = c.get("user");
  const [passkeys, container, credentials, notifications, notificationCount] = await Promise.all([
    c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM passkey WHERE user_id = ?",
    )
      .bind(user.id)
      .first<{ count: number }>(),
    getContainerForUser(c.env, user.id),
    credentialsView(c.env, user.id),
    notificationsForUser(c.env, user.id),
    unreadNotificationCount(c.env, user.id),
  ]);
  return c.html(
    <AccountPage
      passkeyCount={passkeys?.count ?? 0}
      continueHref={container ? "/dashboard" : "/onboarding"}
      welcome={c.req.query("welcome") === "1"}
      containerStatus={container?.status ?? null}
      hasCredentials={credentials.hasCredentials}
      worldIdVerified={user.verification_method === "world_id"}
      notifications={notifications}
      unreadNotificationCount={notificationCount}
    />,
  );
};

app.get("/account", requireUser, renderAccountPage);
// Keep the old URL working while the navigation and page are now Account.
app.get("/security", requireUser, renderAccountPage);

app.route("/", authRoutes);
app.route("/", accountRoutes);
app.on(["GET", "POST"], "/api/auth/*", (c) => handleAuthRequest(c.env, c.req.raw));
app.route("/", adminRoutes);
app.route("/", fleetAdminRoutes);
app.route("/", githubRoutes);
app.route("/", codexAuthRoutes);
app.route("/", subscriptionRoutes);
app.route("/", apiRoutes);

app.notFound((c) => {
  if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
    return c.json({ error: "not found" }, 404);
  }
  return c.html(<NotFoundPage />, 404);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(reconcile(env as AppContext["Bindings"]));
  },
} satisfies ExportedHandler<AppContext["Bindings"]>;
