# Security Policy

CastingCompass welcomes good-faith reports that help keep anglers and their data safe.

## Supported deployment

Security fixes target the current production deployment at
[castingcompass.com](https://castingcompass.com). Old source revisions and unofficial
deployments are not supported.

## Report a vulnerability

Email **bzeng0000@gmail.com** with the subject `CastingCompass security report`.
Please include:

- the affected URL or component;
- a concise description of the issue and its likely impact;
- reproduction steps or a minimal proof of concept; and
- a safe way to contact you for follow-up.

Do not include passwords, access tokens, precise user locations, or another person's
private data in the initial report. If sensitive evidence is necessary, ask for a
secure transfer method first. Please do not open a public GitHub issue for an
unresolved vulnerability.

## Coordinated disclosure expectations

Please:

- test only accounts and data you own or are authorized to use;
- avoid denial-of-service testing, automated high-volume traffic, social engineering,
  spam, and physical testing;
- do not access, modify, retain, or disclose another user's data;
- stop testing and report immediately if you encounter private data; and
- allow a reasonable remediation period before public disclosure.

We will acknowledge a credible report as soon as practical, aim to triage it within
seven days, and share remediation status when possible. CastingCompass is a small,
independent project, so these are targets rather than a service-level agreement or a
bug-bounty offer.

## Scope

In scope:

- `https://castingcompass.com`;
- the CastingCompass Cloudflare Worker and first-party public APIs; and
- authentication, account, trip-report, saved-location, and gear-profile flows.

Third-party services, public data providers, social-engineering attacks, and content
outside CastingCompass's control are out of scope. Report vulnerabilities in
third-party platforms to their owners.
