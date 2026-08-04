# usebench

Start the usebench.dev onboarding wizard from a terminal:

```sh
npx usebench
```

The wizard opens a browser for Google or GitHub sign-in, verifies eligibility
with World ID or an invite, configures agents and integrations, provisions the
workbench, and can add an `ssh workbench` shortcut.

Setup is navigable: each section can be continued, edited, or revisited with
Back. The account step can restart browser sign-in so you can switch between
Google and GitHub before provisioning.

Use `npx usebench --clear-session` to remove the locally cached sign-in session.
Use `npx usebench --base-url https://staging.example.com` when testing another
deployment.
