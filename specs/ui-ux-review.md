# UI / UX / Design Review — usebench.dev

Branch: `review/ui-ux-review` (worktree off `main`)
Scope: `apps/worker` SSR pages + React islands (landing, onboarding, dashboard, security, shared dialog), mobile and desktop.
Constraint: uphold "simple and utilitarian" — keep the light theme and the existing accent color.

---

## 1. Current state inventory

**Tokens** (`src/pages/styles.ts`): warm paper `#fbfaf7`, ink `#20201d`, muted `#706f69`, accent `#174ea6` + `--accent-soft`, danger/warn hues, one mono stack. Single 600px breakpoint. `prefers-reduced-motion` is handled globally.

**Pages**: Landing (hero + spec list + auth tabs), Onboarding (3-step wizard), Dashboard (container card, SSH access, account), Security (passkeys). Shared chrome: `Layout` with skip-link, mono logo, minimal nav.

**Existing motion**: staggered page-load reveal (`ui.tsx`), animated `<details>` height, Base UI tab indicator with `layoutId`, enrollment panel expand/collapse (`AnimatePresence`), dialog fade/translate, spinner. This is a good foundation — motion is already present but applied unevenly.

## 2. Strengths (keep)

- The token palette is cohesive and genuinely "simple and utilitarian." Warm paper + ink + one blue accent is a strong identity. Do not add a second accent.
- Accessibility is above average: skip link, `aria-live` regions, `role="status"`, focus-visible rings, reduced-motion everywhere, 16px inputs on mobile to prevent iOS zoom.
- Restraint: borderless sections separated by hairlines, no decorative imagery, mono used only where it means "terminal/credential."
- The voice ("Your workbench.", "Set up a workbench.") is consistent and calm.

## 3. Issues found

### 3.1 Bugs / correctness

1. **Danger buttons render in accent blue.** `.btn.secondary, .btn.danger { color: var(--accent); }` — "Delete account", "Destroy workbench", and the destructive confirm in the dialog are visually identical to harmless actions. `--danger` exists but is never applied to buttons. This is the single most important fix: destructive affordances must read as destructive.
2. **Agent tile padding is hard-coded for sign-in buttons.** `.agent-choice { padding-right: 9.5rem }` reserves space for the overlaid sign-in button on *every* agent tile, including pi/opencode which have none, and on mobile (where the grid goes single-column but the padding stays), text is squeezed into ~190px on a 360px screen.
3. **No 404 page.** Hono falls back to plain text; a branded `notFound` page in the Layout costs nothing and closes a consistency hole.
4. **No favicon.** `theme-color` is set but there is no icon; tab identity is missing.

### 3.2 Visual consistency

5. **Two shadow/radius languages.** Dialogs use a brutalist hard offset shadow (`7px 7px 0`) + 1px ink border + radius 0; everything else uses soft `0 1px 2px` shadows and 3–5px radii. Pick one — the soft language fits "utilitarian" better.
6. **Button hierarchy is unclear.** Almost every action is a borderless blue text-button; the only solid button is the centered pill "Create workbench →". Primary/secondary/danger are indistinguishable by scan. Also `.create-workbench-btn` is the *only* centered element on an otherwise flush-left page.
7. **Inline styles in components** (SSH key list truncation in `dashboard-ssh.tsx`, nav `margin:0` in `layout.tsx`) bypass the token system — move to classes.
8. **Heading punctuation drift**: "Your workbench." / "Account security." carry periods; landing "A cloud terminal for agents" doesn't. Minor, but the voice should pick one convention.
9. **Contrast is borderline**: `--muted #706f69` on `--paper` is ~4.4:1 and is used for 0.86rem helper text — at AA's edge. Darkening to ~`#65645e` buys margin with no visible change.
10. **Tap targets below 44px on mobile**: `.btn` min-height is 2.15rem (~34px) with only 0.2rem horizontal padding; auth tabs 2.4rem. Fine for a mouse, cramped for thumbs — especially the header "Security / Sign out" pair.

### 3.3 UX flow

11. **Dashboard loading state is a spinner, not a skeleton.** The card area collapses to one line then pops in the full workbench card — a layout jump on every visit. A skeleton mirroring the card shape (already suggested by the SSR placeholder) would make loading feel stable.
12. **No transition on status changes.** Provisioning → running is the product's emotional payoff moment; today the badge text just swaps. A subtle badge color/pulse transition (respecting reduced motion) earns its cost here.
13. **Copy feedback is instant text swap** ("Copied ✓"). A 150ms fade/checkmark swap matches the motion language already established.
14. **Onboarding wizard length on mobile.** Three stacked cards + two `<details>` + repo list is a long scroll with the submit pill only at the bottom. A slim sticky footer with the Create button (mobile only) or a step-progress hint would reduce abandonment risk. Lowest-effort acceptable option: keep as-is but raise the submit button's prominence.
15. **Error recovery copy** is good, but `.err` blocks render empty with `min-height`, creating small dead gaps; only reserve space when populated.

### 3.4 Typography

16. **Arial is doing display work it isn't suited for.** The h1 is clamp(2rem,7vw,4.2rem) at -0.055em tracking — tight negative tracking on Arial looks cramped, not crafted. The mono/logo contrast is nice; the sans is the weak link.

## 4. Recommendations (upholding "simple and utilitarian")

### 4.1 Typeface
Adopt one grotesque for UI text while keeping the existing mono for logo/code/credentials:

- **Primary suggestion: IBM Plex Sans** — utilitarian heritage, engineered feel, pairs natively with the terminal aesthetic (and with IBM Plex Mono if the mono stack is ever revisited). Self-host the variable font from `apps/worker/public` to avoid a third-party dependency.
- Alternative: **Inter** (safest, most neutral) or keep system fonts but soften h1 tracking to `-0.035em` and weight to 600.

Whatever is chosen: one family, two weights (400/600), applied via a `--sans` token next to `--mono`.

### 4.2 Motion (more, but disciplined)
Standardize on the existing `cubic-bezier(0.22, 1, 0.36, 1)` ease-out, 140–280ms:

- Skeleton shimmer (or static skeleton, no shimmer) for the dashboard card; crossfade skeleton → content.
- Badge color transition on status change; one gentle pulse when entering `running` (reduced-motion: instant).
- Micro-feedback: copy-button checkmark fade, button `active` scale 0.98, hover transitions on agent tiles and repo choices (currently none).
- Extend the tab-indicator technique: the dialog and enrollment panels already animate — keep as-is.

Rule of thumb: animate *state changes the user waits for*, never decorative loops.

### 4.3 Component design
- **Real button hierarchy**: primary = solid accent (white text, radius 6px); secondary = 1px `--line-strong` border, ink text; danger = `--danger` text/border, `--danger` solid only for the final confirm in dialogs. Keep the text-link style for tertiary actions.
- **One radius** (6px) and **one soft shadow** token; restyle the dialog to match (border `--line`, soft shadow, radius 6px) or deliberately keep the hard-shadow dialog as *the* signature — but then remove soft shadows elsewhere. Don't ship both.
- Fix `.agent-choice` padding: only reserve right space when a sign-in control exists (modifier class or `:has()`), and reduce it under the mobile breakpoint.
- Promote `.card` to a component with an optional `--surface` variant for grouped forms (API keys section) so nested providers don't float on the page background.
- Move all inline styles to classes.

### 4.4 Centering & layout
- Keep the 860px measure — it's right for forms and SSH commands.
- Landing: center the hero block (h1 + lead) while keeping the spec list and auth card left-aligned; this gives the page a focal point without breaking the utilitarian grid. Alternatively keep flush-left but add a thin accent rule above the h1 as an anchor. Do not center the dashboard — tool pages should stay flush-left.
- Align the onboarding submit with the content column (flush-left, primary button) instead of a centered pill, matching recommendation 6.

### 4.5 Mobile specifics
- Raise interactive min-heights to 2.75rem (44px) under the 600px breakpoint (buttons, tabs, agent tiles already fine).
- Header: keep both nav items but add gap and let them wrap under the logo if needed; consider hiding "Security" behind the dashboard's Account card on small screens only if space proves tight — test first.
- Verify `.agent-signin` overlay on ≤400px widths after the padding fix.
- Long SSH commands already scroll horizontally — add `overflow-wrap` fallback copy for the manual-key path, which already wraps.

### 4.6 Small wins
- Add favicon (SVG, accent square + mono "u") + `notFound` page in Layout.
- Darken `--muted` one step.
- Only reserve `.err` height when populated.
- Unify heading punctuation (recommend: periods on tool pages, none on the marketing hero).

## 5. Prioritized action list

| # | Change | Effort | Impact |
|---|--------|--------|--------|
| 1 | Fix `.btn.danger` + destructive dialog confirm styling | XS | High (safety) |
| 2 | Button hierarchy (primary/secondary/danger) | S | High |
| 3 | Typeface swap + `--sans` token | S | High |
| 4 | Agent tile padding fix (mobile) | XS | High (mobile) |
| 5 | Dashboard skeleton loading | S | Medium |
| 6 | Status badge transition + running pulse | XS | Medium |
| 7 | Unify radius/shadow language (dialog) | XS | Medium |
| 8 | 44px mobile tap targets | XS | Medium |
| 9 | Landing hero centering/anchor | XS | Medium |
| 10 | Favicon + 404 page | XS | Low |
| 11 | `--muted` contrast step, `.err` height, punctuation, inline styles | XS | Low |

Non-goals confirmed: no dark mode, no second accent color, no illustrations/decor, no layout wider than 860px.

## 6. Implementation status

All 11 items implemented on this branch (2026-07-22) and reconciled with the current `main` auth flow (2026-07-29). Validation: `npm run typecheck`, `npm test` (355 passing across all workspaces), `npm run lint`, `npm run build:client` — all green.

1. **Danger styling** — `.btn.danger` is now bordered danger-red; destructive dialog confirms use the new `.btn.danger-solid` via a `danger` flag on `askConfirmation` (destroy, rebuild, delete account).
2. **Button hierarchy** — refined after visual review: `.btn` is a borderless underlined accent action, while `.btn.primary` reserves the solid accent treatment for true forward CTAs. Destructive actions remain red, with solid red reserved for final confirmation. Spinners adapt to solid backgrounds.
3. **Typeface** — self-hosted IBM Plex Sans variable font (`public/fonts/ibm-plex-sans-latin.woff2`, preloaded, `font-display: swap`) behind a `--sans` token; h1 weight 600 / -0.04em tracking. Mono stack unchanged for logo/code/credentials.
4. **Agent tile padding** — right padding only via `.agent:has(.agent-signin)`; on mobile the sign-in control stacks below the label instead of overlaying.
5. **Dashboard skeleton** — shimmer skeleton (`.skel`) in both the SSR placeholder and the React loading branch; static under reduced motion.
6. **Badge motion** — 240ms color transitions and a gentle two-pulse ring when entering `running`; disabled under reduced motion.
7. **Unified radius/shadow** — single `--radius: 6px` token across inputs, tiles, tabs, code blocks; dialog now uses the soft shadow language (no more hard offset shadow).
8. **Mobile tap targets** — buttons and auth tabs are 2.75rem (44px) under the 600px breakpoint.
9. **Landing composition** — the hero returned to the product's flush-left grid after visual review. Landing authentication is centered within a compact bordered group, while tool pages remain flush-left and the onboarding submit remains a clear primary button.
10. **Favicon + 404** — `public/favicon.svg` (accent tile, mono "u"), linked in the layout; `NotFoundPage` served by `app.notFound` (JSON 404 preserved for `/api/*`).
11. **Small wins** — `--muted` darkened to `#65645e` for AA margin, `.err:empty` no longer reserves space, inline styles moved to `.key-fingerprint` / `.flush` / `.hint` / `.flow-steps` classes, plus a keyed `SwapText` micro-animation for copy feedback.
12. **Inline World ID handoff** — removed the confirmation dialog. Mobile opens the World App connector while the source page keeps polling; desktop renders the connector as an inline QR code. Progress and failures stay directly beneath the World ID action.
