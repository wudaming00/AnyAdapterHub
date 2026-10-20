# Maintainer checks

This is a development-preview checklist for review and distribution. It does not replace independent security review. Contributor setup and privacy requirements are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Review one concrete change

1. Confirm whether the change is documentation, compatibility evidence, a profile, or executable behavior. A schema-valid profile is not proof of its claims.
2. Review the actual diff and dependency/provenance changes. Reject arbitrary module/endpoint execution, automatic enrollment and hidden authority expansion.
3. For a new action/adapter, inspect [the contract](ADAPTER_REQUIREMENTS.md) and [security checklist](SECURITY_REVIEW.md): exact target/account binding, denied permissions, asynchronous dispatch boundaries, deadlines, ambiguous effects and cleanup.
4. Require exact model/firmware/capability evidence. Keep unknown firmware unknown and leave untested behavior unverified. Transport changes may invalidate older hardware evidence.
5. Review public data. Screens, maps, addresses, private paths, account identifiers and both plaintext/encrypted credential files do not belong in a PR.
6. Run checks against the final revision, with optional dependencies explicitly selected. Record platform skips and remaining failures. CodeQL success means the analysis ran, not zero findings.
7. Obtain the repository's required code-owner approval before merging. Do not weaken protection or treat green automation as a human approval. Administrators may have a technical bypass; its existence is not an independent review.

If the source or scope changes after review, update the title/description and rerun affected checks. Follow the repository's active protections rather than relying on a stale checklist.

## Check commands

```sh
npm ci --ignore-scripts
npm run adapter:lg:install
npm test
npm run check:profiles
npm run check:docs
npm run check:package
```

Run the optional Python safety tests using the environment in [the worker guide](../optional/ecovacs/README.md). Run the fixed-tool/runtime preflight where applicable:

```sh
node scripts/check-security-runtime.mjs
```

After explicitly staging the intended public files, run `npm run check:public` and `git diff --cached --check`. The source privacy check reads staged bytes; documentation checks read the public working tree. Verify both represent the change you intend to ship.

Inspect the actual package dry-run file list. An allowlisted source path can still contain a secret; automated matching supplements human inspection. Never stage a live Hub home, enrollment, raw diagnostic, personal screenshot or lab payload.

## Hardware and security evidence

Use authorized, bounded tests on one selected device. Prefer read-only validation; a write needs an appropriate owner-approved scenario, baseline, effect readback and restoration where applicable. Do not dispatch a consequential action just to improve CI coverage.

Update evidence only with what the test established. A screen showing an app does not prove a title, a robot status does not prove a job's completion, and offline fixtures do not promote another model to hardware verified.

Coordinate vulnerabilities through [private reports](https://github.com/wudaming00/AnyAdapterHub/security/advisories/new). Prepare sanitized public notes after the fix is ready; do not post active credentials, household details or exploit material in ordinary issues.

## Distribution and deployment

The repository is source-distributed and `package.json` remains `private: true`. A package version is not an npm publication, release tag, signed binary or maintenance commitment. Changing publication scope requires a separate explicit release decision.

Preserve [license/provenance notices](../THIRD_PARTY_NOTICES.md), including the optional GPL worker. Check that referenced documentation ships in the package. Do not infer that subprocess separation removes license obligations.

Install a reviewed revision, stop the previous daemon using its original terminal/launcher, follow [migration](SECURE_SETUP.md#existing-installations) if needed, and restart. Merging source does not update a running installation. Do not expose the loopback service through a tunnel or LAN listener without a separate design/security review.

Review [the changelog](../CHANGELOG.md), [supported devices](SUPPORTED_DEVICES.md) and [roadmap](ROADMAP.md) before describing a release. Keep initial-trust, same-user access, unencrypted legacy LAN legs, unsupported OS providers and incomplete hardware validation visible.
