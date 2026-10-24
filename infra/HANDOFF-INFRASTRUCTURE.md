# Handoff to Infrastructure: attach an institutional domain (stage S3)

This is a **fill-in template**. The requester completes section 1 at the end of S2, from the stack outputs, and
passes the document to Infrastructure. It describes what Infrastructure must provide to attach a domain to the TEST
distribution. It assumes **nothing** about the domain: no hostname, certificate or DNS record exists until
Infrastructure creates them. Every `<placeholder>` is replaced by a real value only when it exists.

> **Nothing here may be run now.** Section 1 is filled after S2 (which needs G-DEPLOY). Sections 2 to 6 are
> executed by Infrastructure in S3, after the requester hands this document over with the G-DEPLOY evidence.

## Quick path

1. Requester: fill section 1 (read-only commands), then hand over.
2. Infrastructure: certificate in ACM `us-east-1`, then stack update with the alias, then DNS, then the canonical
   host (section 2). The order matters.
3. Re-validate (section 5). Roll back by clearing the three parameters (section 6).

## 1. Values (filled by the requester after S2)

Replace each `<...>` with the value read by the command beside it. Leave nothing blank: write `n/a` and the reason.

| Value | Fill in | Read command |
|---|---|---|
| Environment | `<Environment>` | the stack was deployed with `--config-env <env>` |
| Stack name | `<StackName>` | `results-dashboard-<Environment>` |
| Region | `<Region>` | `$env:AWS_REGION` (set in the runbook, section 2), or the region field of the stack ARN printed by `aws cloudformation describe-stacks --stack-name $Stack --query "Stacks[0].StackId"` |
| `DistributionId` | `<DistributionId>` | read command below |
| `DistributionArn` | `<DistributionArn>` | read command below |
| `DistributionDomainName` | `<DistributionDomainName>` | read command below |
| `DistributionUrl` | `<DistributionUrl>` | read command below |
| `SiteBucketName` | `<SiteBucketName>` | read command below |
| Published release hash | `<ReleaseHash>` | read command below |
| Date of S2 validation | `<Date>` | `Get-Date -Format yyyy-MM-dd` |

Read commands (outputs of the stack, all read-only):

> Read-only. Runs only in S2 after G-DEPLOY.

```powershell
$Stack = 'results-dashboard-<Environment>'
aws cloudformation describe-stacks --stack-name $Stack --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text
aws cloudformation describe-stacks --stack-name $Stack --query "Stacks[0].Outputs[?OutputKey=='DistributionArn'].OutputValue" --output text
aws cloudformation describe-stacks --stack-name $Stack --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" --output text
aws cloudformation describe-stacks --stack-name $Stack --query "Stacks[0].Outputs[?OutputKey=='DistributionUrl'].OutputValue" --output text
aws cloudformation describe-stacks --stack-name $Stack --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text
node -e "console.log(require('./release/1f6d95a5/manifest.json').hash)"
```

The last command prints the hash of the release that was published (`1f6d95a5...`). Also attach the S2 evidence:
`VALIDATION.md` with its statuses, and the tag-check output (`TAG-CHECK.md`).

## 2. Requirements to attach a domain

Infrastructure provides, **in this order**:

| Step | What | Who | Notes |
|---|---|---|---|
| 1 | A certificate in ACM **`us-east-1`** that covers `<hostname>` | Infrastructure | CloudFront accepts only a certificate from `us-east-1`, whatever the stack region. The stack never creates it. |
| 2 | Stack update with `AlternateDomainName=<hostname>` and `CertificateArn=<certificate-arn>` | Infrastructure | Both together, or the template rejects the update. The hostname must be **lowercase**. |
| 3 | DNS `CNAME` or `ALIAS` from `<hostname>` to `<DistributionDomainName>` | Infrastructure | After step 2, so CloudFront accepts the alias before traffic arrives. |
| 4 | Stack update that adds `CanonicalHost=<hostname>` | Infrastructure | Only once DNS resolves. The same lowercase hostname. Setting it earlier would redirect every visitor to an unreachable host. |

Read-only checks around the steps:

> Read-only. Runs in S3, after G-DEPLOY, by Infrastructure.

```powershell
aws acm describe-certificate --certificate-arn <certificate-arn> --region us-east-1 --query "Certificate.[Status,DomainName,SubjectAlternativeNames]"
Resolve-DnsName <hostname> -Type CNAME
```

Stack update (steps 2 and 4). Pass the **full** override string: the command-line value most likely replaces the
`infra/samconfig.toml` one (`UNVERIFIED`). `<PublisherPrincipalArn>` and `<BudgetEmail>` are the same deploy-time
values used in S2 (never committed; if one was unused in S2 pass it empty, `Name=`, never omit it). On an existing
stack a parameter that is not named keeps its previous value, so every parameter is named. Step 2 leaves
`CanonicalHost=` empty; for step 4 replace it with `CanonicalHost=<hostname>`.

> **Requires G-DEPLOY.** AWS-mutating command.

```powershell
$Overrides = "Environment=<Environment> PriceClass=PriceClass_100 EnableAccessLogs=true LogRetentionDays=30 Indexing=deny BudgetLimitUsd=10 PublisherPrincipalArn=<PublisherPrincipalArn> BudgetEmail=<BudgetEmail> AlternateDomainName=<hostname> CertificateArn=<certificate-arn> CanonicalHost="
sam deploy --config-file infra/samconfig.toml --config-env <Environment> --template-file infra/template.yaml --parameter-overrides $Overrides
```

Review the change set (`confirm_changeset = true`): expect a `Modify` of `Distribution` (aliases, certificate)
and of the edge function in step 4, and nothing else. The other parameter values come from the S2 record in
`RUNBOOK.md` section 4.2. Running this stage needs the same deployer policy as S2
(`infra/iam/deployer-policy.json`); it allows `acm:DescribeCertificate` and `acm:ListCertificates` only, never
ACM or Route 53 writes.

## 3. Must not change

- `dist/` and the bucket content: no rebuild and no re-upload. The domain is attached by a stack update only.
- HSTS stays `max-age=31536000` **without** `includeSubDomains` and **without** `preload`, because the host sits
  under `cgiar.org` with other sites.
- No `X-Frame-Options` header: the site and the widget are embedded by design.
- The three domain parameters stay empty in `infra/params/*.json` and `infra/samconfig.toml`; the values are given
  at deploy time.

## 4. Tableau

Dashboards render only on a `*.cgiar.org` host, so they cannot be validated on the default URL
(`BLOCKED (institutional domain not attached)` in `VALIDATION.md`). Once the hostname is attached, Tableau render
and filters are validated by the requester (section 5).

## 5. Re-validation after attachment

Repeat the S3 re-checks in `VALIDATION.md` (section 4) and record them as S3 evidence:

- [ ] `node scripts/verify-deploy.mjs --url https://<hostname>/ --release release/1f6d95a5` passes (the npm script
      `verify:deploy` runs the same file).
- [ ] Route and redirect checks with the canonical host.
- [ ] Tableau render and filters.
- [ ] `tableauHosts` pinned.

## 6. Rollback of the attachment

Clear `AlternateDomainName`, `CertificateArn` and `CanonicalHost` by passing the three parameters **explicitly
empty** in the override string and updating the stack. Do **not** just leave the three tokens out: on an existing
stack `sam deploy` keeps the previous value of any parameter it is not given, so the update would change nothing.
Infrastructure then reverts the DNS record.

> **Requires G-DEPLOY.** AWS-mutating command.

```powershell
$Overrides = "Environment=<Environment> PriceClass=PriceClass_100 EnableAccessLogs=true LogRetentionDays=30 Indexing=deny BudgetLimitUsd=10 PublisherPrincipalArn=<PublisherPrincipalArn> BudgetEmail=<BudgetEmail> AlternateDomainName= CertificateArn= CanonicalHost="
sam deploy --config-file infra/samconfig.toml --config-env <Environment> --template-file infra/template.yaml --parameter-overrides $Overrides
```

`UNVERIFIED`: that SAM CLI accepts `Name=` (empty value) in `--parameter-overrides` (see `RUNBOOK.md` 4.2). **Stop points:**
the change set must show `Modify` on `Distribution` and on the edge function (`EdgeFunction`); "No changes to deploy" means
**stop**: the domain was not cleared, so do not remove the DNS record. Afterwards read the parameters back
(read-only) and confirm the three are empty.

> Read-only. Runs after G-DEPLOY, by Infrastructure.

```powershell
aws cloudformation describe-stacks --stack-name $Stack --query "Stacks[0].Parameters"
```

Once the three are empty, Infrastructure removes or repoints the DNS record in the same window: after the alias is
removed, requests to the hostname fail with a certificate error.
