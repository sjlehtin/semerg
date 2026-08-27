# Infrastructure

Terraform for the AWS side of the site: the bucket, the CloudFront
distribution in front of it, and the IAM role that GitHub Actions assumes to
publish.

Everything here targets a **new** endpoint. The existing `semeai-energy` bucket
and its distribution are not managed by this configuration and are not touched
by it — the deployment role is scoped so it cannot reach them at all. The two
services run in parallel until the old URL is repointed.

## What it creates

| Resource | Notes |
|---|---|
| S3 bucket | Private; all public access blocked |
| Origin Access Control + bucket policy | CloudFront reads the bucket; nobody else can |
| CloudFront distribution | `default_root_object = index.html`, HTTP/3, compression on |
| GitHub OIDC provider | Optional — see `create_oidc_provider` |
| IAM role and policy | S3 only, scoped to this bucket and to `refs/heads/main` |

It does **not** create the GitHub secrets and variables: that would need a
GitHub token, which is more credential surface than it saves. `terraform apply`
prints exactly what to set.

## Running it

Terraform needs credentials that can create IAM roles and CloudFront
distributions — not the deployment role. That role is scoped to S3 on one
bucket, cannot create itself, and giving it enough permission to do so would
defeat the point of scoping it. An account admin identity is the straightforward
choice.

```bash
cd infra
export AWS_PROFILE=default   # whichever profile holds admin credentials
terraform init
terraform plan               # read this before applying
terraform apply
```

The first apply takes a few minutes: CloudFront distributions are slow to
create. Afterwards:

```bash
terraform output github_configuration
```

and set those on the repository.

### Profile troubleshooting

`AWS_PROFILE` names a *profile* in `~/.aws/config` or `~/.aws/credentials`. It
is not an IAM user name, and the two are easy to confuse when a profile happens
to be named after the user it authenticates as.

| Error | Means |
|---|---|
| `failed to get shared config profile, X` | No section named `X` in either file |
| `No valid credential sources found` | The section exists but has no usable keys |

List what you actually have:

```bash
grep '^\[' ~/.aws/config ~/.aws/credentials
```

Section naming differs between the two files, which is a common trap: in
`~/.aws/config` a non-default profile is `[profile NAME]`, while in
`~/.aws/credentials` it is plain `[NAME]`. A profile needs credentials, and a
`region` line alone will not do it:

```ini
# ~/.aws/credentials
[semerg-admin]
aws_access_key_id = AKIA...
aws_secret_access_key = ...
region = eu-north-1
```

There is no way to point one profile at another's credentials. `source_profile`
only works together with `role_arn`, for assuming a role — it does not alias
static keys. So either give the profile its own access key, or use the profile
that already holds the ones you want.

The first apply takes a few minutes: CloudFront distributions are slow to
create. Afterwards:

```bash
terraform output github_configuration
```

and set those on the repository.

## Local state

`terraform.tfstate` stays on your machine and is gitignored. For one operator,
remote state's real benefits — locking and sharing — do not apply, and this
configuration is small enough that losing the file is recoverable: `terraform
import` each resource and carry on. Back it up if you like; do not commit it.

If this ever grows a second operator, move to an S3 backend with
`use_lockfile = true`. That needs a state bucket to exist first, which is the
usual bootstrap recursion — create it by hand, or apply this configuration once
with local state and then migrate.

## The trust policy will break if the repository is renamed

The role trusts a subject built from names:
`repo:sjlehtin/semerg:ref:refs/heads/main`. Two consequences worth knowing
before they surprise you.

**Names are reassignable.** If the account were renamed or deleted, whoever
claimed the username could create a `semerg` repository and satisfy that
subject exactly. The configuration therefore also asserts
`repository_owner_id`, which is a permanent numeric ID, so a name alone is not
enough.

**A rename or transfer flips the subject format.** GitHub introduced immutable
subject claims in April 2026 and made them the default for repositories created
after 2026-07-15. This repository predates that and keeps the legacy format —
but renaming or transferring it switches it to
`repo:OWNER@OWNER-ID/REPO@REPO-ID:ref:refs/heads/main`, at which point the
`StringEquals` here stops matching and every deploy fails with an opaque
`Not authorized to perform sts:AssumeRoleWithWebIdentity`.

If you migrate, opt in explicitly and update `allowed_git_refs` to the
ID-bearing form at the same time.

## Deploying from a branch

The role's trust policy only accepts workflow tokens from `refs/heads/main`,
which means a `workflow_dispatch` run on a feature branch cannot assume it. To
test before merging, add the branch temporarily:

```hcl
# terraform.tfvars
allowed_git_refs = ["refs/heads/main", "refs/heads/my-branch"]
```

then `terraform apply`, test, and remove it again. Do not be tempted by
`repo:owner/repo:*` — on a public repository that lets any pull request from
anyone assume a role that can delete objects.

## Serving on a custom hostname

Set `aliases` in `terraform.tfvars` and apply:

```hcl
aliases = ["energy2.semeai.fi"]
```

The certificate is looked up by domain (`certificate_domain`, default
`*.semeai.fi`) rather than named by ARN, so no account id is committed. It must
already exist in **us-east-1** and be ISSUED — CloudFront accepts certificates
from that region only, wherever the bucket and distribution live. A wildcard
covers any single-label subdomain, so a new one usually needs no new
certificate.

Then add a DNS record pointing the hostname at the `distribution_domain` output.
DNS for `semeai.fi` is at OVH, not Route 53, so that step is manual and is not
described here.

Setting `aliases` also switches the distribution off the default
`*.cloudfront.net` certificate, which is what pins it to CloudFront's `TLSv1`
security policy. TLS 1.0 and 1.1 stop being accepted at the same time. Leaving
`aliases` empty keeps the old behaviour exactly, certificate and all.

## Moving the public hostname

A hostname can be attached to **one** CloudFront distribution at a time, across
all of CloudFront. Adding one that another distribution still holds fails with
`CNAMEAlreadyExists`, so a live hostname cannot simply be listed in `aliases`
here while the old distribution still has it.

Bring the new service up on a second hostname first and soak it. When you are
ready to move the real one, either:

**Without downtime.** Add a TXT record named `_cf-2-<hostname>` whose value is
the target distribution's domain, then:

```bash
aws cloudfront associate-alias \
  --target-distribution-id "$(terraform output -raw distribution_id)" \
  --alias energy.semeai.fi
```

CloudFront checks the TXT record and moves the alias with no gap. Only then add
the hostname to `aliases` and apply — Terraform will see it already present and
report no change. Finally repoint the DNS record and delete the TXT record.

Running the apply *before* `associate-alias` fails, because the alias still
belongs to the old distribution at that point.

**Accepting a short gap.** Remove the alias from the old distribution, add it to
`aliases` here, apply, then repoint DNS. For five to fifteen minutes the
hostname resolves to a distribution that no longer claims it, and returns 403.

To roll back, put the alias back on the old distribution. Keep the old bucket
and distribution intact for a week or so afterwards — and when retiring the
bucket, **empty it rather than deleting it**: S3 bucket names are global, and a
deleted name can be claimed by someone else while any distribution still lists
it as an origin.

## What is not here

- **Cache headers** are set per object at upload time by the workflows rather
  than by a CloudFront policy, so that all caching behaviour lives in the
  repository. See `docs/deployment.md`. A response headers policy *is* used, but
  only for security headers (HSTS, nosniff, frame options, referrer policy),
  which the origin cannot set for itself.
- **TLS 1.0 and 1.1 are accepted**, and cannot be turned off. The default
  `*.cloudfront.net` certificate forces CloudFront's `TLSv1` security policy and
  the API rejects any `minimum_protocol_version` alongside it. Security scanners
  flag this and they are right; the only fix is the custom-domain path above.
- **No CloudFront invalidations**, and the role has no permission to create
  them. Freshness comes from `max-age=60`.
- **No lifecycle rule expiring old bundles.** Every asset is content-hashed, so
  each deploy writes new keys rather than new versions, and an age-based rule
  cannot tell a superseded bundle from the live one. Because deploys are
  infrequent, the live bundle soon becomes the *oldest* object under `assets/`,
  and would be the first thing such a rule deleted. Pruning happens at deploy
  time instead, where the live bundle is known — see `deploy-site.yml`.
