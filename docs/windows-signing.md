# Windows release signing

This page is for Relay's release publisher only. People installing Relay download and open Setup; they do not create Azure accounts, install certificates or configure GitHub Actions.

The previously published 0.11.1 beta remains unsigned. The prepared release pipeline requires Microsoft Azure Artifact Signing Public Trust signing for future Windows releases; missing configuration fails closed. A real signed release is not established until identity validation, protected environment configuration and a successful signed CI run are complete. Preparing this workflow does not authorize a purchase or create cloud resources.

## One-time publisher setup

1. Choose the legal publisher identity and approve the cost. Azure requires a Microsoft Entra tenant and a **paid** Azure subscription; free, trial and sponsored subscriptions are unsupported. The published Basic price is **US$9.99 per account per month**, including 5,000 signatures, then US$0.005 per signature. Check the current offer before creating resources. [Microsoft pricing](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-change-sku) · [Subscription restrictions](https://learn.microsoft.com/en-us/azure/artifact-signing/faq)
2. Register `Microsoft.CodeSigning`, create an Artifact Signing account in a supported region and complete **Public Trust** identity validation in the Azure portal. For an individual, Microsoft currently supports the United States and Canada; the billing account must be of type Individual, with legal name and sold-to address matching the government-issued ID. The certificate exposes the verified name and city/state/country; the individual's street address and email are excluded. Organization validation has separate geographic and business-document requirements. This human identity step cannot be completed by the workflow. [Microsoft setup and identity requirements](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
3. Create a **Public Trust** certificate profile after validation completes. Private Trust and Public Trust Test profiles do not provide public Windows publisher trust. Create a separate Entra application/service principal for this repository's signing job. Give it only **Artifact Signing Certificate Profile Signer**, scoped to this exact profile:

   ```text
   /subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.CodeSigning/codeSigningAccounts/<account>/certificateProfiles/<profile>
   ```

   Do not grant this CI identity Owner, Contributor, identity-verification or subscription-wide signing permissions. The person provisioning the resources needs their own appropriate setup permissions. [Profile-scoped role assignment](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles)
4. In GitHub, create the protected environment **`windows-signing`**. Restrict deployment to authorized release tags, require a trusted release reviewer and restrict who can create those tags. Do not allow arbitrary branches, pull requests or diagnostic tags to reach signing. Prevent self-approval when a separate trusted reviewer is available; a sole maintainer must choose an approval arrangement they can actually complete. The environment is publisher infrastructure, not an installation step for users.
5. Configure an Entra federated credential with issuer `https://token.actions.githubusercontent.com` and audience `api://AzureADTokenExchange`. Bind it to this exact repository and the `windows-signing` environment. New GitHub repositories created after July 15, 2026 use immutable owner/repository IDs in the default subject. For Relay, the default environment-subject template is:

   ```text
   repo:GiovanniVarg@<owner-id>/Relay@<repository-id>:environment:windows-signing
   ```

   Confirm the repository's actual OIDC configuration and IDs before applying the trust policy; do not assume the older name-only subject. Never print or save a complete OIDC token to discover its claims. Environment subjects omit the tag from the default subject, so GitHub environment tag restrictions are essential. [GitHub immutable subject format](https://docs.github.com/en/actions/reference/security/oidc) · [Azure OIDC and environment protections](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure)
6. Add these **environment secrets** to `windows-signing`: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`. No client secret, password, PFX or private signing key belongs in GitHub or this repository. OIDC obtains short-lived access; Microsoft manages the signing key.
7. Add these **repository configuration variables**. They are checked before the expensive release build, without granting that build access to OIDC or environment secrets:

   | Variable | Value to enter in GitHub settings |
   | --- | --- |
   | `RELAY_AZURE_SIGNING_ENDPOINT` | The account's regional HTTPS endpoint, in the form `https://<region>.codesigning.azure.net/` |
   | `RELAY_AZURE_SIGNING_ACCOUNT` | The selected Artifact Signing account name |
   | `RELAY_AZURE_SIGNING_PROFILE` | The Public Trust certificate profile name |
   | `RELAY_AZURE_SIGNING_EXPECTED_SUBJECT` | The exact CA-issued certificate Subject string, including its ordering and punctuation |

   Obtain the expected subject from the validated profile/certificate; do not substitute the app name or invent a personal default. Account IDs, real configuration values and identity documents must not be committed to source.

## Release boundaries

The workflow uses four isolated jobs:

- **Build** has repository read access only. It validates the canonical tag/source/version, installs locked dependencies without lifecycle scripts, runs the full normal checks and builds four unsigned intermediate assets.
- **Sign** is the only job with `id-token: write`, behind the protected environment. It checks out standalone signing utilities from the executing workflow commit, checks unsigned hashes/source identity, obtains Azure OIDC credentials and signs only the exact setup EXE. It never executes target-tag product code, tests or npm installation. Signing dependencies are not cached, and credential tracing is disabled.
- **Verify** has no OIDC access. On a fresh Windows runner it verifies the final signature, runs all five required actual-installer cases—including clean install/open/reopen/uninstall and data preservation—and verifies the signature again. Every receipt is bound to the signed artifact's SHA-256.
- **Publish** has repository write access only. Trusted utilities independently recheck the signature, expected subject, checksums, metadata and five receipts. It rechecks the canonical tag, uploads exactly four assets to a draft, compares GitHub's uploaded digests and re-verifies before publishing the prerelease. It does not run product code.

Unsigned, signed-candidate and verified workflow artifacts have different names. Intermediate Actions artifacts are not published releases. There is no unsigned fallback. Diagnostics do not obtain signing credentials and do not require signing configuration.

Signing changes the EXE's hash. Only after signing is verified do trusted utilities set `components.json` to `unsigned: false`, record the observed signature and regenerate `SHA256SUMS.txt`. Final tests and publication use those final bytes. Existing tags/assets are not overwritten or silently re-signed.

The official action dependencies are pinned to reviewed release commits:

| Action | Pin | Release |
| --- | --- | --- |
| Azure Login | `a641126d1b8aa4d1fa005f4f92df94a3a4c4c906` | [v3.1.0](https://github.com/Azure/login/releases/tag/v3.1.0) |
| Azure Artifact Signing | `c7ab2a863ab5f9a846ddb8265964877ef296ee82` | [v2.0.0](https://github.com/Azure/artifact-signing-action/releases/tag/v2.0.0) |

The v2 signing input names are `signing-account-name`, `certificate-profile-name` and an explicit `files` path. Only Azure CLI credentials produced by Azure Login are enabled in the signing action. File and timestamp digests use SHA-256 with the documented Microsoft RFC3161 timestamp service. [Pinned action schema](https://github.com/Azure/artifact-signing-action/blob/c7ab2a863ab5f9a846ddb8265964877ef296ee82/action.yml) · [Official OIDC authentication pattern](https://github.com/Azure/artifact-signing-action/blob/c7ab2a863ab5f9a846ddb8265964877ef296ee82/docs/OIDC.md)

## What signing does and does not change

A valid public signature identifies the verified publisher and protects the signed bytes. SmartScreen reputation still accumulates over time; signing is not a promise that antivirus, endpoint policies or SmartScreen will accept every release. Relay does not bypass protections or restore quarantined files. [Microsoft's SmartScreen explanation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)

The outer EXE signature does not separately sign extracted engine/runtime PowerShell helpers or downloaded third-party components. The installer and daily launcher still use their existing PowerShell invocations with `ExecutionPolicy Bypass`; this preparation does not change that behavior or grant an endpoint-policy exception.

On a fresh installation, Setup copies the final signed executable into `.runtime/Relay.exe`, preserving its signature. Existing ready installations are opened, not overwritten. Relay's normal source updater preserves `.runtime`, so it does **not** automatically replace an older unsigned daily launcher. Migration of existing launchers is separate work; this signing preparation changes no installer/update behavior.

SignPath Foundation is an alternative application process for qualifying open-source projects, not a fallback enabled here. Its free service requires project acceptance, qualifying component licenses, release provenance, MFA and manual approval for each signed release. Relay's MIT license alone does not establish eligibility, especially for its third-party SDK/runtime arrangement. [SignPath Foundation terms](https://signpath.org/terms)
