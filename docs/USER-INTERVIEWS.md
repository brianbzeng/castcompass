# Privacy-safe comprehension interviews

These five short scripts test whether people understand CastingCompass's current language. They
are usability and comprehension research only. They cannot validate the Opportunity Score,
estimate catch probability, demonstrate fishing outcomes, or support a safety, access, legality,
freshness, or accuracy claim.

The machine-checked source is
[`research/user-interview-plan.json`](../research/user-interview-plan.json). Its current status is
`draft_only`, and `researchExecutionAuthorized` remains `false`. Publishing this document does not
authorize recruitment, recording, analytics, a provider integration, or production data
collection.

## Facilitator boundary

Use only fictional screens, locations, conditions, and trip reports. Before beginning, say:

> This is a short comprehension check, not fishing advice. Please answer only from the fictional
> screen. Do not share your name, contact information, account details, credentials, precise
> fishing locations, real trip notes, fishing history, photos, or files. The session is not
> recorded.

Do not ask for an account or sign-in. Do not record audio, video, a transcript, raw quotes, or
participant-level notes. Do not paste responses into CastingCompass, Codex, GitHub, analytics, or
application logs. After a separately approved research session, the only permitted output is an
aggregate non-identifying tally using `understood`, `partly_understood`, `misunderstood`, or
`not_observed` for each script.

If someone volunteers sensitive information, interrupt politely. Do not copy, paraphrase, or
retain the value. Return to the fictional scenario and exclude the affected response from the
tally. Participation must be voluntary, and the person may stop without explanation.

### Interview 1 — What the Opportunity Score means

Show a fictional screen where Site A has an Opportunity Score of 82 and Site B has 61 for the
same species and time window.

1. In your own words, what does the score of 82 mean here?
2. Would you read 82 as an 82 percent chance of catching a fish, and why?
3. What does this comparison not tell you?
4. What would you verify somewhere else before deciding whether to go?

Listen for a relative comparison, not a probability or promise, plus separate safety, access,
regulation, and current-condition checks. Do not correct the person until all four questions are
complete.

### Interview 2 — Reading source freshness

Show a fictional forecast card with one source marked updated two hours ago and another marked
stale.

1. Which part of this screen tells you how current the information is?
2. What would you do after seeing that one source is stale?
3. Does a recently updated source guarantee that the displayed conditions are correct, and why?
4. What wording or visual treatment would make freshness easier to understand?

Listen for source-specific timestamps, reduced reliance on stale inputs, and recognition that
recent data may still be incomplete, delayed, or different from local conditions.

### Interview 3 — Understanding limitations and outside checks

Show a fictional planning card with a relative rank, uncertainty copy, and links to official
sources.

1. Does this screen tell you that a place is safe, legal, open, or accessible?
2. Which facts would you verify with official or local sources?
3. What uncertainty remains after reading the explanation?
4. How would you describe the planner's role to another person?

Listen for the distinction between comparing options and certifying a trip. Regulations,
forecasts, notices, access rules, and real local conditions all require separate checks.

### Interview 4 — Trip-report privacy expectations

Show a fictional pending trip report and explain that only a human-approved aggregate may become
public. Do not ask the person to enter or describe a real report.

1. What would you expect other visitors to see from this pending report?
2. Which information should never become public?
3. Would you expect the pending report itself to be public before human review, and why?
4. What privacy explanation would you want to see before submitting a future report?

Listen for a private pending state, explicit human approval, and exclusion of raw notes, identity,
precise coordinates, and photos from public summaries.

### Interview 5 — Making a decision from the whole screen

Show two fictional windows with different relative ranks, source ages, uncertainty messages, and
official-source links.

1. Which information would you look at first, and why?
2. What would make you pause before relying on the higher-ranked option?
3. Which decisions can this screen support, and which decisions must stay with you?
4. How would you explain the score, freshness, limitations, and privacy boundaries in one sentence?

Listen for rank, freshness, uncertainty, and outside verification being considered together. A
higher rank cannot override stale inputs or a separate safety, access, and legality decision.

## What completion means

Drafting and checking these scripts completes only the owner-safe writing task in
[`GOAL_STATUS.md`](GOAL_STATUS.md). It does not mean that anyone has been recruited, interviewed,
recorded, or observed; it does not establish a research sample or a performance result; and it
does not change the all-zero public validation status in
[`validation/public-status.json`](../validation/public-status.json).
