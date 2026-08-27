# Deployment

The site is static: an `index.html`, a content-hashed JS bundle, and
`data.json`, served from S3 behind CloudFront. Three GitHub Actions workflows
keep it current.

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | push, PR | `pytest`, `npm test`, and builds the bundle as a guard |
| `deploy-site.yml` | push to `main` touching `front/**`, manual | Builds and uploads the bundle |
| `refresh-data.yml` | hourly at `:07`, manual | Fetches and uploads `data.json` |

## TL;DR

**First time:**

```bash
cd infra && terraform init && terraform apply
terraform output github_configuration    # set these on the repository
```

Then set the two secrets and two variables it prints, and check
Settings → Actions → Workflow permissions is "Read repository contents".

**Day to day:** nothing. Prices refresh hourly on their own. Merging to `main`
with changes under `front/**` rebuilds and redeploys the page.

**To publish a code change:** merge to `main`. To force one, run *Deploy site*
from the Actions tab.

**To force a data refresh:** run *Refresh data* from the Actions tab.

**When something looks stale**, check in this order:

| Symptom | Look at |
|---|---|
| Prices not updating | *Refresh data* runs; the page's own "Updated …" line |
| Page looks old after a merge | Did the change touch `front/**`? Only that path triggers a deploy |
| `AccessDenied` XML at `/` | Distribution's Default Root Object — should be `index.html` |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | Deploying from a branch, or the repository was renamed — see below |
| Nothing has run for weeks | Scheduled workflows auto-disable after 60 days of repository inactivity |

**Two rules that are load-bearing**, explained further down: never put
`id-token: write` in a job that runs third-party code, and never prune old
bundles by age.

## One-time AWS setup

The AWS side is Terraform, in [`infra/`](../infra/). That directory's README
covers running it; this section explains the decisions it encodes, since a
`.tf` file records *what* was built but not *why*.

```bash
cd infra
export AWS_PROFILE=your-admin-profile
terraform init && terraform apply
terraform output github_configuration
```

Everything targets a **new** bucket and distribution. The existing
`semeai-energy` bucket, its distribution and its URL are outside the
configuration and untouched, so nothing here can affect the live page.

### Why the role is scoped the way it is

The trust policy pins the subject to `repo:sjlehtin/semerg:ref:refs/heads/main`,
not `repo:sjlehtin/semerg:*`. The wildcard matches every branch, tag and
pull-request context — and this is a public repository, so it would let a pull
request opened by anyone assume a role that can delete objects.

The permissions policy grants S3 only, on the new bucket only:

```
s3:ListBucket                                arn:aws:s3:::<bucket>
s3:GetObject, s3:PutObject, s3:DeleteObject  arn:aws:s3:::<bucket>/*
```

Note the two different ARN shapes — `s3:ListBucket` acts on the bucket itself,
object actions need the `/*` suffix. A policy granting object actions on the
bare bucket ARN grants nothing and fails at upload time. `s3:GetObject` is
needed because `aws s3 sync` compares against what is already there, and
because the refresh workflow downloads the published `data.json` to check it is
not about to regress.

Deletion is granted **only on `assets/*`**, because the prune step is the only
thing that deletes and it only ever touches hashed bundles. A compromised
workflow therefore cannot remove `index.html` or `data.json` — it cannot blank
the site, only cost it a rebuild.

`s3:PutObjectAcl` is deliberately absent: the bucket is `BucketOwnerEnforced`,
so ACLs do not exist and granting it would be pure surface.

**No CloudFront permissions**, because there are no invalidations. **No access
to the old bucket**, which makes running both services in parallel structurally
safe rather than safe by care.

The trust policy also asserts `repository_owner_id`. The subject is built from
names, and names can be reassigned; the owner ID cannot. See `infra/README.md`
for the related fact that renaming the repository will break the trust policy
outright.

Every workflow that touches AWS needs:

```yaml
permissions:
  id-token: write
  contents: read
```

Omitting `id-token: write` is the most common OIDC first-run failure.

### Things that bite

- **Default Root Object.** Set to `index.html` by the Terraform. Without it,
  `https://<host>/` returns an S3 `AccessDenied` XML document rather than the
  page — which looks like a permissions problem and is not.
- **One OIDC provider per account.** If another project already registered
  `token.actions.githubusercontent.com`, set `create_oidc_provider = false` and
  the existing one is looked up instead.
- **Terraform needs your own credentials**, not the deployment role — that role
  cannot create itself, and widening it enough to do so would defeat the point.

### Repository configuration

`terraform output github_configuration` prints these filled in.

| Secret | Value |
|---|---|
| `AWS_ROLE_ARN` | from the Terraform output |
| `SEMERG_ENTSOE_TOKEN` | Entso-E Transparency Platform web API token |
| `SEMERG_FINGRID_TOKEN` | Fingrid open data API key |

| Variable | Value |
|---|---|
| `AWS_REGION` | from the Terraform output |
| `S3_BUCKET` | from the Terraform output |

## Why the deploy workflows are split into two jobs

`permissions:` is **job-scoped**, so every step in a job holding
`id-token: write` has `ACTIONS_ID_TOKEN_REQUEST_URL` and
`ACTIONS_ID_TOKEN_REQUEST_TOKEN` in its environment — and anything that can read
those can request its own OIDC token and assume the deploy role directly.

Ordering the steps does not help. Putting `npm ci` before
`configure-aws-credentials` stops a dependency stealing credentials that already
exist, but not one minting its own. So the jobs that run third-party code —
`npm ci`, `npm test`, `npm run build` — have **no `id-token` at all**, and hand
their output to a publish job that runs nothing but the AWS CLI.

`refresh-data.yml` is split for a second reason as well: the API tokens and the
AWS role never live in the same job.

Every action is pinned to a full commit SHA rather than a version tag. Tags are
mutable, and `configure-aws-credentials` is the step that is handed the role ARN
and returns credentials.

## Pull requests

`ci.yml` runs on every push and every pull request. `deploy-site.yml` runs only
on pushes to `main` that touch `front/**`. So a pull request is tested and never
deployed, including a pull request that edits the deployment workflow itself.

That separation is enforced twice over, which is deliberate. The path filter is
a convenience; the trust policy is the actual control. A workflow run triggered
by a pull request carries the subject `repo:sjlehtin/semerg:pull_request`, and
the role only accepts `repo:sjlehtin/semerg:ref:refs/heads/main`. A pull request
that adds AWS steps to a workflow therefore cannot assume the role — the token
it can mint does not match. Pull requests from forks additionally get a
read-only `GITHUB_TOKEN` and no access to secrets at all.

### Several pull requests at once

CI is keyed per ref (`ci-${{ github.ref }}`, `cancel-in-progress: true`), so
concurrent pull requests do not interfere: each gets its own group and they run
in parallel. Pushing again to the *same* branch cancels that branch's in-flight
run, which is what you want — the older result is about code nobody has any
more.

Deployment is the opposite: a single `deploy` group shared with `refresh-data`,
with `cancel-in-progress: false`. One thing touches the bucket at a time, and a
running deploy is never killed part-way.

Merging several pull requests in quick succession is safe, but not for the
obvious reason. GitHub keeps **only one pending run per concurrency group**: if
a run is executing and two more queue behind it, the middle one is cancelled
silently. That sounds alarming and is in fact harmless here, because every
deploy builds from whatever `main` is at the time it starts. The newest queued
run always survives, and it produces a bundle containing every merge. Skipping
the intermediate states is the correct outcome — they were never a thing anyone
needed published.

What genuinely follows from parallel merges is subtler: **the deploy that runs
is not necessarily the one you are watching.** If you merge, see a deploy start,
then merge again, the second run may cancel a queued third. Judge the outcome by
what is live, not by counting green checks.

### Where the shared group can bite

A deploy queued behind a data refresh can be cancelled by the *next* data
refresh, because all three sit in the same group. In practice a refresh takes a
minute or two and they run hourly, so a queued deploy starts long before the
next one arrives. It becomes real only if a refresh hangs — retrying against a
slow API, say — long enough for the following hour's refresh to queue behind it.
Then the pending deploy is the middle run, and it is dropped.

The symptom is a merge to `main` that reports success with no deploy having
happened. Re-run *Deploy site* from the Actions tab; nothing is broken, the
change simply never shipped.

The alternative — giving deploys their own group — would let a deploy and a
refresh write to the bucket simultaneously. They touch different keys today
(`assets/` and `index.html` versus `data.json`), so it would probably be fine,
which is not the same as being fine. The shared group was chosen because a
dropped deploy is visible and re-runnable, while an interleaved write is
neither.

### Deploying from a branch

The trust policy accepts `refs/heads/main` only, so `workflow_dispatch` on a
feature branch fails at the credentials step with `Not authorized to perform
sts:AssumeRoleWithWebIdentity`. To test a branch against real infrastructure,
add its ref to `allowed_git_refs` in `infra/terraform.tfvars`, apply, and remove
it afterwards.

While that ref is listed it can deploy to production the same as `main` can.
Do not reach for `repo:owner/repo:*` — this repository is public, so that
pattern would let a pull request opened by anyone assume a role that can write
to the bucket.

### What a merge does not do

Only `front/**` triggers a deploy. Merging a change to `src/semerg/`, `infra/`
or the docs leaves the published bundle exactly as it was, which is correct —
the Python affects the data, not the page. If you change the fetcher and want to
see its output sooner than the next hour, run *Refresh data*, not *Deploy site*.

## Cache headers

Set by the workflows at upload time. There are **no CloudFront invalidations**,
and the role cannot create them.

| Path | `Cache-Control` |
|---|---|
| hashed assets | `public, max-age=31536000, immutable` |
| `index.html` | `public, max-age=60` |
| `data.json` | `public, max-age=60, stale-if-error=86400` |

Why this split:

- **Hashed assets never change**, so revalidating a 290 kB bundle every 60
  seconds — which is what a flat TTL does — is pure waste.
- **`max-age=60` on `data.json`** sits under the page's refetch interval, so a
  refetch is a real fetch rather than a cache hit.
- **`stale-if-error` only fires on 5xx or an unreachable origin.** It keeps
  CloudFront serving during an S3 outage. It does *not* protect against
  publishing bad data — a truncated `data.json` is served as a healthy 200.
  That is what the validation step is for.

## Old bundles

The deploy sync omits `--delete` on purpose: an `index.html` still sitting in a
browser or edge cache must keep resolving the hashed JS it references. So
superseded bundles accumulate.

They are pruned **at deploy time**, by a step in `deploy-site.yml` that deletes
assets older than 30 days which the freshly-built `index.html` does not
reference.

The timing is the whole point, and an earlier draft of this document got it
wrong. A scheduled job — or an S3 lifecycle rule — deleting assets under
`assets/` older than N days would eventually take the site down: assets are
content-hashed, so each deploy writes new *keys* rather than new versions, and
with deploys happening a few times a year the live bundle soon becomes the
oldest object in the prefix. Only immediately after a deploy is it knowable
which bundle is live, because it is the one the `index.html` just uploaded
points at.

Keeping everything would also be fine — a few hundred kB per deploy.

## Monitoring

This is the weakest part of the setup and worth understanding before relying
on it.

- **Check your notification settings before enabling the schedule.** GitHub
  emails failures only to the user who last edited the `cron:` line, only if
  Actions email notifications are enabled, and only if *"Only notify for failed
  workflows"* is checked. If it is not checked, an hourly job sends roughly 730
  emails a month.
- **Scheduled workflows are disabled automatically after 60 days without a
  commit** to the repository. Workflow *runs* do not reset the timer — only
  commits do. `keepalive.yml` handles this; drop it if the repo sees regular
  commits anyway.
- **There is no dead-man's switch.** Nothing alerts on "the workflow stopped
  running at all", which is exactly what the auto-disable produces. The page
  shows its own `fetchTime`, so a stale page is visible to anyone looking at
  it, but nothing pages you.

## Verifying the setup

Run `refresh-data` manually (Actions → Refresh data → Run workflow) before
enabling the schedule, then:

```bash
# Headers as actually served, not as set on the S3 object
curl -sI https://<new-host>/data.json | grep -i cache-control
curl -sI https://<new-host>/index.html | grep -i cache-control

# Default Root Object: must be 200, not an AccessDenied XML body
curl -s -o /dev/null -w '%{http_code}\n' https://<new-host>/
```

Then confirm the guards actually hold:

1. **Bad token.** Re-run with a deliberately wrong `SEMERG_ENTSOE_TOKEN` and
   confirm the run fails *and* that `data.json` in the bucket is unchanged.
2. **Bucket isolation.** With the workflow's role, attempt a write to the old
   bucket and confirm it is denied.
3. **Deploy leaves data alone.** Run `deploy-site` and confirm `data.json`'s
   `LastModified` does not change, and that the previous hashed bundle is still
   present.

## Cutover

Only after the new endpoint has run unattended for a few days:

1. Compare the two pages. While both run the same code, they should agree.
2. Repoint the original URL — swap the old distribution's origin to the new
   bucket, or move DNS to the new distribution. Reversible in minutes.
3. Leave the old bucket intact and the app-server cron *disabled but not
   deleted* for about a week.
4. Retire: remove the crontab entry and `update-page.sh`, delete
   `~/.semerg/config`, revoke the `semeai-energy` IAM user's access keys, and
   empty the old bucket.

The config-file fallback in the Python code stays permanently — it is what lets
local development run without exporting secrets into the shell.
