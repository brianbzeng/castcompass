import type { Metadata } from "next";
import { LegalPage, LegalSection } from "../components/LegalPage";

const PAGE_URL = "https://castingcompass.com/ai-disclosure";
const PAGE_TITLE = "AI and Forecast Disclosure · CastingCompass";
const PAGE_DESCRIPTION =
  "How CastingCompass uses a heuristic relative ranker, public forecast inputs, model research, and human-gated AI review.";

export const metadata: Metadata = {
  title: "AI and Forecast Disclosure",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  openGraph: {
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    type: "website",
    url: PAGE_URL,
    siteName: "CastingCompass",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "CastingCompass — California Halibut Opportunity Planner" }],
  },
  twitter: {
    card: "summary_large_image",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    images: [{ url: "/og.png", alt: "CastingCompass — California Halibut Opportunity Planner" }],
  },
};

export default function AiDisclosurePage() {
  return (
    <LegalPage
      eyebrow="Transparency · Automated systems"
      title="AI and Forecast Disclosure"
      summary="CastingCompass uses automated scoring and a third-party language model. This page separates what is live today from research that is still being tested."
    >
      <LegalSection title="The live Opportunity Score">
        <p>The live score is a hybrid ranking system. It combines curated habitat and access information, public seasonal data, tides, weather and marine conditions, daylight and moon context, and practical fishability adjustments. The result is converted to a 0–100 percentile among the current location and time-window candidates.</p>
        <p>It is not a catch probability, a statement that halibut are present, or a promise that the water is safe or practical to fish. Public inputs can be wrong or unavailable, and the rules and weights are still being evaluated against real trip reports.</p>
      </LegalSection>

      <LegalSection title="Deep-learning research status">
        <p>CastingCompass has a bathymetry pretraining and model-research pipeline intended to learn useful underwater terrain representations. Unless the product expressly labels a deployed model version as trained and validated, that research output is not the live Habitat Score. The live product will not claim a deep-learning accuracy improvement until geographically blocked evaluation shows a reliable ranking gain over simpler baselines.</p>
      </LegalSection>

      <LegalSection title="Trip-note and gear review">
        <p>When a signed-in angler completes or edits a trip report, Xiaomi MiMo may review a limited trip payload. It normalizes recognizable rod, reel, lure, and rig names; flags inconsistent or unsafe content; and may prepare a pseudonymous discussion draft. A queued review is authorized only after a final deletion-record check. Deletion committed before that point cancels the request; a provider request already authorized or sent before deletion cannot be recalled, although its response cannot restore the deleted trip or publish a post. The model cannot publish or approve the draft. A human moderator must approve it before it can appear publicly.</p>
        <p>Automated review can misunderstand a note or gear product. It does not determine legal guilt, eligibility for a benefit, employment, credit, health care, housing, or another high-impact decision. Users can request correction or removal by contacting <a href="mailto:bzeng0000@gmail.com">bzeng0000@gmail.com</a>.</p>
      </LegalSection>

      <LegalSection title="Data sent for review">
        <p>The review can receive the curated site and type, trip time, method, effort and catch counts, gear entries, observed fishability, forecast/model context, and up to 1,000 characters of notes. CastingCompass deliberately omits the user’s email, internal account ID, uploaded photo, and structured browser-location or coordinate fields. Free-text trip fields are sent as entered and could contain details the user typed.</p>
      </LegalSection>

      <LegalSection title="How to interpret explanations">
        <p>Component scores and explanation text describe the inputs that influenced the ranking. They are not proof of causation. Conditions such as tide and weather can be correlated with each other, and a high score can still produce a skunk. Trip reports do not change the current score or enter model evaluation automatically; any future use requires the separate validation protocol.</p>
      </LegalSection>

      <LegalSection title="Regulatory approach">
        <p>There is no single universal “FTC AI disclosure” form. CastingCompass follows the core consumer-protection principle that claims about automated systems must be truthful, supported, and not misleading. This page, the score explanation, source freshness labels, and the Terms are designed to make the present limitations conspicuous.</p>
        <p>California generative-AI training-data and synthetic-media provenance laws may become relevant if CastingCompass later develops or publicly releases covered generative systems. The current opportunity ranker and private note-review workflow are not presented as a general-purpose generative-AI service. This assessment will be revisited when features change.</p>
      </LegalSection>
    </LegalPage>
  );
}
