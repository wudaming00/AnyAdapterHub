## Result and scope

Describe the concrete problem and resulting behavior. Select the relevant scope:
documentation, compatibility/evidence, model-profile data, or reviewed code.
For devices, list exact model, firmware (or explicitly unknown), region/protocol
and the path tested (Hub, direct controller/MCP, worker or offline fixture).

## Evidence and remaining limits

Link sanitized repository evidence for each promoted capability. Distinguish
request acceptance, fresh readback, visible/physical effect and completion.
State restoration/cleanup results, untested behavior and compatibility limits.
Do not present fixture tests or earlier direct-tool evidence as new Hub hardware
validation.

## Validation

List exact commands and results. Explain skipped/not-applicable checks and
remaining failures; do not mark a check passed without running it.

```text
Commands:
Results:
Not tested / remaining limits:
```

## Review checklist

- [ ] I followed [CONTRIBUTING.md](../CONTRIBUTING.md), [adapter requirements](../docs/ADAPTER_REQUIREMENTS.md) and [security review](../docs/SECURITY_REVIEW.md) where applicable.
- [ ] Profiles contain data only, exact versions and valid evidence anchors; they do not register code or grant permissions.
- [ ] Changed actions/features preserve fixed schemas, exact target binding, separate install/enable/enroll/features/grants and authorization after asynchronous preparation.
- [ ] Denied/revoked/expired dispatch, stale readback, ambiguous outcomes, no mutation replay and cleanup failure have relevant coverage, or I explain why the change does not affect them.
- [ ] Optional dependencies stay optional; new code/material has pinned provenance and compatible license notices.
- [ ] No credentials, household identifiers, local private paths, maps, personal images or raw diagnostics are included.
- [ ] Relevant profile, package and `npm run check:docs` checks passed. After reviewing/staging intended public files, I ran `npm run check:public` against that Git index, or explained its status.

## Merge authorization

Independent agent review and required CI must complete against the final head
SHA. The designated repository administrator then gives final approval for this
specific PR and SHA. An implementation agent cannot supply that approval,
bypass protection or automatically merge this PR. A new commit requires fresh
review, applicable checks and renewed administrator approval. When the sole
administrator is also the PR author, leave the PR unmerged unless they explicitly
authorize the specific repository-owner operation under
[the policy](../docs/AGENT_REVIEW.md#administrator-approval).

Report security vulnerabilities through the private process in
[SECURITY.md](../SECURITY.md); do not open a public PR with undisclosed exploit
details or sensitive data. Agent review, required branch checks and repository
administrator approval are separate merge requirements; see
[the policy](../docs/AGENT_REVIEW.md).
