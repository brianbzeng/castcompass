import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [account, privacy, terms, legalPage, compliance] = await Promise.all([
  readFile(new URL("../app/components/AccountFeature.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/privacy/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/terms/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/components/LegalPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../docs/LEGAL-COMPLIANCE.md", import.meta.url), "utf8"),
]);

test("signup collects age before and separately from credentials", () => {
  const ageFormStart = account.indexOf('<form aria-label="Age eligibility"');
  const ageFormEnd = account.indexOf("</form>", ageFormStart);
  const detailsFormStart = account.indexOf("<form onSubmit={submit}>", ageFormEnd);
  const detailsFormEnd = account.indexOf("</form>", detailsFormStart);
  assert.ok(ageFormStart > 0 && ageFormEnd > ageFormStart);
  assert.ok(detailsFormStart > ageFormEnd && detailsFormEnd > detailsFormStart);

  const ageForm = account.slice(ageFormStart, ageFormEnd);
  const detailsForm = account.slice(detailsFormStart, detailsFormEnd);
  assert.match(ageForm, /name="birthDate"/);
  assert.doesNotMatch(ageForm, /name="email"|name="password"|termsAccepted|privacyAccepted/);
  assert.match(detailsForm, /name="email"/);
  assert.match(detailsForm, /name="password"/);
  assert.match(detailsForm, /name="termsAccepted"/);
  assert.match(detailsForm, /name="privacyAccepted"/);
  assert.doesNotMatch(detailsForm, /name="birthDate"/);
});

test("signup sends only age and security token to eligibility, then proof with credentials", () => {
  const ageHandlerStart = account.indexOf("const submitSignupEligibility");
  const ageHandlerEnd = account.indexOf("const resendCode", ageHandlerStart);
  const ageHandler = account.slice(ageHandlerStart, ageHandlerEnd);
  assert.match(ageHandler, /\/api\/auth\/signup\/eligibility/);
  assert.match(ageHandler, /JSON\.stringify\(\{ birthDate: form\.get\("birthDate"\), turnstileToken \}\)/);
  assert.doesNotMatch(ageHandler, /form\.get\("email"\)|form\.get\("password"\)/);
  assert.match(ageHandler, /Account signup is not available with the information provided\./);
  assert.doesNotMatch(ageHandler, /body\.error/);

  const payloadStart = account.indexOf(': mode === "signupDetails"');
  const payloadEnd = account.indexOf(': { email: form.get("email")', payloadStart);
  const signupPayload = account.slice(payloadStart, payloadEnd);
  assert.match(signupPayload, /eligibilityProof/);
  assert.match(signupPayload, /termsAccepted/);
  assert.match(signupPayload, /privacyAccepted/);
  assert.doesNotMatch(signupPayload, /birthDate/);
  assert.match(account, /fetch\("\/api\/auth\/signup\/eligibility", \{ cache: "no-store"/);
  assert.match(account, /signupAvailable === false/);
  assert.match(account, /Account signup is not available from this browser right now/);
});

test("accepted deletion clears only account-related browser state and reports durable cleanup", () => {
  assert.match(account, /body\.deleted !== true/);
  assert.match(account, /response\.status === 200/);
  assert.match(account, /response\.status === 202/);
  assert.match(account, /clearCastingCompassAccountStorage\(\)/);
  assert.match(account, /castingcompass\.active-trip\.v1/);
  assert.match(account, /castingcompass\.reporter-key\.v1/);
  assert.match(account, /castingcompass\.trip-draft\.v1\./);
  assert.match(account, /castingcompass\.profile-trip-draft\.v1\./);
  assert.match(account, /"localStorage", "sessionStorage"/);
  assert.doesNotMatch(account, /localStorage\.clear\(|sessionStorage\.clear\(/);
  assert.match(account, /\/api\/privacy\/deletion-status/);
  assert.match(account, /method: "DELETE"/);
  assert.match(account, /Dismiss status and continue/);
  assert.match(account, /does not cancel any remaining cleanup/);
  assert.match(account, /Stored trip-photo cleanup is continuing in the background/);
  assert.match(account, /flagged for operator attention/);
  assert.match(account, /Download my account records \(JSON\)/);
  assert.match(account, /photo files are separate downloads/);
});

test("trip deletion verifies 200 and 202 outcomes and does not hide photo cleanup", () => {
  const deleteTripStart = account.indexOf("const deleteTrip = async");
  const deleteTripEnd = account.indexOf("const saveGearProfile", deleteTripStart);
  const deleteTrip = account.slice(deleteTripStart, deleteTripEnd);
  assert.match(deleteTrip, /deletionDetailsFromResponse\(body\)/);
  assert.match(deleteTrip, /response\.status === 200/);
  assert.match(deleteTrip, /response\.status === 202/);
  assert.match(deleteTrip, /nextDeletionDetails\.scope !== "trip"/);
  assert.match(deleteTrip, /setDeletionDetails\(nextDeletionDetails\)/);
  assert.match(account, /The trip log has been removed\. Stored-photo cleanup is continuing in the background/);
  assert.match(account, /Stored-photo cleanup is delayed and has been flagged for operator attention/);
  assert.doesNotMatch(account, /account\.user \|\| deletionDetails \|\| deletionStatusCheckedRef/);
  assert.match(account, /resumedDeletionDetails\.scope === "account"/);
  assert.match(account, /setDeletionDetails\(resumedDeletionDetails\)/);
  assert.match(account, /Return to profile/);
});

test("legal reacceptance never recollects birth date and restricted accounts retain privacy rights", () => {
  const handlerStart = account.indexOf("const submitLegalAcceptance");
  const handlerEnd = account.indexOf("const deleteAccount", handlerStart);
  const handler = account.slice(handlerStart, handlerEnd);
  assert.match(handler, /termsAccepted/);
  assert.match(handler, /privacyAccepted/);
  assert.doesNotMatch(handler, /birthDate|acceptTerms|acceptPrivacy/);
  assert.match(account, /account\.user && !account\.user\.ageEligible/);
  assert.match(account, /Account features<br \/>paused/);
  assert.match(account, /will not ask for a birth date alongside an existing account/);
  const restrictedBranches = account.slice(account.indexOf("account.user && !account.user.ageEligible"), account.indexOf(") : account.user ? ("));
  assert.ok((restrictedBranches.match(/Download my account records \(JSON\)/g) ?? []).length >= 2);
  assert.match(account, /: "Permanently delete account"/);
  assert.ok((restrictedBranches.match(/\{accountDeletionButtonLabel\}/g) ?? []).length >= 2);
});

test("versioned legal revision describes age artifacts and deletion limits without claiming production rollout", () => {
  assert.match(legalPage, /LEGAL_EFFECTIVE_DATE = "July 17, 2026"/);
  assert.match(legalPage, /LEGAL_DOCUMENT_VERSION = "2026-07-17\.1"/);
  assert.match(privacy, /one-use eligibility proof or ineligibility marker/);
  assert.match(privacy, /California calendar/);
  assert.match(privacy, /status receipt expires after 30 days/);
  assert.match(privacy, /completed-deletion records are retained for about 90 days/);
  assert.match(terms, /account access/);
  assert.match(terms, /needs operator attention/);
  assert.match(compliance, /local release candidate, not evidence/);
  assert.match(compliance, /production backup-retention window/);
  assert.match(compliance, /counsel review/);
});
