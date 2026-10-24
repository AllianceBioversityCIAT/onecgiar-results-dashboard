# Post-deploy tag check (FR-13)

Read-only procedure that verifies, on the deployed stack, the tag contract in `infra/tagging.json`
(design 5.2): every taggable resource carries `Project=results-dashboard` and `Environment=<test|prod>`.
It runs in stage S2 only, after G-DEPLOY, with the operator profile. It changes nothing.

Syntax is PowerShell 5.1. Every AWS command is a single line, directly preceded by the marker line
`> Read-only. Runs only in S2 after G-DEPLOY.` Nothing here has been run; T-04 only wrote it.

## Which resources to expect

The offline audit (`node scripts/audit-infra.mjs`) fixes the expectation: for each environment the
taggable resources are `SiteBucket`, `Distribution`, `EdgeFunction`, plus the conditional `LogBucket`
(EnableAccessLogs=true), `PublisherRole` (PublisherPrincipalArn set) and `Budget` (BudgetLimitUsd > 0).
The other types (bucket policies, origin access control, cache policy, response headers policy) have no
tag support and are listed with their reason in `infra/tagging.json` `exceptionTypes`.

## 0. Variables

Set the environment and read the outputs once (replace the values; the stack name is
`results-dashboard-<env>`, region `us-east-1`).

```powershell
$EnvName = 'test'; $Stack = "results-dashboard-$EnvName"; $Region = 'us-east-1'
```

## 1. Stack tags (deploy-time tags from samconfig.toml)

> Read-only. Runs only in S2 after G-DEPLOY.

```powershell
aws cloudformation describe-stacks --stack-name $Stack --region $Region --query "Stacks[0].Tags"
```

Pass: exactly `Project=results-dashboard` and `Environment=$EnvName` are present.

## 2. Tagging API sweep

> Read-only. Runs only in S2 after G-DEPLOY.

```powershell
aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=results-dashboard Key=Environment,Values=$EnvName --region $Region --query "ResourceTagMappingList[].ResourceARN"
```

Pass: the list contains the bucket(s), the distribution and the role for this environment.
`UNVERIFIED — confirm at source before relying on it`: whether this API returns CloudFront resources
from `us-east-1` (they are global) and whether it covers CloudFront functions and budgets (premise
P-13b). A resource missing here is not a failure by itself; check it with the per-type reads below.

## 3. Per-type reads (always run; they are the authority for FR-13)

Get the physical names and ARNs from the stack first.

> Read-only. Runs only in S2 after G-DEPLOY.

```powershell
aws cloudformation describe-stack-resources --stack-name $Stack --region $Region --query "StackResources[].[LogicalResourceId,ResourceType,PhysicalResourceId]" --output table
```

S3 buckets (`SiteBucket`, and `LogBucket` when present), one command per bucket:

> Read-only. Runs only in S2 after G-DEPLOY.

```powershell
aws s3api get-bucket-tagging --bucket <SiteBucket-physical-id> --region $Region
```

IAM role (`PublisherRole`, when present):

> Read-only. Runs only in S2 after G-DEPLOY.

```powershell
aws iam list-role-tags --role-name <PublisherRole-physical-id>
```

CloudFront distribution (use the `DistributionArn` output):

> Read-only. Runs only in S2 after G-DEPLOY.

```powershell
aws cloudfront list-tags-for-resource --resource <DistributionArn>
```

CloudFront function (`EdgeFunction`). `UNVERIFIED — confirm at source before relying on it`: the ARN
form `arn:aws:cloudfront::<account-id>:function/<function-name>` and that `list-tags-for-resource`
accepts it.

> Read-only. Runs only in S2 after G-DEPLOY.

```powershell
aws cloudfront list-tags-for-resource --resource <EdgeFunction-ARN>
```

Budget (`Budget`, when present). `UNVERIFIED — confirm at source before relying on it`: that this command
exists in the CLI version in use and returns the `ResourceTags` set by the template.

> Read-only. Runs only in S2 after G-DEPLOY.

```powershell
aws budgets list-tags-for-resource --resource-arn arn:aws:budgets::<account-id>:budget/results-dashboard-<env>-monthly
```

## Pass and fail

- Pass: every resource read in section 3 returns both tags with the expected values. Record the output in the
  S2 evidence.
- Fail: any taggable resource lacks a tag or has a different value. Do not edit tags by hand (that would drift
  from the template). Record the gap, correct `infra/template.yaml` and redeploy with the usual change set.
- If a per-type read cannot be run for an `UNVERIFIED` command, record `UNVERIFIED` for that resource in the
  evidence; do not report it as passing. Premise P-13b stays open until the S2 result is recorded.
