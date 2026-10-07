# Creator Growth Engine

Internal portal for the marketing team to find, qualify, contact and track US creators on
Instagram, TikTok and YouTube. It replaces the Excel sheet.

Built so far (Phase 0 + Phase 1): login, campaigns, influencers, CSV import, one-click message,
status tracking, the activity log, creator discovery (YouTube, Instagram hashtags), AI fit
scoring, the human review queue and the admin screens.

Not built: automated outreach, email sending, auto-approval, agreements and shipping, post and
performance tracking, feedback and recommendations. Their tables exist in the schema but
nothing writes to them yet.

## Stack

Next.js 15 (App Router, Server Actions), TypeScript, Tailwind v4, shadcn/ui, Prisma 6,
PostgreSQL (Neon), Auth.js credentials login, pnpm. Deploys to Vercel.

## Setup

Requirements: Node 20 or newer, pnpm, a Neon database.

```bash
pnpm install
```

1. Copy `.env.example` to `.env` and fill it in (see the table below).
2. Open `prisma/seed.ts` and set the admin's name and email in `USERS`. Teammates are added
   later in the app under Admin > Users. The name is what `{sender}` becomes in message templates.
3. Create the tables and load the seed data:

```bash
pnpm db:migrate
```

```bash
pnpm db:seed
```

4. Start the app and sign in with a seed user's email and `SEED_USER_PASSWORD`:

```bash
pnpm dev
```

The seed creates the admin user, 4 message templates, 2 sample campaigns and 10 sample influencers
(handles ending in `.sample`). It is safe to run again: existing rows are left alone and
existing users keep their password.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Neon pooled connection string (host contains `-pooler`). Used by the app. End it with `&connect_timeout=15&pool_timeout=20` (see below). |
| `DIRECT_URL` | yes | Neon direct connection string. Used by `prisma migrate`. End it with `&connect_timeout=15`. |
| `AUTH_SECRET` | yes | Signs the session cookie. Any long random string; see `.env.example` for a command that makes one. |
| `AUTH_TRUST_HOST` | outside Vercel | Set to `true` when running `pnpm start` on your own host. |
| `CREATOR_SOURCE` | no | Creator-fetching adapter: `csv`, `manual`, `meta_free` or `vendor`. Default `manual`. |
| `APP_URL` | on Vercel | Public address of the site, used in creators' product-selection links. |
| `CRON_SECRET` | on Vercel | Secret for the daily automation endpoint. |
| `APP_TIME_ZONE` | no | IANA zone for timestamps, e.g. `America/New_York`. Default `UTC`. |
| `LEGAL_CONTACT_EMAIL` | recommended | Address shown on `/privacy` and `/terms`. |
| `SEED_USER_PASSWORD` | for seeding | Password given to seed users. At least 10 characters. |
| `YOUTUBE_API_KEY` | for YouTube discovery | YouTube Data API v3 key. |
| `META_ACCESS_TOKEN` | for Instagram discovery | Long-lived Graph API user token. |
| `IG_BUSINESS_ID` | for Instagram discovery | Id of your Instagram business account. |
| `META_GRAPH_VERSION` | no | Pin a Graph API version, e.g. `v23.0`. |
| `ANTHROPIC_API_KEY` | for AI scoring | Anthropic API key. |
| `ANTHROPIC_MODEL` | no | Scoring model. Default `claude-opus-5-5`. |

A missing key never crashes anything: the feature reports "not configured". The Admin page
shows which services are configured.

All keys are read only in server code. Never give them a `NEXT_PUBLIC_` prefix.

### Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Development server on port 3000. |
| `pnpm build` | `prisma generate`, then a production build. |
| `pnpm lint` | ESLint. |
| `pnpm typecheck` | TypeScript without emitting. |
| `pnpm db:migrate` | Applies migrations (`prisma migrate deploy`). Use this on Neon. |
| `pnpm db:migrate:dev` | Creates a new migration after a schema change. |
| `pnpm db:seed` | Runs `prisma/seed.ts`. |
| `pnpm db:studio` | Prisma Studio. |
| `pnpm db:backup` | Writes every table to a JSON file in `data/backups/`. |
| `pnpm test` | Guard tests (see "Guard tests"). |

Server-side scripts, for when nobody is signed in (all take `--env-file=.env`):

| Command | What it does |
| --- | --- |
| `pnpm exec tsx --env-file=.env scripts/create-user.ts "<name>" <email> [admin\|marketer] [ridhi\|cotton-print-club\|both] --out <file>` | Creates a team member with a 24-hour temporary password, written to the file. |
| `pnpm exec tsx --env-file=.env scripts/reset-password.ts <email> --out <file>` | Issues a new temporary password for an existing person and clears their sign-in lockout. |
| `pnpm test:isolation` (after `pnpm build`) | Proves the brand boundaries against the built app; see Security. |
| `pnpm exec tsx --env-file=.env scripts/import-creators.ts "<campaign>" <file.csv> [--check]` | The CSV import of creators, into the named campaign. `--check` reports without writing. |
| `pnpm exec tsx --env-file=.env scripts/import-amazon-listing.ts <brand> <report.xlsx> [--check]` | The Amazon listing report import (see "Products"). |

A real run of a script is logged in the activity log under the Automation account, with the file name marked "(loaded from the server)".

### Deploying to Netlify

Live at https://creator-growth-engine.netlify.app (repository khushijaiswal08/creator-growth-engine).

The site runs on Netlify (Next.js runtime, `netlify.toml`), the database on Neon, with GitHub in
between. Accounts should be in the company's name, not a person's.

1. **GitHub.** Create a private repository and push `main`. Nothing secret is in the repo:
   `.env`, `data/` and backups are git-ignored.
2. **Neon.** The production database is the Neon `production` branch. Use a separate branch
   for local work so testing never touches live data. Run `pnpm db:migrate` against production
   from a machine with the production `.env` before the first deploy and after every schema
   change (migrations are not run by the build).
3. **Netlify.** Add new site > Import an existing project > GitHub > the repository. Netlify
   reads `netlify.toml` (build `pnpm build`, Node 22, the Next.js plugin). Then Site
   configuration > Environment variables: add every variable from the table above for
   Production, including `AUTH_TRUST_HOST=true`, `APP_URL=https://<your site>`,
   `ADDRESS_ENCRYPTION_KEY`, `CRON_SECRET` and the `SMTP_*`/`SUMMARY_EMAIL_*` ones. Leave out
   `SEED_USER_PASSWORD`. Deploy.
4. **Domain and HTTPS.** Domain management > add your domain; Netlify issues the certificate.
   HTTPS only: `netlify.toml` refuses plain HTTP and the app sends HSTS.
5. **Schedules.** `netlify/functions/daily-automations.mts` runs the timers every night and
   `weekly-summary.mts` emails the admin every Monday. Both call the app's own `/api/cron/*`
   routes with `CRON_SECRET`; nothing else can.
6. **Check.** Open `https://<your site>/health` (expect `{"status":"ok","database":true}`),
   sign in, open Creators > Add creator and drag the bookmark to your bookmarks bar, and send
   yourself a product-selection link from a test creator to see the public page.

Function time limit: Netlify runs each request in a function with a 10-second limit (26 on
paid plans). Everyday screens are well inside it. The two big uploads (a 2,000-row creator
CSV, Amazon's listing report) can exceed it on a slow database; the server-side scripts in
"Scripts" do the same job without the limit.

## Security

- **Sign-in rate limit.** 5 failed attempts per email + IP in 15 minutes locks that pair until
  the window passes (`src/lib/login-throttle.ts`, table `LoginAttempt`, which stores only a
  SHA-256 of email + IP). A successful sign-in clears the count.
- **Temporary passwords** are shown once, work for 24 hours, and force a change at first
  sign-in. An expired one is refused; an admin resets it.
- **Session cookie** is `httpOnly`, `SameSite=Lax` and, on HTTPS, `Secure` with the
  `__Secure-` prefix. Sessions last 7 days.
- **Admin routes** are checked on the server three times: the admin layout, every admin page,
  and every admin Server Action. Hiding the Admin link is cosmetic only.
- **Public pages:** only `/login`, `/privacy`, `/terms`, `/health` and the creators' selection
  links. `/health` returns up or down and nothing else.
- **Selection links** (`src/lib/selection.ts`, `src/lib/selection-flow.ts`): a 192-bit random
  token per creator, valid for 14 days, dropped the moment a choice is submitted, and reissued
  fresh when a new link is needed. The page shows only the creator's first name and the
  products; an unknown, expired or used token shows nothing. Opening links is rate limited per
  caller (60 in 10 minutes), misses more tightly (10 an hour) and submissions tighter still
  (5 an hour), in the `RateLimitHit` table, which stores hashed keys only (`src/lib/rate-limit.ts`).
- **Addresses encrypted at rest.** Name, address and phone from a selection are encrypted with
  AES-256-GCM (`src/lib/address-crypto.ts`, key in `ADDRESS_ENCRYPTION_KEY`) before they are
  written, and decrypted only on the gift orders page and in the Amazon order file, both of
  which are limited to the brand's own users. Keep a copy of the key: without it the stored
  addresses cannot be read.
- **Gift order rules** live in `config/gift-rules.json` (country, quantity, price limit, repeat
  window, paid-fee check) and are enforced on the server in `src/lib/gift-rules.ts`. The
  activity log of every order names the rules it passed, or the rule it failed and why.
  Settings shows the current values.
- **Brand isolation is tested against the built app**: `pnpm build` then `pnpm test:isolation`
  (`tests/brand-isolation.test.ts`) signs in as each brand's user and tries the other brand's
  creator, campaign, exports, orders file, admin pages and forged Server Actions. Every attempt
  must be 404 (401 for the schedulers) and leave the database untouched.
- **No self sign-up.** An admin creates users under Admin > Users.
- **A sleeping database is not a wrong password.** Neon puts an unused database to sleep and
  waking it can take longer than Prisma's default 5-second connection limit, so the first
  request after a quiet spell (usually a sign-in) used to fail. The connection strings therefore
  carry `connect_timeout=15` (and `pool_timeout=20` on the pooled one); set the same on Vercel.
  If the check still cannot run, sign-in tries once more and then says so plainly
  (`src/lib/sign-in-errors.ts`) instead of "Email or password is incorrect", and nothing is
  counted towards the lockout.
- **Locked out.** Passwords are stored as one-way hashes and cannot be read back. If nobody can
  sign in to reset a password from the Users screen (for example the only admin forgot theirs),
  run `pnpm exec tsx --env-file=.env scripts/reset-password.ts <email>` on a machine that has
  the `.env`. It issues a 24-hour temporary password and clears sign-in lockouts. Add
  `--out <file>` to write the password to a file and not show it on screen.

## Guard tests

`pnpm test` runs fourteen tests against an in-memory Postgres and local stand-ins for the Meta
and Anthropic APIs:

1. The 30-hashtags-in-7-days rule refuses an over-limit discovery run and makes no call to
   Meta for the refused tags.
2. AI scoring only ever moves `discovered` to `scored`: creators in the other 24 statuses are
   untouched, a creator a person approves mid-run is not overwritten, and a model answer that
   asks for "approved" is ignored.
3. Sign-in locks after 5 failed attempts per email + IP and unlocks after 15 minutes.
4. The daily run schedules follow-ups and closes silent creators on the campaign's timings,
   leaves imported and closed creators alone, logs every change as automatic, and changes
   nothing when run twice.
5. A creator can only choose a product the campaign offers (not sold out, not another brand's,
   not switched off, not hidden as no longer live, not without a link or photo), the link works
   once, and only in-rule orders are auto-approved.
6. The content clock starts at delivery, not dispatch, and a late tracking update never moves
   a creator backwards.
7. Amazon's listing report is read by field name; parents, bundles, used returns,
   merchant-shipped listings and Amazon's duplicates never become products; another label
   arrives switched off; a product someone switched off stays off; products no longer live are
   hidden, not deleted; the other brand's report is refused; a partial report hides nothing; an
   inventory file refreshes stock without wiping anything; a link that is not a web address is
   never stored.
8. The reason a product is or is not offered is the same on screen and in the database filter,
   for every combination of live, switched on, stock and link or photo.
9. A sign-in that could not be checked (the database did not answer) is never reported as a
   wrong password.
10. Someone who works on one brand finds only that brand's campaigns, creators, gift orders,
    products and activity; the other brand's record is not found when opened by id; a creator
    in both brands shows each side only its own work; the sidebar choice never widens anyone's
    view; an unknown brand matches nothing; duplicate warnings never name the other brand's
    creator.
11. No page or action opens a campaign, creator, influencer or gift order by its id alone.
12. The creator import fills blanks and never overwrites, keeps a note it cannot place in the
    activity, puts rows into the chosen campaign, refuses the other brand's campaign, writes
    nothing on a check run, and repeats nothing when run twice.
13. A gift whose content never came is closed as "No content delivered" only after the
    campaign's grace period, logged as automatic, never twice; the track record counts gifts,
    posts and no-shows per brand.
14. A tracking number opens the right carrier's page, and is always encoded.

These prove our own rules hold. They do not show that YouTube, Meta or Anthropic work; that
needs real keys.

## Backups

Neon is the primary backup:

- **Before any risky change**, create a branch: Neon console > your project > Branches >
  Create branch, from `production`, named for example `backup-2026-10-03`. A branch is a full
  copy of the data at that moment and can be restored from or connected to.
- **Point-in-time restore:** Neon console > Branches > production > Restore lets you roll the
  branch back to a moment within your plan's history window.

A second copy you hold yourself: `pnpm db:backup` writes every table to
`data/backups/backup-<time>.json`. The folder is git-ignored; the file contains personal data
and password hashes, so store it somewhere private. Restoring from it means loading the rows
back in the order they appear in the file.

**Weekly backup step (every Monday, five minutes):**

1. Neon console > Branches > Create branch from `production`, named `weekly-<date>`. Delete
   branches older than four weeks.
2. On a machine with the production `.env`: `pnpm db:backup`, then copy the new file from
   `data/backups/` to the company's private drive.
3. Open `/health` on the live site and the Monday summary email; both say the site and the
   schedules are alive.

## How it works

- **One influencer, many profiles.** `Influencer` is the person; `SocialProfile` is unique on
  `(platform, handle)`. Adding a profile that already exists takes you to the existing
  influencer instead of creating a second one.
- **Campaigns.** `CampaignCreator` links an influencer to a campaign, unique on
  `(campaignId, influencerId)`, and carries the status and owner.
- **Activity log.** Every status change and every message writes an `Activity` row in the same
  transaction as the change (`src/lib/activity.ts`). Creation, edits, imports and archiving are
  logged too.
- **No hard deletes.** Influencers are archived, not deleted; foreign keys are `RESTRICT`.
- **Message button.** Pick a template, fill `{name} {handle} {platform} {sender} {product}`,
  and the app copies the text and opens `https://ig.me/m/<handle>` for Instagram or the
  profile page for TikTok and YouTube. Nothing is sent automatically. It logs a `Message` and
  an `Activity`, and moves the status to `contacted` only from `discovered`, `scored`,
  `approved`, `review_later` or `outreach_scheduled`. `{name}` is the first word of the
  influencer's name.
- **Suppression list.** `Suppression` rows (an email, or a platform + handle) are checked when
  the message dialog opens and again when the message is logged. Creators who are suppressed,
  archived, `blacklisted` or `unsubscribed` show "Do not contact" instead of the button.
  Admins manage the list at `/admin/suppression`; blacklisting someone in the review queue
  adds them automatically. Additions and removals are logged with a reason.
- **Roles.** Admins can run discovery and AI scoring and open the Admin screens (templates,
  do-not-contact list, users, sample data). Marketers can do everything else, including
  reviewing creators. There is no self sign-up: an admin creates users, who get a temporary
  password and must change it at first sign-in.

### CSV import

Columns: `handle`, `platform` (both required), `name`, `email`, `followers`, `location`,
`campaign`, `status`, `notes`, `owner_email`. Header names are case-insensitive and spaces
count as underscores. Other columns are ignored and listed in the report.

- Rows are deduplicated on `(platform, handle)`.
- For a profile that already exists, only blank fields are filled; nothing is overwritten.
  The status of a creator already in the campaign is never changed by an import. When the
  file's `notes` cannot be placed because the person already has a different note, the file's
  note is kept as a note in that creator's activity for the campaign (shown with "Imported
  note:"), so nothing in the file is lost and another brand's notes stay where they were.
- A new handle whose `email` matches an existing influencer is added as another profile of
  that influencer.
- `campaign` matches a campaign by name, among the campaigns of the person's own brand. A row
  with no campaign, or an unknown one, goes into the campaign chosen on the form; someone tied
  to one brand must choose one. Without a chosen campaign such a row is still imported, without
  a campaign, and the row says so.
- The same import runs from the server with `scripts/import-creators.ts` (see "Scripts").
- The report lists every row as added, updated or skipped, with the reason.
- Limits: 2,000 rows and 3 MB per file.

## Switching the creator-fetching adapter

All creator data comes through one interface, defined in `src/lib/fetching/types.ts`:

```ts
interface CreatorSource {
  fetchCandidates(brief: Brief): Promise<Candidate[]>;
  enrichProfile(platform: Platform, handle: string): Promise<ProfileData>;
}
```

`getCreatorSource()` in `src/lib/fetching/index.ts` returns the adapter named by the
`CREATOR_SOURCE` environment variable. To switch source, change that variable and redeploy;
no calling code changes.

| `CREATOR_SOURCE` | Adapter | State |
| --- | --- | --- |
| `manual` (default) | `adapters/manual.ts` | Profile URLs pasted by a person. Implemented. |
| `csv` | `adapters/csv.ts` | Rows of a CSV file. Implemented. |
| `youtube` | `adapters/youtube.ts` | YouTube Data API v3. Implemented. |
| `meta_free` | `adapters/meta-free.ts` | Instagram hashtag chain. Implemented; see the caveat below. |
| `vendor` | `adapters/vendor.ts` | Stub. Throws `NotImplementedError`. |

`CREATOR_SOURCE` sets the default used by "Add influencer" (`enrichProfile`). "Run discovery"
lets the admin pick the source per run. The CSV import page always reads the uploaded file.

Sources with quotas also implement an optional `discover(brief)`, which returns the candidates
together with how the run ended (completed, quota reached, not configured, failed).
`fetchCandidates` is unchanged.

To implement a stub, replace the two methods in its file, read any API key from
`process.env` inside that file only, and return `fetchedAt: new Date()` so the profile
records where its data came from.

## Two brands, and who sees which

The portal serves two brands, Ridhi Block Print and Cotton Print Club (`src/lib/brands.ts`). A
campaign belongs to one brand; templates use `{brand}`. A creator belongs to a brand through
the campaigns they are in, and may be in both.

Each person works on one brand or on both (Admin > Users, "Works on"; admins always have both).

- **Someone who works on one brand** sees and changes only that brand's campaigns, creators,
  gift orders and activity, on every screen. Another brand's record opened by its address is
  "not found", and a request that names one is answered as if it did not exist. They can only
  create campaigns for their brand, and a creator they add or import must go into one of their
  campaigns (otherwise it would belong to no brand and they could not see it afterwards).
- **A creator who works with both brands** appears for both, but each side sees only its own
  campaigns, journey and messages with them. The person's own details (name, email, notes) are
  shared. Only someone who sees both brands can archive such a creator. The do-not-contact list
  is one list for both brands.
- **Someone who has both brands** gets a switch in the sidebar to look at one brand at a time.
  That is a way of looking, not a permission.
- The Admin screens (do-not-contact list, message templates, products, users) stay admin-only.

How it is enforced (`src/lib/brand-scope.ts`): `allowed(user)` answers "what may this person
open or change" and `viewed(user)` "what do the lists show right now". Both hand back ready
filters that are spread into the query, so a record outside the brand is simply not found.
Rules for new code:

1. A page or action never opens a campaign, creator, influencer or gift order by its id alone
   (`findUnique`). Use `findFirst` with `...allowed(user).<kind>` in the `where`. A test fails
   the build if this is forgotten.
2. Lists and counts use `viewed(user)`; single records and every change use `allowed(user)`.
3. An unknown brand on an account matches nothing rather than everything.

## The team's day, step by step

How the work used to go by hand, and where each step now lives:

| By hand, in the spreadsheet | In the portal |
| --- | --- |
| Search Instagram for keywords, open profiles, look through who they follow. | Still done on Instagram: the portal cannot search Instagram for you (Meta allows no tool to). Hashtag and YouTube discovery exist for admins once the API keys are set. |
| Check the sheet to see if someone already contacted this person. | **Add or check a creator** (`/influencers/new`): paste the profile link, or click the bookmark on the profile itself, and the portal says whether anyone here knows them, in which campaigns, with what outcome, and whether they ever took a gift without posting. |
| Send the first message; note it in the sheet. | **Message** button: pick a template, the text is copied and the DM window opened; the portal logs it and moves the creator to Contacted. Follow-ups come due by themselves. |
| Send the product list; the creator picks; note the address. | **Selection link** in the message: the creator picks from live, in-stock products with photos and enters their address; the gift order is approved by the rules or waits for a person. |
| Place the MCF order on Amazon and copy the details across. | **Gift orders > Amazon order file**: one file per brand with every approved order, uploaded to Seller Central as it is. |
| Find the tracking number, search the carrier site, update the sheet. | Upload Amazon's **Fulfilled Shipments report** under "Update tracking in bulk" (or paste rows): order numbers and tracking fill in for every order at once. Each order has **Track parcel** and **Mark delivered today**. The work queue lists "Deliveries to check". |
| Follow up for content; most creators never post. | The content clock starts at delivery: reminder due, then overdue, in the work queue. After the campaign's grace period the creator is closed as **No content delivered** by itself, which shows as a warning on their page, in the review queue and on the check screen the next time anyone considers them. |
| Keep the whole record in Excel. | Every campaign has **Export CSV**; the dashboard shows gifts versus content for the brand. |

The bookmark and the selection links only work for the team from their own computers once the portal is online (see "Deploying to Vercel").

## The automated journey

Every open creator always has a **next action** with a date (`src/lib/next-action.ts`). The
**Today** (`/today`) lists who needs a person today, grouped by what to do, with the gift and content figures in one line; everything else moves by itself.

| Step | What happens without anyone doing it | What a person does |
| --- | --- | --- |
| Outreach | After the campaign's wait with no reply, the creator becomes "Follow-up due"; after the last follow-up and another wait, "No reply". | Clicks Message (DMs cannot be sent by a tool). |
| Reply | Status, collaboration type and next step follow from the reply class. | Picks what the creator said. |
| Product | The creator opens their private link (`/select/<token>`), picks from in-stock giftable products of the brand, best-stocked first, and enters their address. | Nothing. |
| Approval | Approved automatically when it is a US address, one item, no other gift in 90 days, and no unapproved fee. | Approves only the exceptions. |
| Order | Approved orders are collected into one Amazon bulk file. | Uploads the file to Seller Central. |
| Shipping | Order number, tracking and delivery date move the creator on. | Pastes Amazon's tracking rows in bulk. |
| Content | The content clock starts at the **delivery** date: reminder due, then overdue. After the campaign's grace period (30 days by default) with still nothing, the creator is closed as "No content delivered". | Sends the reminder; records the post. |

What the automation may and may not do:

- It only changes a status on a timer (Contacted to Follow-up due, Contacted to No reply,
  Content expected to No content delivered) or when a creator acts (product chosen). It never
  contacts anyone and never approves a creator.
- Every automatic change is logged with `automated = true` under a built-in "Automation"
  account that cannot sign in, so a manager can tell it from a person's action.
- Creators imported without a "last contacted" date are never timed out: the portal does not
  guess when they were messaged.
- Waiting periods are per campaign (admin, "Automation settings" on the campaign page).

It runs once a day through Vercel Cron (`vercel.json` calls `/api/cron/automations`, guarded by
`CRON_SECRET`), whenever someone opens Today and it has not run for six
hours, and on "Refresh now".

**Products.** Admin > Products holds both brands' catalogues, matched on SKU. Three kinds of
file can be uploaded there:

- **Amazon's Category Listing Report** (the `.xlsx` from Seller Central, unchanged). The browser
  opens the workbook and sends only the columns the portal uses, found by Amazon's field names
  (`src/lib/amazon-listing.ts`), so column order does not matter. Only listings that are Active,
  new and shipped by Amazon become products. Left out: group headings (parents), bundles and
  drafts, inactive and removed listings, Amazon's resale of returned items (`amzn.gr.*`),
  listings not fulfilled by Amazon, and Amazon's own duplicate SKUs (`Amazon.Found.*`). Names,
  photos, links, prices, colours and sizes are refreshed; stock and website links are not in
  this report and are left alone. Stored products that are no longer live are hidden
  (`archived`), never deleted, and come back when a later report shows them live. The other
  brand's report is refused.
- **An Amazon inventory file** (`.csv` or tab-separated `.txt`) to refresh stock: its SKU and
  quantity columns are recognised. SKUs the list does not have are left out.
- **Your own CSV**: sku (required), asin, title, listing_name, color, size, price, stock,
  website_url, image_url, giftable. Empty cells never wipe a stored value.

`title` is the short product name creators choose from ("Tablecloth"), derived from Amazon's
product type; `listingName` is the listing's full name. A creator is shown a product only when
it is live on Amazon, switched on (`giftable`), not sold out, and has a link or photo to look
at (`src/lib/product-list.ts`, the single place that decides this). New listings sold under
another label from the same Amazon account (`otherLabels` in `src/lib/brands.ts`) arrive
switched off. Whether a product is offered is the team's choice: the import never changes it
for a product that already exists. Switch products on or off one at a time or for a whole
search on the Products screen; each change is logged.

The same import can be run from the server, with `--check` to see the result without writing:
`pnpm exec tsx --env-file=.env scripts/import-amazon-listing.ts <ridhi | cotton-print-club> <report.xlsx> [--check]`.

On the creator's selection page the choice is product, then print or colour (with photos),
then size; where several listings share all three (plain, ruffled and scalloped versions of a
cover), the creator picks between them, so none is ever chosen for them. Photos are the
listing photos on Amazon's image server, requested at thumbnail size.

**Amazon orders.** Gift orders > "Amazon order file" lists every approved order of one brand
with our reference (`CGE-...`) as the order id. There is one file per brand
(`/orders/export?brand=<id>`) because each brand ships from its own Amazon account; a file
never mixes the two. The column names follow Amazon's Multi-Channel
Fulfillment bulk template as documented; check them against the template in Seller Central
before the first upload. Paste Amazon's order numbers, tracking and delivery dates back under
"Update tracking in bulk", matched on that reference.

**Gifts from before the portal.** Shipments the team recorded in their old sheets were loaded
as gift orders too (one per ASIN, status shipped, or delivered where the sheet showed content
posted). Those orders carry the line "Address not recorded" instead of an address and have no
tracking number: the sheet had neither. "Mark delivered today" or the Amazon Fulfilled
Shipments report completes them. The note on each creator says which sheet the gift came from.

**Not built yet:** sending email, reading replies automatically, AI reply sorting, Shopify
sync, carrier tracking feeds, comment queues, sales attribution and ROI, repeat-collaboration
scoring.

## Phase 1 discovery and scoring

Nothing in this section contacts a creator. Discovery finds people, scoring recommends, and a
person decides in the review queue.

### Running a discovery

1. Open a campaign that has niche keywords (admin only; the Discovery panel is hidden from
   marketers).
2. Choose a source and click **Run discovery**.
3. The summary shows **found**, **new**, **already known** and **skipped**. New creators are
   added to the campaign as `discovered` and are linked to the run that found them.

Rules:

- Candidates are deduplicated on `(platform, handle)` against every profile in the system.
  Someone already known is counted as "already known" and is not added again.
- Anyone on the do-not-contact list is skipped.
- Negative keywords are excluded from the search and matching results are dropped.
- Every run is saved as a `DiscoveryRun` with its status, counts, quota used and a note.

**YouTube.** One `search.list` call per niche keyword (at most 5 per run, 100 quota units
each), then `channels.list` and the uploads playlist (1 unit each) for subscribers,
description, country and the latest upload. The default quota is 10,000 units a day. When
Google reports the quota is exhausted the run stops cleanly, keeps what it has, and is saved
with the status "Stopped: quota reached".

**Instagram (Meta).** Hashtag Search, then oEmbed for the author, then Business Discovery for
stats. Requirements: a Meta app approved for "Instagram Public Content Access",
`META_ACCESS_TOKEN` and `IG_BUSINESS_ID`.

- **Caveat.** Since 3 November 2025 Meta's oEmbed response no longer contains
  `author_name`. The adapter reads it when present and otherwise looks for the handle in the
  embed HTML. Posts whose author cannot be read are counted as skipped and the run note says
  so. This adapter has only been tested against recorded example responses, not live.
- An account that is not a professional (business or creator) account is recorded without
  stats and marked "Not a professional account".
- An expired token is reported as a failed run with a note, not a crash.

### The 30-hashtag rule

Instagram allows one business account to query at most 30 different hashtags in any rolling
7 days. The app enforces this itself, in the `Hashtag` table (`tag`, `firstUsedAt`):

- Before a hashtag is queried, the app counts the tags first used in the last 7 days.
- A tag already used inside the window is free to query again.
- A tag that would be the 31st is refused. The run continues with the other tags and the
  run note names the refused tag.
- A run uses at most 5 hashtags, one per niche keyword ("home decor" becomes `#homedecor`).

The Admin page shows how many of the 30 are in use and which tags they are.

### AI fit scoring

"Score discovered creators" (admin only, on the campaign page and the review queue) scores
every creator in the campaign who is `discovered` and has no assessment yet.

- **What is sent to Anthropic:** the campaign brief, niche and negative keywords, and for each
  profile the platform, followers, engagement rate, country, last post date, website, bio and
  recent captions, plus the location on file and whether an email exists. Names, handles and
  email addresses are not sent; addresses inside a bio are replaced with `[email]`.
- **Weights:** relevance 30, US audience or location 20, engagement 15, content quality 15,
  contact availability 10, brand safety 10.
- **Output:** strict JSON `{score, usSignal, reasons[]}`, validated before saving. The reasons
  are stored verbatim in `FitAssessment` with the model and prompt version.
- **Email status** (`found` / `not_found`) is set by the app, never by the model: found means
  an address is stored or is literally written in a bio.
- **Rules:** every scored creator moves from `discovered` to `scored`. A score of 75 or more
  also sets `priorityReview`. A score under 40 is shown with a "Low fit" tag. The job never
  sets any status past `scored` and never approves anyone.
- **How it runs:** 12 creators per batch, 3 at a time; the SDK retries rate limits and server
  errors with backoff; an invalid answer is asked for once more. A creator that still fails
  stays `discovered`.
- **Usage:** each run is a `ScoringRun` with creators scored, failures, requests and input and
  output tokens. Multiply the tokens by Anthropic's current prices for the cost.
- **Model:** `ANTHROPIC_MODEL`, default `claude-opus-5-5`. Change `PROMPT_VERSION` in
  `src/lib/scoring.ts` whenever the prompt changes.

### Review queue

`/campaigns/[id]/review` lists creators that are `discovered` or `scored`, priority reviews
first, then by score. Approve, Reject, Review later and Blacklist each write an Activity entry.
Keys **A**, **R** and **L** act on the highlighted card and move to the next. Blacklist asks
for a reason and adds the person's handles and email to the do-not-contact list. A card warns
when a handle on another platform looks like the same name (within 2 edits; handles shorter
than 6 characters must match exactly). "Export CSV" downloads the list with the current
filters.

## Project layout

```
prisma/            schema, migration, seed
src/auth.ts        Auth.js with the credentials provider
src/auth.config.ts edge-safe half of the config, used by the middleware
src/middleware.ts  redirects signed-out visitors to /login
src/actions/       Server Actions (all mutations)
src/app/           routes: login, campaigns, influencers, import
src/components/    screens' components; ui/ holds shadcn/ui
src/lib/           status rules, URL parsing, templates, CSV parsing, activity log
src/lib/fetching/  the creator-fetching interface and its adapters
src/lib/discovery.ts, scoring.ts, review-queue.ts, hashtag-quota.ts   Phase 1 logic
```

## Known warnings

- `pnpm build` prints "A Node.js API is used ... not supported in the Edge Runtime" for the
  `jose` package. It comes from Auth.js inside the middleware and is harmless.
- Prisma prints that `package.json#prisma` is deprecated. It still works in Prisma 6 and is
  where the seed command is configured.
