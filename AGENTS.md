# AGENTS.md

Instructions for AI agents working in this repository. Human contributors may
find it useful too.

## What this project is

`semerg` aggregates Finnish electricity data into a single `data.json` and
renders a static page around it:

- **Prices** — Nord Pool day-ahead prices via the ENTSO-E Transparency Platform.
- **Production** — wind actuals, wind forecast and solar forecast via Fingrid.

The output is a static page on S3 behind CloudFront. There is no backend at
runtime: everything the page needs is `index.html`, a hashed JS bundle, and
`data.json`.

## Layout

```
src/semerg/          Python CLI. Entry point: semerg = semerg.main:cli
tests/               pytest suite for the Python side
front/               Frontend: Vite, Tailwind, Chart.js. Tests in front/test/
infra/               Terraform for the bucket, CloudFront and the deploy role
docs/deployment.md   How the deployment works and why
.github/workflows/   CI and deployment
```

Build output lives in `front/dist/` and is **not** committed. Note that the bare
`dist/` pattern in `.gitignore` matches at *any* depth, which is why both
`front/dist/` and the top-level `dist/` are ignored.

## Commands

```bash
python -m venv ve && . ve/bin/activate
pip install -e '.[dev]'
pytest                       # Python tests
```

```bash
cd front
npm ci
npm run dev                  # local dev server
npm run build                # production bundle into front/dist/
npm run preview              # serve the built bundle
npm test                     # Vitest
```

Both `pytest` and `npm test` must pass before anything is merged.

## Branches and pull requests

Work lands on `main` through a pull request from a feature branch, named
`feature/<short-description>`. Never commit to `main` directly, and never push
a branch's work by fast-forwarding `main` onto it.

```bash
git switch -c feature/update-dependencies
```

This is a deployment rule as much as a review one. `deploy-site.yml` triggers on
pushes to `main`, and the deploy role's trust policy is scoped to
`refs/heads/main` (`github_oidc_subjects` in `infra/variables.tf`). A commit
pushed straight to `main` is a production deploy that nobody reviewed.

CI runs on every branch, so a PR arrives with `pytest` and `npm test` already
green.

**Agents do not open pull requests.** There is no `gh` and no API token on the
machine, and opening one is a human decision. An agent takes the work to the
point where a PR is one click away:

1. Commit to a feature branch and push it.
2. Write the description to `pr-description.md` in the repository root
   (gitignored, one branch's worth at a time): what changed, why, and what a
   reviewer should check. Keep it scannable.
3. Report the compare link, which opens the form prefilled:
   `https://github.com/sjlehtin/semerg/compare/main...<branch>?expand=1`

## Secrets

Tokens are read from environment variables first, falling back to a TOML file at
`~/.semerg/config`:

```
SEMERG_ENTSOE_TOKEN
SEMERG_FINGRID_TOKEN
```

```toml
[entsoe]
security-token = "..."

[fingrid]
authentication-token = "..."
```

The config-file fallback exists so local development works without exporting
secrets into the shell. **Keep it.** CI uses the environment variables.

Never commit tokens. `front/public/data.json` is gitignored because real fetches
land there during development; `front/public/data.sample.json` is the committed
fixture.

**Never log the ENTSO-E token.** It is passed as a *query parameter*, so it
appears in `response.url`. This repo is public and its Actions logs are
world-readable — redact explicitly in every error, retry and debug path.

## The data contract

`semerg gather-data` writes one JSON object:

| Field | Meaning |
|---|---|
| `fetchTime`, `startTime`, `endTime` | ISO 8601 UTC |
| `priceResolutionMinutes` | grid spacing of `basePrices` |
| `basePrices` | `[{startTime, price}]` — **c/kWh, excluding VAT and all fees** |
| `windProduction`, `windProductionForecast`, `solarProductionForecast` | `[{startTime, energy}]` — **MW** |

Two things about this data that are easy to get wrong:

- **ENTSO-E returns a sparse series.** It uses `curveType A03`, where a price
  point is implicitly valid until the next one, so consecutive equal prices are
  omitted from the response. `pull_entsoe_data` densifies it using each
  `Period`'s declared `<resolution>` and `timeInterval/end`, expanding
  **everything to a single uniform 15-minute grid** — not per-period, because a
  document can mix `PT60M` and `PT15M` periods (and `P1D` exists). Downstream
  code may therefore assume uniform 15-minute spacing across the whole series,
  but only because the parser guarantees it. Don't remove that.
- **The series can extend outside the requested window**, starting earlier than
  `startTime`. Production data is deliberately re-based on the first price point
  to match.

Prices in the API response are EUR/MWh; the parser converts to c/kWh.

## Where the tariff lives

All pricing components live in `front/src/tariff.js` and nowhere else. Never
inline a rate into chart or scheduler code. `priceFor(basePrice, isoTime)` is the
single entry point, used by both the chart's "Actual price" series and the
scheduler, so a recommendation and the plotted line can never disagree.

The module keeps the three parties conceptually separate, because in Finland they
are separately chosen:

- **national** — VAT, electricity tax, security-of-supply fee.
- **supplier** — the retailer's margin on spot.
- **transmission** — the DSO's transfer fees. Time-of-day logic lives here,
  behind `rateAt(dateTime)`.

Rules:

- **Time-of-day rates are evaluated in `Europe/Helsinki`, never browser-local.**
  Using `Date#getHours()` for a tariff boundary is a bug even though it happens
  to work for a user sitting in Finland. Use Luxon so DST is handled for you.
- **Store components ex-VAT** and apply the rate once.
- **Changing a published number is a deliberate, separately reviewed commit.**
  This tool tells someone what their electricity actually costs. A rate change
  must never ride along inside a refactor — restructure against a
  characterisation test first, then change the numbers in a commit that does
  nothing else, so the numeric diff is visible in review.
- Verify rates against primary sources (the supplier's price list, the DSO's
  tariff, vero.fi) — never by reading them back out of this code. The constants
  have been wrong before: they were left at 24 % VAT when the rate changed to
  25.5 % in September 2024.

No user data leaves the browser. Profiles and task settings are `localStorage`
only — there are no accounts and no server-side storage, by design.

## Deployment

Two independent GitHub Actions workflows, because `data.json` is fetched at
runtime rather than bundled:

- `deploy-site.yml` — on code changes. Builds and uploads the bundle.
- `refresh-data.yml` — hourly. Uploads only `data.json`.

Invariants that are easy to break and expensive to debug:

- **Freshness comes from `Cache-Control: max-age=60`, not from invalidation.**
  There are no CloudFront invalidations and the deploy role has no CloudFront
  permissions. Hashed assets under `assets/` are served `immutable`.
- **Never add `--delete` to the S3 sync.** Old hashed bundles are retained on
  purpose so that an `index.html` still sitting in a cache keeps resolving the JS
  it references. Superseded assets are pruned **at deploy time**, by a step that
  deletes old assets the freshly-built `index.html` does not reference. Never do
  this on a schedule or with an age-based lifecycle rule: assets are
  content-hashed, so each deploy writes new keys rather than new versions, and
  with infrequent deploys the live bundle soon becomes the oldest object in the
  prefix.
- **A site deploy must never overwrite `data.json`** — it is owned by the refresh
  workflow, which usually has fresher data. Hence the `--exclude`.
- **Keep the `data.json` schema backward-compatible.** Assets are `immutable`
  and the page no longer reloads itself, so a long-open tab pairs an old bundle
  with new data. New fields must be optional with a fallback on both sides.
- **Never publish an unvalidated `data.json`.** `--output` truncates its target
  file on open, so a failed fetch leaves a partial file behind. The refresh
  workflow validates before uploading.

The AWS side is Terraform in `infra/`, applied by hand with an admin profile —
the deploy role is scoped to S3 on one bucket and cannot create itself. Do not
widen it to make CI able to apply.

Two workflow rules that are easy to undo by accident:

- **Never put `id-token: write` in a job that runs third-party code.**
  `permissions` is job-scoped, so any step in such a job can mint its own OIDC
  token and assume the deploy role — step ordering does not help. `npm ci`,
  `npm test` and `npm run build` belong in a job with no `id-token`, handing
  their output to a publish job over an artifact.
- **Pin every action to a full commit SHA**, with the version in a trailing
  comment. Tags are mutable.

## Releases

- `src/semerg/__init__.py` and `front/package.json` versions move **together**.
- `ChangeLog.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## Conventions

- Match the surrounding style rather than introducing a new one; the codebase is
  small and deliberately plain.
- Prefer fixing the cause over adding a workaround, and say so in the commit
  message when behaviour changes.
- **Comments describe the code as it stands**, not how it got there. A comment
  earns its place by explaining a live constraint or a non-obvious why. What a
  function used to do, what a value used to be, which approach was tried first
  — that belongs in the commit message and the ChangeLog, which is where
  someone goes when they want the history.
- **Keep commit messages short.** Subject line, and a body only where the diff
  genuinely does not speak for itself. State the current reason; skip the
  narrative of what was wrong before.
