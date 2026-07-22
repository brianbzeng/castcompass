# Prospective independent seafloor endpoint collection protocol v1

**Machine contract:**
[`seafloor-independent-endpoint-collection-v1`](../../validation/protocols/seafloor-independent-endpoint-collection-v1.json)

**Contract SHA-256:** `eef862df95d11747aeffc9f6aaff698d6fe2e41d1f74b0092ada3e1dbf673923`

**Status:** frozen locally on 2026-07-22; not activated

## Decision

The next representation comparison must wait for a prospective direct-video collection that can
distribute every frozen seafloor class across independent whole-collection groups. Public mapped
habitat, deterministic suitability models, adjacent rows from the same camera track, and the
support-incomplete DS781/DS182 source families cannot substitute for that endpoint.

This protocol answers only a collection-support question: can a direct visual endpoint be
collected with enough class, region, and source-group support to justify freezing a separate
raster-alignment and representation-comparison protocol? It cannot evaluate an encoder, compare a
candidate with a baseline, authorize promotion, or make a fish or catch claim.

## Activation boundary

The contract is deliberately inactive. Before any site is assigned or observation is collected,
activation requires:

- an externally timestamped preregistration of the exact protocol and hashes;
- legal, privacy, safety, protected-area/permitting, and data-steward review;
- a fixed collection interval and exact site-assignment manifest;
- frozen hashes for the camera/equipment specification and label manual; and
- collector and labeler training plus approved custody for raw media and precise coordinates.

No existing friend, user, fishing trip, or historical video can be backfilled into this protocol.
Frequent fishing-trip logs remain valuable for the separate catch-validation program, including
complete non-encounter attempts, but they are not seafloor labels. A fishing trip contributes here
only if a purpose-built camera deployment is prospectively assigned and collected under the exact
activated contract; the ordinary trip log stays in its separate evidence lane.

## Frozen frame and observation

The eligible frame is limited to the four admitted Santa Barbara South Coast raster blocks:
Offshore Refugio Beach, Offshore Coal Oil Point, Offshore Santa Barbara, and Offshore Carpinteria.
It is the exact footprint after preregistered navigation, access, protected-area, depth, visibility,
and safety exclusions.

Sites are a spatially balanced probability sample within region and fixed depth strata. Candidate
model scores, embeddings, bathymetry texture, and backscatter texture are hidden during frame
construction and assignment. An inaccessible site can be replaced only from its frozen
region-depth reserve list before a seafloor label is observed, with the reason retained. There is
no adaptive hunting for rare classes.

The endpoint unit is one preregistered downward-camera deployment at one assigned site. A usable
deployment requires at least 30 seconds of continuous unedited bottom video and the frozen
deployment, vessel/platform group, collector, camera, assignment, time, coordinate, accuracy,
depth, media hash, and raw-metadata identities. A physical grab can be an optional method check,
but cannot replace video because hard bottom is not reliably grab-sampled.

## Frozen labels and blindness

The exact classes remain:

1. `smooth_fine_medium_sediment`;
2. `mixed_or_rugose_rock`; and
3. `mobile_coarse_sediment`.

Two independent trained labelers, blinded to the candidate inputs, candidate outputs, location
name, and fishing outcomes, classify every usable video under a manual frozen before the first
label. A third trained adjudicator resolves disagreement. `uncertain` and `unusable` are retained
exclusions, not outcome classes. Pseudo-labels, a post-label class collapse, or removing a rare
class are prohibited.

## Grouping, spatial separation, and support

The indivisible group is a whole vessel-or-platform collection day. Rows or deployments from one
group cannot cross a later train/evaluation boundary. Every train, evaluation, and reserve
boundary has a 512 m spatial exclusion buffer. Collector, camera system, region, and depth support
must be reported so one operator or instrument cannot silently define a class.

A future representation protocol may be designed only if at least one whole-group partition has,
on both sides:

- at least 32 retained deployments for every frozen class;
- at least three indivisible groups; and
- observations from at least three regions.

All unique whole-group partitions must be reported; none may be selected because its outcomes
look balanced. Zero eligible partitions means preserve the negative result and stop. A passing
support gate still stops before raster pairing and requires a new frozen protocol.

## Safety and claim boundary

This is never a navigation instruction. Unsafe, illegal, unpermitted, protected-area, poor-
visibility, or equipment-failure conditions require an abort under frozen rules; aborted
deployments remain in flow accounting. Precise coordinates remain least-privilege and are never
public by default.

A support pass would establish collection feasibility for one visual endpoint only. It would not
prove present-day habitat prevalence, fish presence, catch skill, calibration, model superiority,
product quality, or deployment readiness. The local freeze changes no browser, API, Worker,
D1/R2/Queue, provider, production, or deployment state.
