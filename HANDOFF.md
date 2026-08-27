# Handoff

State of the `feature/vite-redesign-and-actions` branch, what is needed to put a
first version live, and what was deliberately left undone.

Written 2026-08-27. Twelve commits, `main..HEAD`. 37 Python tests and 39
frontend tests pass; `npm run build` is clean.

## What changed, in one paragraph

The page moved from a Parcel bundle with `data.json` compiled into the
JavaScript to a Vite build that fetches `data.json` at runtime. That is the
structural change everything else depends on: refreshing prices no longer means
rebuilding and re-uploading the bundle, so a data refresh and a code deploy
became independent workflows. On top of that: a visual redesign, cheapest-time-
to-run recommendations for four household loads, a corrected tariff, a hardened
fetcher, GitHub Actions deployment to S3 behind CloudFront, and Terraform for
the AWS side.

## Before anything else: the tariff numbers changed

The page had been **understating the real price by 0.2248 c/kWh during the day
and 0.1423 c/kWh at night**. Three unrelated drifts, none caught because each
rate was stored with VAT baked in:

- Electricity tax and the security-of-supply fee were still grossed up at 24 %
  VAT, never re-derived when VAT rose to 25.5 % in September 2024.
- The security-of-supply fee itself rose from 0.013 to 0.085 c/kWh on
  2026-04-01 — the largest single correction.
- The transfer tariff is 2.63 / 1.13 c/kWh ex-VAT, not what the old inclusive
  figures implied.

The supplier margin was already correct at 0.50 c/kWh incl. VAT. It *looked*
wrong (0.40 × 1.24 = 0.496 ≈ 0.50), which is why every constant was checked
against a published source rather than reasoned about.

This lives in commit `4f8bd8b`, which touches nothing but the constants and the
values pinned in `front/test/tariff.test.js`. **If the new endpoint's prices are
ever compared against the old page's, they must differ by exactly those two
amounts and nothing else.** Any other delta means something unintended crept in.

## To deploy

### 1. AWS, by hand, with an admin profile

```bash
cd infra
export AWS_PROFILE=your-admin-profile
terraform init
terraform plan          # read this
terraform apply
terraform output github_configuration
```

Terraform needs your own credentials, not the deploy role — that role is scoped
to S3 on one bucket and cannot create itself.

**`terraform validate` has never been run.** Terraform was not installed on the
machine this was written on. Every file parses as valid HCL2 and the resource
shapes were checked by hand and by a review pass, but provider-schema validation
has not happened. Read the first plan carefully, and run `terraform fmt` — the
alignment is approximate.

Everything targets a **new** bucket and distribution. The existing
`semeai-energy` bucket, its distribution and its URL are outside the
configuration; the deploy role has no access to them at all.

### 2. Repository configuration

Set what `terraform output github_configuration` prints: `AWS_ROLE_ARN`,
`SEMERG_ENTSOE_TOKEN`, `SEMERG_FINGRID_TOKEN` as secrets; `AWS_REGION` and
`S3_BUCKET` as variables.

Then check **Settings → Actions → Workflow permissions** is "Read repository
contents", and that scheduled-workflow failure email is set to *only* notify on
failure — `refresh-data` runs hourly, so the wrong setting is ~730 emails a
month.

### 3. Merging — read this first

**Merging to `main` breaks the existing app-server cron.** It runs
`semerg gather-data --output front/src/data.json` and then Parcel. That path is
no longer read and Parcel is gone, so the build would succeed and emit a page
whose `data.json` 404s — the old site would show its error banner while the new
endpoint is not yet up.

One word in the crontab or `update-page.sh` avoids this:

```bash
semerg gather-data --output front/public/data.json
```

`vite build` copies `public/` into `dist/`, so the old pipeline keeps working
otherwise — and the old URL gets the redesigned page immediately. Doing this
first decouples the merge from the AWS work.

To deploy from the branch before merging, add its ref to `allowed_git_refs` in
`infra/terraform.tfvars`, apply, test, then remove it. Do not use
`repo:owner/repo:*` — this is a public repository.

### 4. Soak, then cut over

The plan originally called for deploying *unchanged* code first, so the new
endpoint would be byte-identical to the old and any later difference would be
attributable to the reviewed tariff correction alone. That never happened —
the AWS side was not ready, so the work went straight to the rewrite. **That
clean baseline is not available.**

The substitute: at any timestamp, the new page's "Your price" should exceed the
old page's "Actual price" by exactly **+0.2248 c/kWh** between 07:00 and 22:00
and **+0.1423 c/kWh** otherwise. Check two or three timestamps either side of
the 07:00 boundary once both are live.

Then repoint DNS or the origin — reversible in minutes. Keep the old bucket and
the cron *disabled but not deleted* for about a week before retiring: delete the
crontab entry and `update-page.sh`, revoke the `semeai-energy` IAM user's keys,
empty the old bucket.

Keep the `~/.semerg/config` fallback in the Python permanently. It is what lets
local runs work without exporting secrets.

## Known gaps

### Kiosk behaviour — the largest cluster

Assuming a tablet left showing the page. Untested on real hardware; these come
from reading the code paths.

1. **Everything clock-dependent is coupled to a successful fetch.** `refresh()`
   in `front/src/main.js` is a single `try` block, so a failed fetch skips
   `renderHeader`, `view.update()` and `renderTasks()` alike. The red "now"
   marker therefore **freezes at the last successful fetch and then lies** —
   lose the network at 14:00 and at 20:00 the marker still reads 14:00, with
   recommendations computed against it. The error banner shows, but a frozen
   clock reads as a working one. Fix: advance the clock on its own timer,
   independent of fetch outcome.

2. **Nothing refreshes on wake.** No `visibilitychange`, `pageshow`, `focus` or
   `online` listener exists. Browsers throttle `setInterval` in background tabs
   and iOS suspends timers with the screen off; a suspended interval does not
   catch up. Roughly one line to fix.

3. **A kiosk will never pick up a new deploy.** This is a regression. The old
   page carried `<meta http-equiv="refresh" content="600">`, which reloaded
   every ten minutes and so pulled new bundles. It was removed — correctly,
   because a blanket reload discards UI state — and nothing replaced it.
   `index.html` is served with `max-age=60` but **the page never re-requests
   it**. A tablet running for months keeps executing its day-one bundle. Fix:
   poll `index.html` or a small `version.json` and reload when the asset hash
   changes.

4. **The task cards are rebuilt every five minutes**, via `replaceChildren()`.
   Harmless on a kiosk; on a phone it discards focus and a partly typed
   duration.

Also: the page requests no Wake Lock, so the screen sleeps on the OS's schedule.

### Deployment and infrastructure

- **TLS 1.0 and 1.1 stay enabled and cannot be turned off.** The default
  `*.cloudfront.net` certificate pins the distribution to CloudFront's `TLSv1`
  security policy, and the API rejects `minimum_protocol_version` alongside it.
  Scanners flag this correctly. The only fix is the custom domain — which is
  also the cutover step. See `infra/README.md`.
- **No dead-man's switch.** `keepalive.yml` handles GitHub's 60-day
  auto-disable of scheduled workflows, but nothing alerts you if the hourly
  refresh simply stops. The page's own "Updated …" line is the only signal.
- **Actions are pinned to older majors.** `checkout@v4`, `setup-node@v4`,
  `setup-python@v5`, `configure-aws-credentials@v4` — all pinned to verified
  SHAs, but v6–v8 now exist. Pinned within the existing majors deliberately
  rather than upgrading blind, since the workflows cannot be tested from here.
- **`refresh-data.yml`'s publish job runs `pip install -e .`** while holding
  `id-token: write`. Accepted because it executes only first-party code plus
  click and requests, unlike the frontend's dependency tree. Noted in the
  workflow.
- **Whether a bot commit actually resets the 60-day scheduled-workflow timer**
  is assumed, not verified. Worth confirming empirically.

### Product

Deferred by design, each additive rather than a rewrite:

- **Carrier/DSO selection.** `front/src/tariff.js` already separates supplier,
  network operator and national taxes, and time-of-day logic sits behind
  `rateAt()`. Promote these to registries keyed by id; a seasonal or
  time-of-use product becomes a new `rateAt` kind with no caller changes.
- **User-entered tariff rates**, via the same store. Still `localStorage`, still
  no accounts.
- **Custom tasks.** The preset array in `tasks.js` becomes a persisted list.
- **Appliance load curves.** Costs assume constant draw; a dishwasher
  front-loads its heating element and a sauna stove duty-cycles. Modelling this
  needs per-appliance curves and would not change which window wins, so the
  page says so in a footnote instead.

## Things not to undo

Each of these cost something to find.

- **`front/src/tariff.js` stores rates ex-VAT and applies VAT once.** Storing
  inclusive figures is exactly what let the rate drift for over a year. Where a
  source publishes an inclusive number, derive it with `exVat(value, rate)` so
  the published figure stays visible and the rate it was quoted at is pinned.
- **Tariff times use `Europe/Helsinki` explicitly, never the browser's zone.**
  The day/night boundary previously used `Date#getHours()`, which was harmless
  in Finland and wrong everywhere else. `vite.config.js` pins `TZ=UTC` for tests
  so this cannot regress unnoticed.
- **The chart tooltip uses a custom `nearestByTime` interaction mode.** Chart.js's
  built-in `index` mode aligns series by array position, not timestamp; Entso-E
  omits repeated prices, so the price series carries gaps the Fingrid series do
  not. Do not "simplify" this back to `index`.
- **`install_log_redaction()` hooks the log record factory, not a
  `logging.Filter`.** A filter attached to a logger does not see records
  propagating up from child loggers, and urllib3 logs retry warnings — full URL,
  Entso-E token in the query string — from `urllib3.connectionpool`. The
  redaction was inert for exactly that case. There is a regression test.
- **Never put `id-token: write` in a job that runs third-party code.**
  `permissions` is job-scoped, so any step in such a job can mint its own OIDC
  token; step ordering does not help.
- **Superseded bundles are pruned at deploy time, never by age.** Assets are
  content-hashed, so each deploy writes new keys rather than new versions, and
  with infrequent deploys the live bundle soon becomes the *oldest* object under
  `assets/`. An S3 lifecycle rule or scheduled job would eventually delete it.
- **The deploy sync omits `--delete`**, so an `index.html` still in a cache
  keeps resolving the JS it references.

## Orientation

```
src/semerg/          Python CLI; entry point semerg.main:cli
tests/               pytest
front/src/           tariff.js, schedule.js, tasks.js, chart.js, main.js
front/test/          vitest
infra/               Terraform: bucket, CloudFront, deploy role
docs/deployment.md   How deployment works and why
AGENTS.md            Conventions and invariants for agents
```

`npm run dev --prefix front` works without API tokens: `public/data.json` is
gitignored and seeded from a committed sample, with its timestamps shifted onto
today so the page has a present and a tomorrow to show. Seeded files are tagged
and regenerated when stale; real fetched data is never overwritten.
