# Ledger

**A self-hosted budget tracker for households.** Ask before you buy or record it
afterwards, then see where the money went. Designed for phones and run entirely
on your own server.

SvelteKit 2 (Svelte 5 runes), Bun, PostgreSQL 17 and Drizzle. Authentication
comes from an external [Pocket ID](https://pocket-id.org) instance over OIDC,
passkeys only. Deployment is one app container and a database behind your
reverse proxy.

**[Try the live demo](https://ledger.pvi.sh)**, no signup. It runs the real
application against Postgres compiled to WASM in the browser tab, over invented
seed data.

|                                                                                                      |                                                                                                       |                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| <img src="docs/screenshots/ledger.png" width="250" alt="The ledger with Safe to Spend at the top" /> | <img src="docs/screenshots/approval.png" width="250" alt="An approval request awaiting a decision" /> | <img src="docs/screenshots/statement.png" width="250" alt="The monthly statement with Harmony's read" /> |

---

## Demo

<!--
Record it, drag the file into a GitHub issue or PR comment to get a
user-attachments URL, then replace this comment with:

<video src="https://github.com/user-attachments/assets/VIDEO_ID" controls muted></video>
-->

A walkthrough is coming. The narration script, timed to fit under three minutes,
is in [docs/demo-script.md](docs/demo-script.md). In the meantime the
[live demo](https://ledger.pvi.sh) is the real thing and takes no signup.

---

## Features

<table>
<tr>
<td width="270" valign="top"><img src="docs/screenshots/approval.png" width="250" alt="Approving a request" /><br /><img src="docs/screenshots/new.png" width="250" alt="Logging a purchase" /><br /><img src="docs/screenshots/members.png" width="250" alt="Per-member approval policy" /></td>
<td valign="top">

### Ask first, or log it after

Every purchase is either a request or a record, and each member's policy decides
which. Approval can be off entirely, required above a set amount, or required
always. Requests go to whichever approvers you nominate, or to one named person.

Deciding one takes a single tap. If the final price lands well above what was
approved, or somebody edits an approved purchase, it comes back for another
decision. Denials are not final either: the requester can appeal with a note
explaining what changed, and an approver can reverse their own denial. All of
this is written to an append-only audit log.

</td>
</tr>
</table>

<table>
<tr>
<td width="270" valign="top"><img src="docs/screenshots/safe-to-spend.png" width="250" alt="Safe to Spend broken down line by line" /></td>
<td valign="top">

### Safe to Spend

A single figure at the top of the ledger showing what is free to spend for the
rest of the month. It starts from your income and subtracts money already spent,
purchases approved but not yet paid for, bills still due before month end, and
anything moved into a bucket.

Tap it and the whole calculation expands, one line per term, followed by a
projection of the next few months built from whatever repeats. No language model
touches any of it; the figure is arithmetic over rows you can go and look at.

Because it is legible from a few feet away, it is masked by default and reveals
on tap.

</td>
</tr>
</table>

<table>
<tr>
<td width="270" valign="top"><img src="docs/screenshots/harmony.png" width="250" alt="Harmony answering a spending question" /><br /><img src="docs/screenshots/assist.png" width="250" alt="AI assist settings" /></td>
<td valign="top">

### Harmony

Ask a question in ordinary language and get an answer computed from your own
figures. The parser runs locally and ships with the app, so it works without any
model configured and makes no network calls.

Connecting a language model is optional, and what it is allowed to do is narrow.
It can pick from option sets the app already holds, or read text for the app's
own parsers. It has no route to approving a purchase or changing a figure. Every
response is validated first, so a bad one turns into an empty suggestion instead
of bad data, and nothing reaches the database without somebody confirming it.
Switch it off and every screen falls back to the deterministic behavior.

Point it at Ollama on your own machine, or at any OpenAI-compatible endpoint.

</td>
</tr>
</table>

<table>
<tr>
<td width="270" valign="top"><img src="docs/screenshots/buckets.png" width="250" alt="Savings buckets with goals" /><br /><img src="docs/screenshots/recurring.png" width="250" alt="Recurring bills" /><br /><img src="docs/screenshots/income.png" width="250" alt="Recurring and past income" /><br /><img src="docs/screenshots/calendar.png" width="250" alt="What is coming this month" /></td>
<td valign="top">

### Plan what is coming

**Buckets** move money aside on a schedule. Each has an owner and an optional
goal, and charging a purchase to one draws it down instead of counting against
this month. A bucket can also name who is allowed to charge it, which is what
makes an allowance possible: a pot only its owner can spend from, where anything
over the balance goes to an approver first.

**Recurring charges** run on a purpose-built RRULE subset with timezone-correct
times, capped catch-up after downtime, and either auto-complete or
confirm-at-the-real-price.

**Income** takes one-off entries and repeating templates, expanded when you look
at them, with everything already received folded away below.

</td>
</tr>
</table>

<table>
<tr>
<td width="270" valign="top"><img src="docs/screenshots/activity.png" width="250" alt="Spending by category" /><br /><img src="docs/screenshots/settle-up.png" width="250" alt="Who owes whom" /><br /><img src="docs/screenshots/statement.png" width="250" alt="The monthly statement" /></td>
<td valign="top">

### See where it went

Every figure is computed on the fly and filtered for the person looking. Month
against last month, a daily trend, breakdowns by category and by member, and
budgets set overall or per category.

**Settle up** answers who owes whom: the period's shared spending split into fair
shares, evenly or weighted by what each person earned, and the transfers that
even it out.

The **monthly statement** totals the month and reads it back in plain language.

</td>
</tr>
</table>

<table>
<tr>
<td width="270" valign="top"><img src="docs/screenshots/reconcile.png" width="250" alt="Importing a bank statement" /></td>
<td valign="top">

### Reconcile against your bank

Import a CSV or a PDF and tick it against what is recorded. A PDF is parsed in
your browser, so the document never leaves the device: only the date, amount and
description columns are posted.

The matcher does not guess. Where a line could plausibly be one of several
purchases it stays unmatched and offers a ranked shortlist to choose from.
Importing only marks lines as cleared, so a bank file cannot alter what you
recorded.

</td>
</tr>
</table>

<table>
<tr>
<td width="270" valign="top"><img src="docs/screenshots/appearance.png" width="250" alt="Appearance settings on the magenta accent" /><br /><img src="docs/screenshots/categories.png" width="250" alt="Custom categories on the evergreen accent" /><br /><img src="docs/screenshots/appearance-dark.png" width="250" alt="Appearance settings in dark on the azure accent" /><br /><img src="docs/screenshots/ledger-dark.png" width="250" alt="The ledger in dark on the cerulean accent" /></td>
<td valign="top">

### Make it yours

Ten accents, stored per workspace, so two households sharing a server do not
look alike. The screenshots here use magenta, evergreen, azure and cerulean. The
accent is a single stored value that every tint and control derives from, so
changing it moves the entire interface.

Light and dark follow the device unless you override them, and the theme is
applied before first paint to avoid a white flash on load. Theme is stored per
device, while the accent belongs to the workspace.

Categories can be added, renamed and retired. The built-in set is only a
starting point.

</td>
</tr>
</table>

<table>
<tr>
<td width="270" valign="top"><img src="docs/screenshots/map.png" width="250" alt="Spending drawn on a map" /></td>
<td valign="top">

### Where it happened

Attach a place to a purchase and see the month drawn on a map, sized by what you
spent and colored by category. Bubbles cluster in screen pixels, so a pinch
re-clusters instantly.

Nothing is captured automatically. You either tap **Use my location**, paste a
map link (parsed on your device, with no request made), or type an address.
Coordinates are rounded to integer millidegrees, about 110 m, which the settings
copy is explicit about not being anonymity. Pins inherit the same visibility
rules as their purchase, so anything hidden from you has no marker you can see.

With no basemap configured the map still works and draws a plotted graticule
instead of streets. When one is configured the tiles are fetched by your server
and re-served from your origin, so your browser never talks to the tile
provider.

</td>
</tr>
</table>

<table>
<tr>
<td width="270" valign="top"><img src="docs/screenshots/api.png" width="250" alt="API tokens and the MCP server" /></td>
<td valign="top">

### Connect an assistant

Bearer tokens with read, log and approve scopes, and an MCP server so Claude,
ChatGPT or your editor can query the workspace in plain language.

A token acts as the member it belongs to, so approval policies still apply,
gift-mode seals still hide purchases from it, and a member limited to their own
buckets stays limited over the API. Coordinates have no write path at all.

</td>
</tr>
</table>

<table>
<tr>
<td width="270" valign="top"><img src="docs/screenshots/notifications.png" width="250" alt="Notification routing" /></td>
<td valign="top">

### Notifications, and a real install

Web Push and ntfy, routed per member, per event and per channel. A channel with
nothing configured behind it is disabled, so you cannot arm one that has no way
to deliver.

Added to a home screen the app runs in its own window, respects the safe area
and works offline. The install prompt asks once and remembers the answer. On
iPhone, where installation is manual, the Add to Home Screen steps are spelled
out.

</td>
</tr>
</table>

### And the rest

- **Workspaces.** Create one or join with an invite code. Owner and member roles,
  per-member approval policies, and a switcher for people in more than one.
- **Gift mode.** Hide a purchase from chosen people until a date. It is hidden
  everywhere: lists, search, detail pages, and every total is recomputed as though
  it did not exist, so nothing leaks by subtraction. The one path that can
  auto-approve a sealed purchase says so in the audit log.
- **Images.** A content-addressed blob store with magic-byte validation, EXIF
  stripping and WebP derivatives. Originals are discarded.
- **Command palette.** A local intent parser over spending questions, net
  position, bucket creation and navigation. No model required.

---

## Quick start

You need Docker, and a [Pocket ID](https://pocket-id.org) instance for sign-in.
Pocket ID is a small OIDC provider that does passkeys; Ledger has no password
login of its own, by design.

```sh
git clone https://github.com/zenatron/ledger.git
cd ledger
cp .env.example .env
```

Edit `.env` and set four values:

| Variable                  | What it is                                                           |
| ------------------------- | -------------------------------------------------------------------- |
| `PUBLIC_ORIGIN`           | The URL people will actually open, e.g. `https://ledger.example.com` |
| `POCKET_ID_ISSUER`        | Your Pocket ID base URL. No trailing slash, no path.                 |
| `POCKET_ID_CLIENT_ID`     | From a **confidential** OIDC client in Pocket ID                     |
| `POCKET_ID_CLIENT_SECRET` | The same client's secret                                             |

In Pocket ID, under Administration then OIDC Clients, register the callback
exactly as `https://your-host/auth/callback`. A mismatch here is the single most
common reason a first login fails.

Then:

```sh
docker compose up -d --build
```

That starts the app on port 3000 and a Postgres 17 container beside it.
Migrations run automatically on boot. Open `PUBLIC_ORIGIN`, sign in, and create
a workspace; the account that creates it becomes its owner.

Everything else is optional and off until configured: Web Push, ntfy, basemap
tiles, address search, barcode lookup and the AI assist. `.env.example`
documents each one and the app works without all of them.

To put it behind a reverse proxy, forward to port 3000 and make sure
`PUBLIC_ORIGIN` matches the external URL. The app trusts exactly one
`X-Forwarded-For` hop, so the rate limiter sees real client addresses rather
than your proxy. Compose publishes port 3000 on loopback only — the proxy is
expected to run on the same host; if yours is on another machine, publish on
`0.0.0.0` in `compose.yaml` and make sure nothing else can reach the port.

### Upgrading

```sh
git pull
docker compose up -d --build
```

Migrations are applied on boot behind a Postgres advisory lock, so starting
several instances at once is safe. Take a backup first; see
[Backup and restore](#backup--restore).

---

## The static demo

The app also builds as a static site with no server and no database, for
GitHub Pages. It is the same app, not a mock: the real routes, use cases and
repositories run against Postgres compiled to WASM in the tab, over a seeded
snapshot. Excluded by construction: auth, the AI assistant, MCP, the API, and
anything else that needs a backend.

```bash
bun run db:start     # a local postgres, for building the seed only
bun run demo:seed    # seeds a throwaway db, dumps it into a PGlite snapshot
bun run demo:build   # generates .demo/routes, builds to build-demo/
bun run demo:preview # both of the above, then serves it
```

The demo ships the ledger, a purchase's detail and the new-purchase form,
buckets, income, analytics, the calendar, the month statement, recurring,
categories, appearance and the workspace overview. The new-purchase form's
"describe it" field works in the tab too: the deterministic parser and the
merchant memory it draws on are pure, so the demo's endpoint shim answers
locally. Left out because they need a backend: auth, the Harmony palette, MCP,
the API, reconciliation, the map, CSV export and
the notification/member/model settings.

It seeds two workspaces, so switching between them does something. Deleting one lands you on the other;
deleting both lands you on the sign-in page, where the demo offers to reseed.
Signing out ends the tab's session the way the real one ends a cookie.

`demo:seed` reuses `scripts/seed-workspace.ts` unchanged, so the demo's data
cannot drift from the seeder the dev environment uses. `demo:build` generates a
parallel route tree at `.demo/routes` rather than touching `src/routes`; routes
enter the demo by being listed in `DEMO_ROUTES` in `scripts/demo-build.ts`, and
only once they have a `handlers.ts`.

Deploying to a project site (`user.github.io/repo`) needs the base path:

```bash
DEMO_BASE=/repo bun run demo:build
```

The demo also gets its own `app.html`, generated from the real one with the
boot screen in it (`src/demo-boot.html` and `src/demo-boot.css`). Its routes
render nothing on the server, so the shell would otherwise be blank paper while
the bundle, the WASM database and the seed arrive; the root layout removes the
element once Svelte mounts. Production renders on the server and never includes
it.

`bun run demo:build` finishes with `scripts/demo-finalize.ts`, which copies the
seed and the boot stylesheet in, writes `404.html` (GitHub Pages serves it for any path it has no file
for, which is what makes deep links work), adds `.nojekyll`, and rewrites the
web manifest's `scope`, `start_url` and icons for the base path.

### Deploying it

`.github/workflows/demo.yml` builds and publishes to **Cloudflare Pages** on
every push to `main`, and on demand from the Actions tab.

The build runs in GitHub Actions rather than Cloudflare's Git integration
because the seed needs a real Postgres to migrate, seed and `pg_dump`, which a
Pages build container does not provide. Cloudflare only receives the finished
directory, uploaded with Wrangler, so the snapshot is rebuilt from the current
schema every run and never has to be committed.

One-time setup:

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Upload assets**, name the project `ledger-demo`, and create it. (The first
   real deploy comes from CI; this only reserves the name.)
2. **Custom domains** → add `ledger.pvi.sh`. The DNS record is created for you
   when the zone is already on Cloudflare.
3. Create an API token with the **Cloudflare Pages: Edit** permission.
4. In GitHub → Settings → Secrets and variables → Actions, add
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

`DEMO_BASE` is left empty: the demo is served from the root of its own
subdomain, not a subpath.

`DEMO_HOST` decides how the client-routed app is served, and the two hosts
disagree in a way that is easy to get backwards:

|                        | fallback                               | note                                                          |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------- |
| `cloudflare` (default) | `_redirects` with `/* /index.html 200` | a top-level `404.html` **disables** Cloudflare's SPA fallback |
| `github`               | `404.html`                             | GitHub Pages has no rewrite rules                             |

The workflow runs `check` and the unit tests before building, so a broken build
cannot replace a working demo. It deliberately does not run the e2e suite: that
needs Postgres, a fake identity provider and browsers, and belongs in its own
workflow.

Note that the demo is **public**. The seeded data is entirely fictional: the
generator invents every name, merchant and amount.

---

## Development

```sh
bun install
docker compose up -d db          # postgres 17 on :5432
bun scripts/dev-oidc.ts &        # fake OIDC provider on :9443 (dev only)
POCKET_ID_ISSUER=http://localhost:9443 \
POCKET_ID_CLIENT_ID=budget-local \
POCKET_ID_CLIENT_SECRET=dev-secret \
OIDC_REDIRECT_URI=http://localhost:5173/auth/callback \
bun run dev
```

The fake IdP auto-approves logins. Switch identities with
`curl http://localhost:9443/_as/bob` (alice / bob / carol).

- `bun run test` - domain unit tests (vitest)
- `bun run test:e2e` - Playwright: approval, sealing and places flows (needs the db container)
- `bun run seed` - demo workspace for the fake-IdP users
- `bun run check` - svelte-check
- `bun run lint` / `bun run format`
- `bun run db:generate` - create a migration after editing `src/lib/server/db/schema.ts`

### Screenshots

The images in this file and in the install sheet are committed output. They get
regenerated on a redesign, not on every build. The capture happens in two passes, because
they need different things:

```sh
# 1. Everything the demo can render. Needs only this repo, and is reproducible.
bun run demo:build && bun scripts/capture-screenshots.ts

# 2. The pages that need a server behind them: Harmony, AI assist, members,
#    the map, reconcile, API, notifications, and the accent set. Needs a seeded
#    database and DEV_MODE.
bun run db:start
DATABASE_URL=postgres://root:mysecretpassword@localhost:5432/local bun run seed
DEV_MODE=true POCKET_ID_ISSUER=http://localhost:9443 \
POCKET_ID_CLIENT_ID=budget-local POCKET_ID_CLIENT_SECRET=dev-secret \
OIDC_REDIRECT_URI=http://localhost:5173/auth/callback \
bun run dev &
CAPTURE_SERVER_WS=demo CAPTURE_DB_URL=$DATABASE_URL \
  bun scripts/capture-screenshots.ts --server http://localhost:5173
```

The seed adds the DEV_MODE auto-login user to the workspace as an owner (half
the captured screens are owner-only) and turns places on, so the map shot has
something to draw — it also seeds a few pinned purchases for the same reason.

`CAPTURE_DB_URL` is what lets the accent shots write the column the accent
actually lives in. Without it those shots still render, in whatever accent the
workspace already has, and the run says so. The original accent is put back
afterwards, so capturing is not a mutation.

A partial run — pass one alone, or a seed with no pending approval — leaves
the shots it didn't take untouched, and the manifest keeps their entries: a
pass-one-only run can no longer quietly shrink the store listing. Both passes
write full-bleed PNGs to `static/screenshots/` for the web manifest, and the
same shots with the phone's corner radius to `docs/screenshots/` for this
file. The manifest's screenshot list is generated from the same array that
drives the capture, so the two cannot drift.

Migrations run automatically on app boot (single-flight via Postgres advisory lock).

## Running it in production

[Quick start](#quick-start) covers the first boot. `.env.example` documents the
full environment contract. Beyond that:

- Blobs live in the `blobs` volume at `/data/blobs`. Back up the database first
  and the blob directory second. Blobs are content-addressed and append-only, so
  that order never strands a reference.
- **Basemap tiles are not a blob.** `TILE_CACHE_DIR`, `/data/tiles` by default,
  holds disposable third-party imagery keyed by coordinate with a 30 day TTL.
  Leave it out of your backups. It would otherwise carry hundreds of megabytes
  of somebody else's map into every archive, and deleting it is safe at any
  time.
- The optional self-hosted geocoder is behind a compose profile:
  `docker compose --profile geocoder up -d`. It is not started by default
  because the first run imports an OpenStreetMap extract, which takes a while
  and wants real disk. Set `NOMINATIM_IMPORT_URL` to your own region; the
  default is a placeholder that finds almost nothing.

## Backup & restore

```sh
# 1. Database first
docker compose exec db pg_dump -U root -Fc local > backup/budget-$(date +%F).dump
# 2. Then blobs (append-only, so dumping after the DB never strands a reference)
docker run --rm -v budget-app_blobs:/data/blobs -v "$PWD/backup:/backup" \
  alpine tar czf /backup/blobs-$(date +%F).tgz -C /data blobs

# Restore (reverse order is fine; blobs are content-addressed)
docker compose exec -T db pg_restore -U root -d local --clean < backup/budget-YYYY-MM-DD.dump
docker run --rm -v budget-app_blobs:/data/blobs -v "$PWD/backup:/backup" \
  alpine tar xzf /backup/blobs-YYYY-MM-DD.tgz -C /data
```

## Architecture

```
src/lib/domain/        pure TS, no I/O - money, purchase state machine,
                       approval policy evaluation, staleness, and the location
                       maths (Web Mercator, bubble clustering, map-link
                       parsing) - all unit-tested
src/lib/application/   use-cases: create/join workspace, submit/approve/deny/
                       cancel/complete/edit purchase (transactional + audit event),
                       recurring materialization, bucket accruals, budget alerts
src/lib/intelligence/  intent parser for the command palette (pure TS, no network)
src/lib/ports/         Clock, IdGenerator, Notifier, BlobStore, LlmAssist,
                       Geocoder (the last two default to null adapters - the app
                       is fully usable with neither configured); AppDeps and
                       AppContext, the composition root's output
src/lib/db/            schema and the `Db` type - the persistence port
src/lib/repo/          repositories over `Db` (every purchase read takes
                       workspaceId + viewerId); driver-agnostic, so the demo
                       runs them unchanged against Postgres-in-WASM
src/lib/demo/          the demo build's driven adapters: PGlite, in-memory
                       blobs, a null notifier, and the browser's context
src/lib/infra/         system clock, UUIDv7, filesystem blob store, image pipeline,
                       notifiers (web push, ntfy, composite), in-process SSE bus,
                       geocoding adapters
src/lib/actions/       Svelte actions - money input masking, use:submit, use:dismiss
src/lib/server/        things that genuinely need a server: env validation, the
                       postgres-js client, migrations, auth (OIDC, sessions),
                       rate limiting, basemap tile cache, MCP
src/routes/            thin routes; authorization resolved once in hooks.server.ts.
                       Converted routes keep their logic in a neutral handlers.ts
                       taking an AppContext, with +page.server.ts a few lines of
                       binding - the same handlers the demo build runs
```

The periodic sweep lives in `hooks.server.ts`: unseal due purchases, materialize
recurring rules and bucket accruals, send stale nudges and budget alerts. It runs
on boot and every 5 minutes, never overlapping itself, and stops on SIGTERM.

---

## Support

Ledger is free, and it stays that way. If it saved you a subscription and you
want to put something back, there is a Ko-fi:

**[ko-fi.com/zenatron](https://ko-fi.com/zenatron)**

Filing a good bug report is worth as much, and costs nothing.

---

## License

[GNU Affero General Public License v3.0 or later](LICENSE).

The network clause is why this license and not a permissive one. If you modify
Ledger and run it as a service other people can reach, they are entitled to your
changes. Running it unmodified for your own household asks nothing of you.
