import type { FC } from "hono/jsx";
import { Layout } from "./layout.js";

export const DashboardPage: FC<{ notificationCount?: number }> = ({ notificationCount = 0 }) => (
  <Layout title="Dashboard" loggedIn notificationCount={notificationCount}>
    <div id="dashboard-root">
      <h1>Your workbench.</h1>
      <div class="card" aria-live="polite" aria-busy="true">
        <span class="sr-only">Loading your workbench…</span>
        <div class="skel skel-title"></div>
        <div class="skel skel-line"></div>
        <div class="skel skel-line short"></div>
      </div>
    </div>
    <script type="module" src="/dashboard.js"></script>
  </Layout>
);
