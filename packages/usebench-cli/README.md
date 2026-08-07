# usebench

Start the usebench.dev onboarding wizard from a terminal:

```sh
npx usebench
```

The wizard opens a browser for Google or GitHub sign-in, verifies eligibility
with World ID or an invite, configures agents and integrations, provisions the
workbench, and can add an `ssh workbench` shortcut.

Use `npx usebench --clear-session` to remove the locally cached sign-in session.
Use `npx usebench --base-url https://staging.example.com` when testing another
deployment.
