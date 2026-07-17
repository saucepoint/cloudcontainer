import type { FC } from "hono/jsx";
import { Layout } from "./layout.js";

export const DashboardPage: FC = () => (
  <Layout title="Dashboard" loggedIn>
    <div id="dashboard-root">
      <h1>Your server.</h1>
      <div class="card" aria-live="polite" aria-busy="true">
        <p class="muted">
          <span class="spinner" aria-hidden="true"></span>Loading your server…
        </p>
      </div>
    </div>
    <script type="module" src="/dashboard.js"></script>
  </Layout>
);
