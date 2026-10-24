# Runbook: deploy the TEST stack on the default CloudFront domain (stage S2)

This runbook takes the approved, frozen site (`release/1f6d95a5`) to a private S3 bucket behind CloudFront on the
default `*.cloudfront.net` address. It needs no institutional domain, no ACM certificate and no DNS record.

> **Nothing here may be run now.** S1 (preparation) is complete only after the requester signs **G-DEPLOY**.
> Until then every step is documentation. S2 starts after G-DEPLOY, from the requester's Windows machine, in
> PowerShell 5.1.

## Quick path

1. Check the prerequisites (section 1) and confirm P-25 with the requester.
2. Run the offline pre-flight (section 3). Stop on any failure.
3. `sam deploy` for `test`, reviewing the change set (section 4). **Requires G-DEPLOY.**
4. Read the outputs (section 5), then publish: dry-run first, then `--confirm` (section 6). **Requires G-DEPLOY.**
5. `npm run verify:deploy` against `DistributionUrl` (section 7), the tag check (section 8), the validation plan
   (section 9), then fill the handoff (section 10).

## Conventions

| Marker | Meaning |
|---|---|
| `> **Requires G-DEPLOY.** AWS-mutating command.` | Creates, changes or deletes something in AWS. Never run before the requester signs G-DEPLOY. |
| `> Read-only. ...` | Calls AWS but changes nothing. Still needs credentials, so it also runs only in S2. |
| no marker | Offline: no AWS call. |

A test (`tests/unit/infra-docs.test.mjs`) fails when a mutating command in these documents lacks its marker.
Every command is PowerShell 5.1 syntax (no `&&`; use `;` or `if ($?)`). Run them from `results-dashboard-static/`.

## 1. Prerequisites

| Item | Requirement | Owner |
|---|---|---|
| AWS account | One account for the TEST stack. Its id is not recorded in the repository. | Requester (P-25) |
| Region | `us-east-1` (recommended, set in `infra/samconfig.toml`). The AWS CLI and `publish.mjs` have **no region flag**: they take the region from the environment or the profile, so set it explicitly (section 2). | Operator |
| Profile / SSO | A named profile for the operator, for example `<profile>`, logged in (`aws sso login --profile <profile>`) when SSO is used. | Operator |
| Deployer policy | `infra/iam/deployer-policy.json` attached to the operator identity by Infrastructure. It is attached outside the stack. | Infrastructure |
| Permissions boundary | **Escalation risk:** the policy allows `iam:CreateRole`, `iam:PutRolePolicy` and `iam:UpdateAssumeRolePolicy` on `role/results-dashboard-*`, and deliberately omits `iam:PassRole` (do not add it). Infrastructure should attach a permissions boundary to the operator identity before G-DEPLOY. | Infrastructure |
| AWS CLI | v2. The check in section 3 prints the version; record it in the S2 evidence. Last seen on the preparation machine: `aws-cli/2.36.28`. | Operator |
| SAM CLI | Installed and recorded the same way. **Not installed on the preparation machine, so no version is verified.** | Operator |
| Node.js | 22 LTS (`>=22.12.0 <23`, see `package.json`). | Operator |
| cfn-lint | Optional but advised: `cfn-lint infra/template.yaml`, pinned version, offline. The preparation gate was `BLOCKED (cfn-lint unavailable)`. Without it the change-set review is the only semantic check of the template. | Operator |
| P-25 | An account, a region and operator permissions exist. `UNVERIFIED` until the requester confirms them in writing before G-DEPLOY. | Requester |

First-deploy permission failures: if `sam deploy` is denied, check the `CloudFormationChangeSets` statement first. Its
resource pattern `changeSet/samcli-deploy*/*` is `UNVERIFIED` against the real change-set name. The seven
wildcard or type-wide exceptions in `infra/tagging.json` (`iamResourceWildcardAllowlist`) are all `UNVERIFIED`; they
close in S2 validation (see `VALIDATION.md`, section 3).

## 2. Variables

> Read-only. Runs only in S2 after G-DEPLOY.

```powershell
$AwsProfile = '<profile>'; $Region = 'us-east-1'; $EnvName = 'test'; $Stack = "results-dashboard-$EnvName"
$env:AWS_PROFILE = $AwsProfile; $env:AWS_REGION = $Region; $env:AWS_DEFAULT_REGION = $Region
aws configure list
aws sts get-caller-identity
```

Expected: `region` shows `us-east-1` and the caller is the operator identity you intend to use. **Stop** if the
region is anything else; `publish.mjs` would write to the wrong account or region silently.

## 3. Offline pre-flight (no AWS call)

```powershell
node --version
npm run audit:infra
node --test tests/unit/infra-template.test.mjs tests/unit/infra-docs.test.mjs
node -e "const s=require('fs').statSync('infra/template.yaml').size; console.log(s, s<51200 ? 'direct upload ok' : 'TOO LARGE')"
```

| Check | Pass | If it fails |
|---|---|---|
| `audit:infra` | prints `audit-infra: PASS` | Stop. Report. Do not edit the template ad hoc. |
| template and docs tests | all pass | Stop. Report. |
| template size | under 51200 bytes (32944 when written) | Stop. The fallback is a pre-created, tagged deployment bucket (P-22, `UNVERIFIED`). |

Optional, if installed:

```powershell
cfn-lint --version
cfn-lint infra/template.yaml
```

Pre-flight for the SAM CLI, read-only. The template omits `Transform: AWS::Serverless-2016-10-31`; whether
`sam deploy` accepts a plain CloudFormation template is `UNVERIFIED`. If SAM rejects it, **stop and report**; do not
edit the template ad hoc.

> Read-only. Runs only in S2 after G-DEPLOY.

```powershell
sam --version
sam validate --template-file infra/template.yaml
```

## 4. Deploy the TEST stack

### 4.1 Parameters

Values below are the committed defaults for `test` (`infra/params/test.json`, repeated in `infra/samconfig.toml`).
`PublisherPrincipalArn` and `BudgetEmail` are given at deploy time and are **never committed**.

| Parameter | Meaning | Allowed | `test` |
|---|---|---|---|
| `Environment` | Names and tags | `test`, `prod` | `test` |
| `PriceClass` | CloudFront edge coverage | `PriceClass_100`, `PriceClass_200`, `PriceClass_All` | `PriceClass_100` |
| `EnableAccessLogs` | Creates the log bucket and enables logging | `true`, `false` | `true` |
| `LogRetentionDays` | Log expiry | number | `30` |
| `Indexing` | `deny` adds `X-Robots-Tag: noindex, nofollow` | `allow`, `deny` | `deny` |
| `PublisherPrincipalArn` | Principal trusted by the publisher role; empty skips the role | ARN of an IAM user or role (not an STS session ARN), or empty | the operator's principal |
| `BudgetLimitUsd` | Monthly budget; `0` disables it | number | `10` |
| `BudgetEmail` | Budget alert address (80 % and 100 %); empty means no notification | email or empty | given at deploy time |
| `AlternateDomainName` | Institutional hostname (S3 only) | lowercase hostname or **empty** | empty |
| `CertificateArn` | ACM certificate in `us-east-1` (S3 only) | ACM ARN or **empty** | empty |
| `CanonicalHost` | Redirect target host (S3 only) | lowercase hostname equal to `AlternateDomainName`, or **empty** | empty |

Rules the template enforces: `AlternateDomainName` and `CertificateArn` are set together or both empty;
`CanonicalHost` needs a custom domain and must equal `AlternateDomainName`. Hostnames must be lowercase (the pattern
rejects uppercase), because rule 1 compares the request `Host` exactly. **In S2 all three domain parameters stay
empty.** Do not set them here.

### 4.2 Command

Pass the **full** override string, with **every** parameter named. Two behaviours make this necessary:

- The CLI `--parameter-overrides` most likely **replaces** the `samconfig.toml` value rather than merging with it
  (`UNVERIFIED`), so a partial string could drop `Environment` and the rest.
- On an **existing** stack, `sam deploy` (like `aws cloudformation deploy`) sends `UsePreviousValue` for any template
  parameter it is not given, so it keeps the old value. Leaving a parameter out therefore never clears it; only a
  first create treats an unnamed parameter as empty. To clear a value, name it with an empty value.

The string below is every parameter: the non-empty ones from `samconfig.toml`, the two deploy-time values, and the
three domain parameters named **explicitly empty** (`Name=` with nothing after the equals sign). Unused optional
values are passed the same way (`BudgetEmail=`, `PublisherPrincipalArn=`); `publish.mjs` then needs the operator
identity to hold the S3 and CloudFront rights when the publisher role is not created.

`UNVERIFIED`: that SAM CLI accepts `Name=` (empty value) in `--parameter-overrides` and that PowerShell 5.1 passes
the single quoted-by-PowerShell string as one argument. The string contains no embedded double quotes on purpose,
because 5.1 does not escape them for native commands. If SAM rejects the empty form, **stop and report**; do not
edit the template ad hoc.

> **Requires G-DEPLOY.** AWS-mutating command.

```powershell
$PublisherArn = '<operator-principal-arn>'
$BudgetEmail = '<budget-email>'
$Overrides = "Environment=test PriceClass=PriceClass_100 EnableAccessLogs=true LogRetentionDays=30 Indexing=deny BudgetLimitUsd=10 PublisherPrincipalArn=$PublisherArn BudgetEmail=$BudgetEmail AlternateDomainName= CertificateArn= CanonicalHost="
sam deploy --config-file infra/samconfig.toml --config-env test --template-file infra/template.yaml --parameter-overrides $Overrides
```

SAM prints the parameter overrides it received in the deploy header. Check them there before answering the prompt.

`confirm_changeset = true`: SAM prints the change set and waits. **Stop point 1: review the change set.**

| Expect in the change set | Stop if you see |
|---|---|
| Action `Add` for `SiteBucket`, `LogBucket`, `Distribution`, `EdgeFunction`, `OriginAccessControl`, `HtmlCachePolicy`, a headers policy, bucket policies, `PublisherRole`, `Budget` | Any `Modify` or `Remove` on a first create; any ACM, Route 53 or managed-policy resource; a SAM-managed artifact bucket |
| Tags `Project=results-dashboard`, `Environment=test` on the stack | a missing tag |

Answer `y` only after the review. Expected end state: `CREATE_COMPLETE`. A first create can take several minutes
(CloudFront).

If the create fails:

- CloudFormation rolls back. A failed first create leaves the stack in `ROLLBACK_COMPLETE`; it must be deleted
  before a retry (section 11).
- Empty-string outputs (`PublisherRoleArn`, `AlternateDomainName`, `CanonicalHost` when unset) may be rejected on a
  first create (`UNVERIFIED`). Stop and report; do not edit the template ad hoc.
- The retained `SiteBucket` (and `LogBucket`, see section 11) are left behind; section 11 says how to find and remove
  them after review.

## 5. Read the outputs

> Read-only. Runs only in S2 after G-DEPLOY.

```powershell
aws cloudformation describe-stacks --stack-name $Stack --query "Stacks[0].Outputs"
$Url = aws cloudformation describe-stacks --stack-name $Stack --query "Stacks[0].Outputs[?OutputKey=='DistributionUrl'].OutputValue" --output text
$Url
```

Expected outputs: `DistributionId`, `DistributionArn`, `DistributionDomainName`, `DistributionUrl`
(`https://<domain>/`), `SiteBucketName`, `PublisherRoleArn` (empty when no publisher principal),
`AlternateDomainName` and `CanonicalHost` (empty in S2). **Stop** if `DistributionUrl` is empty.
Record all values; section 10 reuses them.

## 6. Publish the frozen release

Only the approved hash `1f6d95a5...` is accepted by `scripts/publish.mjs`: the script verifies
`release/1f6d95a5` against its manifest before anything else.

The blocks call `node scripts/publish.mjs` and `node scripts/verify-deploy.mjs` directly. They are what the npm
scripts `publish` and `verify:deploy` run; under PowerShell 5.1 `npm run <script> -- <flags>` may drop the `--`.

Dry-run first. It makes no AWS call and prints the upload plan and the deletion rule.

```powershell
node scripts/publish.mjs --env test --release release/1f6d95a5
```

Expected: `dry-run: release 1f6d95a5 verified (1f6d95a5...)`, 196 uploads, each with a content type and a
Cache-Control, and the last line `dry-run: no AWS call was made; add --confirm to write`.

**Stop point 2: requester approval of the Cache-Control strings.** They are `[assumption]` (the design fixes edge
TTLs, not object headers). Approve them at G-DEPLOY:

| Files | Cache-Control |
|---|---|
| every `.html` file and `widget/*` | `public, max-age=300` |
| every other file (assets) | `public, max-age=31536000, immutable` |

Then write. The script reads the bucket and distribution id from the stack outputs, uploads each file with an
explicit content type and Cache-Control, lists the bucket (read-only), prints the keys it will delete, deletes
keys not in the manifest, and creates one invalidation for `/*`.

> **Requires G-DEPLOY.** AWS-mutating command.

```powershell
node scripts/publish.mjs --env test --release release/1f6d95a5 --confirm --profile $AwsProfile
```

Expected last lines: `uploaded 196 files`, `deleting 0 keys not in the manifest` on a fresh bucket,
`invalidation created for /* on <DistributionId>`.

| Behaviour | What to do |
|---|---|
| Uploads happen before deletes, so a visitor can briefly see a mix of old and new files on TEST | Acceptable on TEST. |
| A failure part-way through the deletes | Re-run the same command; the script is repeatable. |
| An upload fails | Re-run. Do not edit files under `release/`. |
| `release verification failed` | Stop. The release folder differs from the approved artifact. Report. |

## 7. Verify the deployed content

Read-only over HTTP: it makes `GET` requests to the distribution and calls no AWS API.

```powershell
node scripts/verify-deploy.mjs --url $Url --release release/1f6d95a5
```

Expected: `checked <n> files, 0 failed` and `PASS: equals approved hash 1f6d95a5...`. Exit code 0.

| Result | Meaning |
|---|---|
| `FAIL <file> (<url>): ...` | A file differs or is unreachable. Wait for the invalidation (a few minutes), re-run once. |
| One transient network error | The run fails as a whole. Re-run. The verifier never follows redirects, so a redirect is a failure to investigate. |
| Still failing after one re-run | Stop and report; do not republish blindly. |

## 8. Tag check (FR-13)

Run the read-only procedure in [TAG-CHECK.md](TAG-CHECK.md). It verifies `Project=results-dashboard` and
`Environment=test` on every taggable resource and records premise P-13b. Do not edit tags by hand.

## 9. Validation plan

Run [VALIDATION.md](VALIDATION.md) on `$Url` and record each status (PASSED, FAILED, `BLOCKED (reason)`, NOT RUN)
in the S2 evidence. Tableau is `BLOCKED (institutional domain not attached)`. Also check that access logs arrive
under `test/` in the log bucket (log delivery together with the log bucket's TLS-deny policy is `UNVERIFIED`;
logs can take some time to appear).

## 10. Handoff

Fill [HANDOFF-INFRASTRUCTURE.md](HANDOFF-INFRASTRUCTURE.md) from the section 5 outputs. S2 ends when the
validation statuses are recorded and the handoff is filled. The requester then decides whether Infrastructure
starts S3.

## 11. Rollback

Stop first, then choose the layer. Content and infrastructure rollbacks are independent.

### 11.1 Content

Republishing an **earlier** release needs an allowlist change in `scripts/freeze-artifact.mjs` (only the approved
hash is accepted today, and only one release exists), so it is not an S2 option. S2 rollback of content is to
restore object versions, then invalidate.

**Permission gap:** `infra/iam/deployer-policy.json` has neither `s3:ListBucketVersions` nor
`s3:DeleteObjectVersion`. The two commands below are denied under that policy. Ask Infrastructure to grant them on
`results-dashboard-*` for the rollback, or have Infrastructure run the restore.

> Read-only. Runs only in S2 after G-DEPLOY.

```powershell
$Bucket = aws cloudformation describe-stacks --stack-name $Stack --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text
$DistId = aws cloudformation describe-stacks --stack-name $Stack --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text
aws s3api list-object-versions --bucket $Bucket --query "Versions[?IsLatest].[Key,VersionId]" --output table
```

Review the list. Deleting the latest version of a key makes the previous version current; a key that had no earlier
version disappears. After the very first publish there is nothing earlier to restore: the rollback is to remove the
keys and publish again later.

> **Requires G-DEPLOY.** AWS-mutating command.

```powershell
aws s3api delete-object --bucket $Bucket --key <key> --version-id <latest-version-id>
```

Repeat for each key to roll back (the key and version id come from the listing; a key with spaces is passed as one
quoted argument). A key that the publish **deleted** shows as a delete marker; remove the marker the same way, using
the id from `list-object-versions --query "DeleteMarkers[?IsLatest].[Key,VersionId]"`. Then invalidate:

> **Requires G-DEPLOY.** AWS-mutating command.

```powershell
aws cloudfront create-invalidation --distribution-id $DistId --paths "/*"
```

Re-run section 7 afterwards: it passes only on the approved content, so after a rollback it is expected to report
the differences.

### 11.2 Infrastructure

| Situation | Action |
|---|---|
| `sam deploy` fails | CloudFormation rolls back by itself. Read the cause below, fix in git, redeploy. |
| A later update misbehaves | Redeploy the previous template from git with the same command (section 4.2). |
| Retire the TEST stack | Delete it (below). The buckets are kept; remove them manually after review. |

Read the failure cause (read-only):

> Read-only. Runs only in S2 after G-DEPLOY.

```powershell
aws cloudformation describe-stack-events --stack-name $Stack --query "StackEvents[?contains(ResourceStatus,'FAILED')].[LogicalResourceId,ResourceStatusReason]" --output table
```

Delete the stack. **Before** this, empty the log bucket (`LogBucket` has no `DeletionPolicy`, so a non-empty bucket
makes the stack end in `DELETE_FAILED`). The same applies before setting `EnableAccessLogs=false`.

First capture the bucket names **before** the delete and write them in the S2 evidence: after the delete they can
only be found in the console, because the deployer policy does not grant `s3:ListAllMyBuckets` (so `aws s3 ls`
without a bucket and `aws s3api list-buckets` are denied).

> Read-only. Runs only in S2 after G-DEPLOY.

```powershell
$SiteBucket = aws cloudformation describe-stack-resources --stack-name $Stack --logical-resource-id SiteBucket --query "StackResources[0].PhysicalResourceId" --output text
$LogBucket = aws cloudformation describe-stack-resources --stack-name $Stack --logical-resource-id LogBucket --query "StackResources[0].PhysicalResourceId" --output text
$SiteBucket; $LogBucket
aws s3 ls s3://$LogBucket --recursive --summarize
```

**Stop point: requester review.** The log objects are the only record of TEST traffic. The requester decides
whether to copy them first (for example `aws s3 cp s3://$LogBucket/ <local-folder> --recursive`, a read of the
bucket) or to discard them. Empty the bucket only after that decision. `LogBucket` is not versioned, so `s3 rm
--recursive` empties it; on a **versioned** bucket (`SiteBucket`) `s3 rm` leaves old versions behind and the bucket
is not empty.

> **Requires G-DEPLOY.** AWS-mutating command.

```powershell
aws s3 rm s3://$LogBucket --recursive
aws cloudformation delete-stack --stack-name $Stack
```

`SiteBucket` has `DeletionPolicy: Retain`, so it (and the log bucket, if `DELETE_FAILED` was fixed by hand) remains
after a failed create or a deleted stack. Check a leftover bucket with the name captured above:

> Read-only. Runs only in S2 after G-DEPLOY.

```powershell
aws s3api get-bucket-tagging --bucket $SiteBucket
```

Remove a leftover bucket only after the requester reviews it. A versioned bucket must first have every version
and delete marker removed (this also needs `s3:DeleteObjectVersion`, see 11.1); then:

> **Requires G-DEPLOY.** AWS-mutating command.

```powershell
aws s3api delete-bucket --bucket $SiteBucket
```

### 11.3 Later stages

| Layer | Rollback |
|---|---|
| Domain attachment (S3) | Update the stack with the three parameters passed **explicitly empty** (`AlternateDomainName= CertificateArn= CanonicalHost=`), as in `HANDOFF-INFRASTRUCTURE.md` section 6. Leaving them out keeps the old values and changes nothing. Infrastructure reverts DNS. |
| PROD (S4) | Point the production hostname back to Copernico while it still exists (before G4). |

## 12. Stages after S2

| Stage | What | Owner and gate |
|---|---|---|
| S1 | Preparation: `infra/`, scripts, offline checks. **Complete only after the requester's G-DEPLOY.** | Requester |
| S2 | This runbook, `test` stack, default domain | G-DEPLOY |
| S3 | Institutional domain: ACM certificate in `us-east-1`, DNS, stack update, Tableau validation | Infrastructure, using the handoff |
| S4 | PROD stack and domain switch. Needs: G-DEPLOY evidence accepted; domain attached and Tableau validated; P-17 (the parent spec's premise) resolved; D10 decided; G3 approved | G3, then G4 |

Premises that S2 closes (details and owners in `VALIDATION.md`): P-13b, P-16b, P-20, P-22, P-25 and the P-26
outcome.
