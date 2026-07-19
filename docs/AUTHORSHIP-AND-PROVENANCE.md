# Authorship and provenance operations

## What this control proves

CastingCompass maintains a strict public-asset register at
[`governance/authorship-provenance.json`](../governance/authorship-provenance.json). Every shipped
JPG, PNG, SVG, and WebP under `public/` must have one record and an exact SHA-256. Third-party
reference images must also carry a creator, source page, source review date, remote SHA-1, rights
basis, direct license or public-domain-assertion link, attribution copy, and change disclosure.

This is evidence hygiene, not a copyright registration, trademark clearance, assignment, or
legal opinion. Git author history proves repository custody and changes; it does not by itself
prove who created a work or who owns its rights.

## Current truthful boundary

- The seven structure-reference photos have evidence-reviewed source records. Their local hashes
  and the live credit/license/change copy are bound by CI.
- Eight pre-policy brand, icon, social-card, and topography paths are preserved on an exact legacy
  allowlist. Their creator, source layers, assignment/license, and AI-assistance history still
  need owner confirmation. They are not represented as rights-cleared merely because they are in
  Git.
- New visual assets cannot inherit the legacy exception. An unregistered file, duplicate path,
  hash change, unknown license, missing direct license link, live-copy mismatch, or newly invented
  legacy status fails the verifier.
- `productionReadiness` remains false. This control does not resume Cloudflare or authorize a
  release.

## Safe update workflow

1. Create a stable record ID before adding the asset to `public/`.
2. Record the creator and creation date. If either is unknown, stop and obtain confirmation; do
   not add another legacy exception.
3. Preserve the original source URL, source-file checksum, license/assignment basis, direct
   license URL, required credit, modification rights, actual transformations, AI assistance, and
   the commit or release where the asset first appears.
4. Keep original/source files and any signed agreement in a private owner-controlled record
   system. Never commit contracts, legal advice, signatures, home addresses, personal email,
   credentials, or secret material. A future register entry may use only a non-sensitive opaque
   receipt ID such as `receipt_` plus 32 lowercase hexadecimal characters.
5. Update the live attribution data and public documentation when a third-party asset is used.
6. Run `npm run security:authorship-provenance:write`, review the report diff, then run
   `npm run security:authorship-provenance` and the complete repository suite.
7. Preserve the accepted commit, protected PR checks, merge hash, and archived public release
   receipt. Counsel should decide whether any separate registration or filing is appropriate.

## Owner confirmation for existing brand assets

For each legacy record, privately answer and preserve evidence for:

- who created the original and on what date;
- where the editable source/layers are stored;
- whether stock, fonts, maps, photographs, public data, templates, or other third-party material
  appears in it and under what terms;
- whether generative or assistive AI was used, which tool/account was used, and what human work
  followed;
- whether CastingCompass owns the work or has a written license/assignment, including modification
  and commercial-use rights;
- which public release and archived artifact first used it.

Do not put the private answers into Git. After review, update only the non-sensitive factual fields
and optional opaque receipt identifier through a protected PR.

## Artist collaboration checklist (for later P3 work)

Before commissioning or publishing a friend's artwork, agree in writing on:

- scope, deliverables, milestones, revisions, acceptance, and file formats/source-file delivery;
- credit wording and placement;
- payment, expenses, cancellation, and timing;
- ownership versus license, exclusivity, duration, territory, commercial use, sublicensing, and
  modification/derivative-work rights;
- warranties about original and third-party material, including stock assets, fonts, references,
  and AI assistance;
- whether either party may use the work in a portfolio, social post, case study, or merchandise;
- confidentiality, record retention, takedown/dispute handling, signatures, and governing terms.

That agreement belongs in the private business-record folder and should be reviewed by qualified
counsel when the stakes justify it. The repository should receive only the approved asset, its
public-safe provenance record, and a non-sensitive receipt identifier if one is useful.
