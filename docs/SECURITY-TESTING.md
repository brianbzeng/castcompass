# Isolated security testing

This runbook prepares a bounded OWASP ZAP exercise without implying that a dynamic
security assessment has passed. It is intentionally unusable against production.
The public site, every known alias, every `*.castingcompass.com` hostname, production
bindings, and production user data are outside the permitted scope.

## What the repository now enforces

The locked policy is [security-exercise-policy.json](../security/security-exercise-policy.json)
and the private authorization contract is
[security-exercise-authorization.schema.json](../contracts/security-exercise-authorization.schema.json).
The runner in [security-exercise.mjs](../scripts/security-exercise.mjs) enforces all of the
following before it invokes a scanner:

1. The target is a bare HTTP(S) origin without credentials, paths, queries, or fragments.
   Active mode additionally requires a named remote HTTPS host in `isolated-staging`.
2. Production hostnames and every CastingCompass subdomain are blocked permanently, even
   when an authorization file says otherwise.
3. A written authorization file must be a bounded, non-symlink, `0600` file outside the
   repository, within an eight-hour canonical-UTC window, and match the strict schema.
4. Active mode requires written scope approval, explicit active-test approval, an authorized
   independent tester, synthetic data only, no production bindings or user data, disabled
   external providers and outbound callbacks, a ready monitoring operator, and a verified
   emergency stop.
5. `/api/health` must return the exact expected Worker version and the authorization's opaque
   `securityExerciseId`. Production defaults to `securityExerciseId: null`; only the isolated
   staging release may receive the matching non-secret marker.
6. The generated plan is limited to public unauthenticated pages and `/api/health`. Every other
   API route, `/profile`, and the image optimizer are excluded. ZAP uses one thread per host,
   a 250 ms delay, low attack strength, a two-minute per-rule ceiling, and a 15-minute total
   active-scan ceiling.
7. The scanner image is OWASP ZAP 2.17.0 at immutable image-index digest
   `sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2`.
   Docker runs read-only, drops all capabilities, forbids privilege escalation, caps CPU,
   memory, processes, and time, and uses `--pull=never`.

Raw plans, scanner logs, and reports can contain the staging hostname or HTTP evidence. They
must stay in the private output directory and must never be committed, attached to a public PR,
or pasted into a general-purpose dashboard. The aggregate receipt intentionally contains no
hostname, path, exercise ID, request, response, cookie, token, or finding text.

## Required staging boundary

Do not prepare an active authorization until all of these external gates exist:

- a separate staging hostname, D1 database, R2 bucket, rate-limit namespaces, secrets, email
  sink, Turnstile configuration, AI-provider stub, and synthetic accounts;
- no route to production data, bindings, credentials, queues, email recipients, AI provider,
  webhooks, or out-of-band application-security callbacks;
- a staging release built from the authorization's exact source commit with
  `SECURITY_EXERCISE_ID` set to its opaque exercise ID;
- a named monitoring operator with an emergency disable/maintenance action already tested;
- written scope, time window, cost/rate ceilings, evidence location, independent tester, and
  stop conditions; and
- separate synthetic accounts for later authenticated IDOR and business-logic testing.

The current Cloudflare service is paused and no isolated target is provisioned. Therefore no
active authorization exists and no scan should run now.

## Offline policy and plan preparation

Verify the committed, fail-closed policy:

```sh
npm run security:exercise-policy
```

The staging owner creates the authorization file privately. Never commit it. The exact field
shape is defined by the schema; a draft must begin with all approvals and safety assertions set
to `false` and may be changed only from recorded external evidence. IDs are opaque, timestamps
are canonical UTC, and the window may not exceed eight hours.

Make both the authorization and evidence parent private:

```sh
chmod 600 /absolute/private/path/security-exercise-authorization.json
chmod 700 /absolute/private/path/evidence-parent
```

Generate the plan without contacting the target:

```sh
npm run security:exercise-plan -- \
  --authorization /absolute/private/path/security-exercise-authorization.json \
  --output /absolute/private/path/evidence-parent/prepared-plan
```

This command validates the authorization and writes a private plan. It does not perform the
network preflight and cannot run ZAP.

## Authorized execution

The staging owner first retrieves the immutable image explicitly and verifies the repo policy
again. The runner itself never pulls an image:

```sh
docker pull ghcr.io/zaproxy/zaproxy@sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2
npm run security:exercise-policy
```

Only during the approved window, from a clean exact-source checkout, run:

```sh
CASTINGCOMPASS_SECURITY_EXERCISE_AUTHORIZATION=I_HAVE_WRITTEN_AUTHORIZATION_FOR_THIS_ISOLATED_STAGING_TARGET \
  npm run security:exercise-run -- \
  --authorization /absolute/private/path/security-exercise-authorization.json \
  --output /absolute/private/path/evidence-parent/exercise
```

The runner performs the staging marker/version preflight before creating evidence or invoking
Docker. Scanner output is captured privately rather than printed to the terminal. A missing
image, nonzero scanner result, malformed report, medium/high/critical alert, or any failed guard
returns a failure.

## Acceptance boundary

Even a clean aggregate receipt has `production_ready: false`. This public unauthenticated scan
does not exercise authenticated workflows, cross-account IDOR behavior, email/AI/provider
composition, browser extensions, infrastructure consoles, or business logic. L10 stays open
until an independent tester completes the written authenticated/manual scope, critical and high
findings are fixed and retested, and a separate independent acceptance receipt is recorded.

Never use this runner as permission to load-test or penetration-test a host. Written owner
authorization, the isolated staging boundary, and applicable law/provider rules remain required.
