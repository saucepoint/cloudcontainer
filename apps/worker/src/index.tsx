import { Hono } from "hono";
import { apiRoutes } from "./api.js";
import { adminRoutes } from "./admin.js";
import { authRoutes, requireUser } from "./auth.js";
import { codexAuthRoutes } from "./codexauth.js";
import { githubConfigured, githubRoutes } from "./github.js";
import { getContainerForUser } from "./jobs.js";
import { DashboardPage } from "./pages/dashboard.js";
import { LandingPage, OnboardingPage, SecurityPage } from "./pages/views.js";
import { passkeyRoutes } from "./passkeys.js";
import { reconcile } from "./reconciler.js";
import { subscriptionRoutes } from "./subscriptions.js";
import type { AppContext } from "./types.js";

export const app = new Hono<AppContext>();

app.use("*", async (c, next) => {
  await next();
  c.header("referrer-policy", "no-referrer");
  c.header("x-content-type-options", "nosniff");
  c.header("x-frame-options", "DENY");
  c.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
});

app.onError((err, c) => {
  console.log(JSON.stringify({ event: "unhandled_error", path: c.req.path, error: String(err) }));
  if (c.req.path.startsWith("/api")) {
    return c.json({ error: "internal error" }, 500);
  }
  return c.text("Something went wrong.", 500);
});

app.get("/", (c) =>
  c.html(
    <LandingPage
      devAuth={c.env.DEV_AUTH === "1"}
      worldIdEnvironment={c.env.WORLD_ID_ENVIRONMENT}
    />,
  ),
);

app.get("/onboarding", requireUser, async (c) => {
  const container = await getContainerForUser(c.env, c.get("user").id);
  if (container) return c.redirect("/dashboard");
  return c.html(
    <OnboardingPage githubAvailable={githubConfigured(c.env)} />,
  );
});

app.get("/dashboard", requireUser, (c) => c.html(<DashboardPage />));

app.get("/security", requireUser, async (c) => {
  const user = c.get("user");
  const passkeys = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM passkeys WHERE user_id = ?",
  )
    .bind(user.id)
    .first<{ count: number }>();
  const container = await getContainerForUser(c.env, user.id);
  return c.html(
    <SecurityPage
      signupMethod={user.signup_method}
      passkeyCount={passkeys?.count ?? 0}
      continueHref={container ? "/dashboard" : "/onboarding"}
      welcome={c.req.query("welcome") === "1"}
    />,
  );
});

app.route("/", authRoutes);
app.route("/", passkeyRoutes);
app.route("/", adminRoutes);
app.route("/", githubRoutes);
app.route("/", codexAuthRoutes);
app.route("/", subscriptionRoutes);
app.route("/", apiRoutes);

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(reconcile(env as AppContext["Bindings"]));
  },
} satisfies ExportedHandler<AppContext["Bindings"]>;
