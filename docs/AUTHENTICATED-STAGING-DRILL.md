# Authenticated isolated-staging drill

Status: repository preparation complete; no staging execution or production authority

This contract prepares the narrow authenticated test that remains open after local proof of the
manual advisory-review retry path. It cannot execute a request. No staging host, provider, Queue,
or D1 database was contacted while creating or verifying it.

## Locked boundary

The drill is limited to one pre-authorized synthetic account and two disjoint sets of ten
synthetic completed trips:

- direct mode: two overlapping authenticated retry requests, one authorized client-response
  drop after upstream completion, and eventual recovery of all ten unique trip rows;
- durable Queue mode: two overlapping authenticated retry requests, one duplicate Queue
  delivery, and eventual recovery of a different ten unique trip rows; and
- read-only health/profile evidence plus the single `POST /api/profile/reviews/retry` mutation.

Every production hostname, every `*.castingcompass.com` subdomain, production binding, real user
row, real email destination, outbound callback, and real AI-provider credential/request is out of
scope. The authorization must bind a canonical named HTTPS staging origin, exact clean reviewed
source commit, exact API/Worker/exercise identity, exact internal stub Worker version, the hashed
synthetic account, all twenty hashed trips, a maximum two-hour window, a named independent
authorization record, monitoring, emergency stop, and private evidence access.

The strict policy, authorization schema, deterministic plan builder, and refusal tests are:

- `security/authenticated-staging-drill-policy.json`;
- `contracts/authenticated-staging-drill-authorization.schema.json`;
- `scripts/authenticated-staging-drill.mjs`; and
- `tests/authenticated-staging-drill.test.mjs`.

## Internal AI stub boundary

The normal advisory path still uses the fixed MiMo endpoint. An exercise path exists only when
all of these staging-only values are present and exact:

- service binding `AI_REVIEW_EXERCISE_PROVIDER`;
- the same valid opaque value in `AI_REVIEW_EXERCISE_ID` and `SECURITY_EXERCISE_ID`;
- `AI_REVIEW_EXERCISE_ACCOUNT_HASH` equal to `SHA-256("account:" + serverUserId)` for the one
  synthetic account;
- `AI_REVIEW_EXERCISE_PROVIDER_VERSION_ID` equal to the bound stub Worker version; and
- no `MIMO_API_KEY`, no `MIMO_MODEL`, and no injected public fetcher.

Partial or mixed configuration rejects work before a trip claim. A mismatched synthetic-account
hash releases the exact claim without a provider call. A mismatched stub response version also
fails closed. There is no configurable provider URL and therefore no new SSRF surface. The
production Wrangler build is machine-checked to contain no exercise variables or service
binding.

`worker/ai-review-exercise-stub.ts` is a deterministic, non-model service Worker. Its separate
`staging/ai-review-exercise-stub.wrangler.jsonc` configuration disables `workers.dev`, has zero
public routes, and contains no data, Queue, service, provider, or environment binding. It accepts only
the fixed internal URL, method, contract header, exercise ID, request shape, and 64 KiB body
ceiling. It rejects API keys and Authorization headers, never echoes trip input, always marks its
output as synthetic, requires human review, and sets public-discussion publication false. It has
no route configuration and was not deployed. Cloudflare documents that service bindings call
another Worker without a public URL and can use the binding's `fetch()` interface:
[service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
and [HTTP interface](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/).

## Private preparation only

Verify the committed policy:

```sh
npm run security:authenticated-staging-drill-policy
```

Create an unapproved template outside the repository in a current-user-owned `0700` directory:

```sh
npm run authenticated-staging-drill:write-template -- \
  --output /absolute/private/path/authenticated-staging-authorization.json
```

The writer creates one exclusive `0600` file with approvals and positive safety/evidence
assertions false. The staging owner fills it only from external evidence. Never add a cookie,
token, raw account/trip ID, email address, provider credential, or evidence path to the file.

After all external assertions are true and the authorization names an exact clean commit already
reachable from the reviewed official `origin/main`, create the private plan:

```sh
npm run authenticated-staging-drill:plan -- \
  --authorization /absolute/private/path/authenticated-staging-authorization.json \
  --output /absolute/private/path/authenticated-staging-plan.json
```

Planning performs only local policy/schema/file/checkout verification. It performs no network
preflight and cannot execute the drill. There is deliberately no `run` command or package script.
Actual execution requires a separately reviewed operator procedure, fault proxy, least-privilege
read-only evidence access, and independent tester after the isolated provider resources exist.

## Evidence truthfulness

Both overlapping HTTP requests can observe the same already-queued rows. Their `queued` response
fields therefore must not be summed or treated as provider/Queue dispatch receipts. Acceptance is
based on unique D1 trip/job identities and unique internal-stub requests:

| Scenario | Exact unique reviewed rows | Exact unique stub requests | Real-provider requests |
| --- | ---: | ---: | ---: |
| Direct overlap | 10 | 10 | 0 |
| Durable Queue overlap and duplicate delivery | 10 | 10 | 0 |

The one fault-proxy case proves client-to-Worker response loss and idempotent replay after upstream
completion. It does **not** prove loss of a D1 SDK mutation receipt; that lower-level ambiguity is
covered locally and needs a separately supportable staging injection before it can be claimed as
remote evidence. Local tests are not staging evidence.

Raw evidence stays private. A later minimized aggregate receipt must record exact identities only
as hashes, counts/latency/error classes, zero real-provider requests/cost, zero production access,
remediation/retest, and independent acceptance. Even then, production promotion remains a
separate decision.
