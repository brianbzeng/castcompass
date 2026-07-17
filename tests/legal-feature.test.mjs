import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const authPath = new URL("../worker/auth.ts", import.meta.url);
const accountPath = new URL("../app/components/AccountFeature.tsx", import.meta.url);
const privacyPath = new URL("../app/privacy/page.tsx", import.meta.url);
const termsPath = new URL("../app/terms/page.tsx", import.meta.url);
const aiPath = new URL("../app/ai-disclosure/page.tsx", import.meta.url);
const legalPagePath = new URL("../app/components/LegalPage.tsx", import.meta.url);

test("account creation enforces age eligibility and versioned legal acceptance", async () => {
  const [auth, account, legalPage] = await Promise.all([
    readFile(authPath, "utf8"),
    readFile(accountPath, "utf8"),
    readFile(legalPagePath, "utf8"),
  ]);

  assert.match(auth, /MINIMUM_ACCOUNT_AGE = 13/);
  assert.match(auth, /evaluateAgeEligibility\(body\.birthDate\)/);
  assert.match(auth, /assertSignupLegalAcceptance\(body\)/);
  assert.match(auth, /ageEligible: Boolean\(row\.age_eligible\)/);
  assert.match(auth, /age_eligibility_confirmed_at/);
  assert.doesNotMatch(auth, /birth_date\s+TEXT|INSERT INTO [^(]+\([^)]*birth_date/);
  assert.match(account, /I agree to the/);
  assert.match(account, /Terms of Service/);
  assert.match(account, /Privacy Policy/);
  assert.match(account, /submitLegalAcceptance/);
  assert.match(account, /Account features<br \/>paused/);
  assert.match(auth, /LEGAL_VERSION = "2026-07-16\.2"/);
  assert.match(legalPage, /LEGAL_EFFECTIVE_DATE = "July 16, 2026"/);
  assert.match(legalPage, /LEGAL_DOCUMENT_VERSION = "2026-07-16\.2"/);
});

test("privacy controls provide export, deletion, and an optional location notice", async () => {
  const [auth, account] = await Promise.all([
    readFile(authPath, "utf8"),
    readFile(accountPath, "utf8"),
  ]);

  assert.match(auth, /\/api\/profile\/export/);
  assert.match(auth, /request\.method === "DELETE"/);
  assert.match(account, /Download my account records \(JSON\)/);
  assert.match(account, /Delete account/);
});

test("public legal pages separate forecast limitations, privacy, and automated review", async () => {
  const [privacy, terms, ai] = await Promise.all([
    readFile(privacyPath, "utf8"),
    readFile(termsPath, "utf8"),
    readFile(aiPath, "utf8"),
  ]);

  assert.match(privacy, /entered birth date is not retained/);
  assert.match(privacy, /do not currently sell or share personal information/);
  assert.match(privacy, /request already authorized or sent before the deletion transaction cannot be recalled/);
  assert.match(terms, /It does not mean an 80% chance of catching a fish/);
  assert.match(terms, /not navigational data/);
  assert.match(ai, /hybrid ranking system/);
  assert.match(ai, /not a catch probability/);
  assert.match(ai, /response cannot restore the deleted trip or publish a post/);
  assert.match(ai, /Trip reports do not change the current score or enter model evaluation automatically/);
});
