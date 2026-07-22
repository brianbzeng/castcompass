import { readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";
import { resolve } from "node:path";

const SITES_FIXTURE = readFileSync(resolve(process.cwd(), "public/data/sites.json"), "utf8");
const OPPORTUNITIES_FIXTURE = readFileSync(
  resolve(process.cwd(), "public/data/opportunities.json"),
  "utf8",
);
const STRUCTURE_DEPTH_FIXTURE = readFileSync(
  resolve(process.cwd(), "public/data/structure-depth.json"),
  "utf8",
);

test.use({ serviceWorkers: "block" });

const OPPORTUNITY_FIXTURE_VALID_FROM = JSON.parse(readFileSync(
  new URL("../public/data/opportunities.json", import.meta.url),
  "utf8",
)).validFrom as string;

const ACCOUNT_BROWSER_STORAGE_KEYS = [
  "castingcompass.active-trip.v1",
  "castingcompass.reporter-key.v1",
  "contourcast.active-trip.v1",
  "contourcast.reporter-key.v1",
  "castingcompass.trip-draft.v1.past",
  "castingcompass.profile-trip-draft.v1.trip_edit",
  "castingcompass.trip-request.v1.past",
  "castingcompass.trip-pending.v1.past",
  "contourcast.trip-draft.v1.past",
  "contourcast.profile-trip-draft.v1.trip_edit",
] as const;

async function seedAccountBrowserStorage(page: Page) {
  await page.evaluate((keys) => {
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (const key of keys) storage.setItem(key, `private:${key}`);
      storage.setItem("castingcompass.respect-water.v1", "dismissed");
      storage.setItem("unrelated.site.preference", "preserve");
    }
  }, ACCOUNT_BROWSER_STORAGE_KEYS);
}

async function accountBrowserStorageSnapshot(page: Page) {
  return page.evaluate((keys) => ({
    localAccountValues: keys.map((key) => window.localStorage.getItem(key)),
    sessionAccountValues: keys.map((key) => window.sessionStorage.getItem(key)),
    localPreference: window.localStorage.getItem("castingcompass.respect-water.v1"),
    sessionPreference: window.sessionStorage.getItem("castingcompass.respect-water.v1"),
    localUnrelated: window.localStorage.getItem("unrelated.site.preference"),
    sessionUnrelated: window.sessionStorage.getItem("unrelated.site.preference"),
  }), ACCOUNT_BROWSER_STORAGE_KEYS);
}

function expectAccountBrowserStorageCleared(snapshot: Awaited<ReturnType<typeof accountBrowserStorageSnapshot>>) {
  expect(snapshot.localAccountValues.every((value) => value === null)).toBe(true);
  expect(snapshot.sessionAccountValues.every((value) => value === null)).toBe(true);
  expect(snapshot.localPreference).toBe("dismissed");
  expect(snapshot.sessionPreference).toBe("dismissed");
  expect(snapshot.localUnrelated).toBe("preserve");
  expect(snapshot.sessionUnrelated).toBe("preserve");
}

const TURNSTILE_MOCK_SCRIPT = `(() => {
  let sequence = 0;
  const widgets = new Map();
  window.turnstile = {
    render(container, options) {
      const id = "mock-widget-" + (++sequence);
      const widget = document.createElement("div");
      widget.dataset.mockTurnstile = String(options.size);
      widget.dataset.mockTurnstileRetry = String(options.retry);
      widget.dataset.mockTurnstileFeedback = String(options["feedback-enabled"]);
      widget.setAttribute("aria-label", "Mock Turnstile challenge");
      widget.style.width = options.size === "compact" ? "150px" : "100%";
      widget.style.maxWidth = "100%";
      widget.style.height = "65px";
      container.replaceChildren(widget);
      widgets.set(id, container);
      window.setTimeout(() => options.callback("mock-action-bound-token"), 0);
      return id;
    },
    remove(id) {
      widgets.get(id)?.replaceChildren();
      widgets.delete(id);
    }
  };
})();`;

async function preparePastTripForSubmission(page: Page) {
  const trigger = page.locator(".log-trip-button");
  const modal = page.locator(".trip-modal");
  const location = modal.getByRole("combobox", { name: "Fishing location" });
  await expect(page.locator(".account-label-compact")).toHaveText("Profile");
  await trigger.click();
  await expect(modal).toBeVisible({ timeout: 8_000 });
  await expect(location).toBeVisible({ timeout: 8_000 });
  await expect(modal.locator(".site-combobox-status")).toHaveText(/^Selected: .+$/);
  const fishingMode = modal.getByLabel("Fishing mode for the whole trip");
  await fishingMode.focus();
  await expect(location).toHaveAttribute("aria-expanded", "false");
  await fishingMode.selectOption("shore");
  await modal.getByLabel("Did the score influence this trip?").selectOption("no");
  await modal.getByRole("button", { name: "Continue to gear + result" }).click();
  for (const checkbox of await modal.locator(".consent-field input").all()) await checkbox.check();
  return modal;
}

function pastTripReceipt(route: Route) {
  const tripId = route.request().postData()?.match(/trip_[a-f0-9-]{36}/)?.[0];
  if (!tripId) throw new Error("Past-trip request did not include a client trip identity.");
  return {
    trip: { id: tripId, status: "completed", source: "past_report", hasPhoto: false },
    receipt: { operation: "past", tripId },
  };
}

async function prepareAccountDeletion(page: Page) {
  await page.locator(".account-button").click();
  const modal = page.locator(".account-modal");
  await expect(modal.getByRole("heading", { name: "Your fishing profile." })).toBeVisible();
  const deletion = modal.locator(".profile-privacy-section .account-delete-details");
  await deletion.locator("summary").click();
  await deletion.getByLabel("Password").fill("correct horse battery staple");
  await deletion.getByLabel("Type DELETE").fill("DELETE");
  return { modal, deletion };
}

async function prepareTripDeletion(page: Page) {
  await page.locator(".account-button").click();
  const modal = page.locator(".account-modal");
  await expect(modal.getByRole("heading", { name: "Your fishing profile." })).toBeVisible();
  const trip = modal.locator(".profile-trip").filter({ hasText: "Limantour Beach" });
  await expect(trip).toBeVisible();
  return { modal, trip };
}

async function prepareTripEdit(page: Page) {
  const { modal, trip } = await prepareTripDeletion(page);
  await trip.getByRole("button", { name: "Edit" }).click();
  const editor = modal.locator(".profile-trip-editor-modal");
  await expect(editor.getByRole("heading", { name: "Edit trip log" })).toBeVisible();
  await editor.getByLabel("Notes", { exact: true }).fill("Draft retained during recovery testing");
  return { modal, trip, editor };
}

async function prepareGearMutation(page: Page) {
  await page.locator(".account-button").click();
  const modal = page.locator(".account-modal");
  await expect(modal.getByRole("heading", { name: "Your fishing profile." })).toBeVisible();
  const gear = modal.locator(".profile-gear-section");
  await gear.getByLabel("Preset name").fill("Recovery test preset");
  return { modal, gear };
}

async function prepareSignOut(page: Page) {
  await page.locator(".account-button").click();
  const modal = page.locator(".account-modal");
  await expect(modal.getByRole("heading", { name: "Your fishing profile." })).toBeVisible();
  return { modal, controls: modal.locator(".account-signout-controls") };
}

async function prepareSavedSiteMutation(page: Page) {
  const siteCard = page.locator(".site-card").filter({ hasText: "Limantour Beach" });
  await siteCard.click();
  const detail = page.locator(".detail-sheet");
  await expect(detail.getByRole("heading", { name: "Limantour Beach" })).toBeVisible();
  return { detail, controls: detail.locator(".saved-site-controls") };
}

async function expectSelectorInsideViewport(page: Page, selector: string) {
  const locators = page.locator(selector);
  const count = await locators.count();
  expect(count, `${selector} should exist`).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const locator = locators.nth(index);
    await expect(async () => {
      const [box, viewportWidth] = await Promise.all([
        locator.boundingBox(),
        page.evaluate(() => window.innerWidth),
      ]);
      expect(box, `${selector} should have a visible box`).not.toBeNull();
      expect(box!.x, `${selector} starts inside the viewport`).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width, `${selector} ends inside the viewport`).toBeLessThanOrEqual(viewportWidth + 1);
    }).toPass({ intervals: [50, 100, 250], timeout: 8_000 });
  }
}

async function ensureInteractiveMap(page: Page) {
  const centerButton = page.getByRole("button", { name: /fit sites/i });
  const loadMap = page.getByRole("button", { name: /open interactive map/i });
  const map = page.locator(".map-wrap");

  await expect(async () => {
    await expect(map).toBeVisible({ timeout: 1_000 });
    await map.scrollIntoViewIfNeeded({ timeout: 1_000 });
    if (await centerButton.isVisible()) return;
    if (await loadMap.isVisible()) await loadMap.click({ timeout: 1_000 }).catch(() => undefined);
    await expect(centerButton).toBeVisible({ timeout: 1_000 });
  }).toPass({ intervals: [100, 250, 500], timeout: 15_000 });
}

test.beforeEach(async ({ page }, testInfo) => {
  // These tests exercise responsive UI and recovery contracts, not the static server's stream
  // implementation. Fulfill the committed catalog and forecast from memory so every project sees
  // the same source data even when Vinext closes a large static-file stream under CI concurrency.
  await page.route("**/data/sites.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: SITES_FIXTURE,
  }));
  await page.route("**/data/opportunities.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: OPPORTUNITIES_FIXTURE,
  }));
  await page.route("**/data/structure-depth.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: STRUCTURE_DEPTH_FIXTURE,
  }));
  const testTitle = testInfo.titlePath.join(" ");
  if (testTitle.includes("failed lazy route dependency")) {
    await page.route("**/assets/ContourMap-*.js", (route) => route.abort());
  }
  const profileRecoveryTest = testTitle.includes("failed profile load stays unknown");
  const tripRecoveryTest = testTitle.includes("trip submissions pause while offline") ||
    testTitle.includes("slow trip save stays pending") ||
    testTitle.includes("failed trip save remains ambiguous");
  const accountDeletionRecoveryTest = testTitle.includes("account deletion pauses while offline") ||
    testTitle.includes("confirmed account deletion clears only") ||
    testTitle.includes("slow account deletion stays unconfirmed") ||
    testTitle.includes("failed account deletion stays ambiguous");
  const tripDeletionRecoveryTest = testTitle.includes("trip deletion pauses while offline") ||
    testTitle.includes("slow trip deletion stays unconfirmed") ||
    testTitle.includes("failed trip deletion stays ambiguous");
  const tripEditRecoveryTest = testTitle.includes("trip edit pauses while offline") ||
    testTitle.includes("slow trip edit stays unconfirmed") ||
    testTitle.includes("failed trip edit stays ambiguous") ||
    testTitle.includes("rejected trip edit remains correctable");
  const gearMutationRecoveryTest = testTitle.includes("gear changes pause while offline") ||
    testTitle.includes("slow gear creation stays unconfirmed") ||
    testTitle.includes("failed gear creation stays ambiguous") ||
    testTitle.includes("rejected gear creation remains correctable") ||
    testTitle.includes("failed gear removal stays ambiguous");
  const signOutRecoveryTest = testTitle.includes("sign-out pauses while offline") ||
    testTitle.includes("exact sign-out receipt clears only") ||
    testTitle.includes("sign-out warns when browser storage cleanup is blocked") ||
    testTitle.includes("slow sign-out stays unconfirmed") ||
    testTitle.includes("malformed sign-out receipt stays unresolved") ||
    testTitle.includes("session check confirms sign-out") ||
    testTitle.includes("session check permits a retry");
  const savedSiteRecoveryTest = testTitle.includes("saved-location changes pause while offline") ||
    testTitle.includes("slow saved-location removal stays unconfirmed") ||
    testTitle.includes("malformed saved-location receipt stays unresolved");
  const waterQualityAdvisoryTest = testTitle.includes("official water-quality status suppresses recommendations");
  const structureDepthEvidenceTest = testTitle.includes("source-bound Santa Barbara chart context")
    || testTitle.includes("source-bound San Francisco chart context")
    || testTitle.includes("source-bound San Mateo Coast")
    || testTitle.includes("source-bound Marin Coast")
    || testTitle.includes("source-bound North and East Bay")
    || testTitle.includes("source-bound Oakland through South Bay");
  if (structureDepthEvidenceTest) {
    // Keep the committed opportunity fixture selectable so the stable site deep link opens its
    // detail sheet instead of expiring as wall-clock time advances.
    await page.clock.setFixedTime(new Date(OPPORTUNITY_FIXTURE_VALID_FROM));
    await page.route("**/api/discussions/*", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ posts: [] }),
    }));
  }
  if (waterQualityAdvisoryTest) {
    // Keep both the advisory and the committed opportunity fixture current. Freezing the clock
    // before the opportunity validity window leaves every site without a selectable "today"
    // window, so a valid shared-site link cannot open its detail sheet.
    await page.clock.setFixedTime(new Date(OPPORTUNITY_FIXTURE_VALID_FROM));
    const assessment = (overrides: Record<string, unknown>) => ({
      status: "no-active-posting",
      recommendationEffect: "neutral",
      officialLabel: "No active posting reported",
      detail: "Neutral context only. This does not mean the water or seafood is safe and does not improve the fishing score.",
      sourceId: "sfpuc",
      stationIds: ["4612"],
      stationNames: ["Crissy Field Beach East"],
      sampleDates: ["2026-07-13"],
      actionStartDates: [],
      actionEndDates: [],
      checkedAt: "2026-07-17T12:00:00Z",
      scoreDelta: null,
      sourceUrl: "https://webapps.sfpuc.org/sapps/beachesandbay.html",
      ...overrides,
    });
    await page.route("**/data/water-quality.json", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "castingcompass.water-quality-advisory/2.0.0",
        policyVersion: "test-policy",
        generatedAt: "2026-07-17T12:00:00Z",
        status: "partial",
        freshness: { maximumSampleAgeDays: 10 },
        scoreContribution: {
          mode: "excluded-pending-frozen-baseline-validation",
          positiveContributionAllowed: false,
          activeAgencyStatusSuppressesRecommendation: true,
        },
        sources: {
          sfpuc: {
            agency: "San Francisco Public Utilities Commission",
            programUrl: "https://www.sfpuc.gov/programs/ocean-and-beach-monitoring",
            statusUrl: "https://webapps.sfpuc.org/sapps/beachesandbay.html",
            machineUrl: "https://infrastructure.sfwater.org/lims.asmx/getBeaches",
            absenceBehavior: "neutral-only-with-current-complete-samples",
            errorCategory: null,
          },
          "california-beachwatch-santa-barbara": {
            agency: "California State Water Resources Control Board",
            programUrl: "https://www.waterboards.ca.gov/water_issues/programs/beaches/beach_surveys/index.html",
            statusUrl: "https://beachwatch.waterboards.ca.gov/public/advisory.php",
            machineUrl: "https://beachwatch.waterboards.ca.gov/public/advisory.php",
            absenceBehavior: "unknown",
            errorCategory: null,
          },
          "california-beachwatch-marin": {
            agency: "California State Water Resources Control Board",
            programUrl: "https://www.waterboards.ca.gov/water_issues/programs/beaches/beach_surveys/index.html",
            statusUrl: "https://beachwatch.waterboards.ca.gov/public/advisory.php",
            machineUrl: "https://beachwatch.waterboards.ca.gov/public/advisory.php",
            absenceBehavior: "unknown",
            errorCategory: null,
          },
          "california-beachwatch-east-bay-parks": {
            agency: "California State Water Resources Control Board",
            programUrl: "https://www.waterboards.ca.gov/water_issues/programs/beaches/beach_surveys/index.html",
            statusUrl: "https://beachwatch.waterboards.ca.gov/public/advisory.php",
            machineUrl: "https://beachwatch.waterboards.ca.gov/public/advisory.php",
            absenceBehavior: "unknown",
            errorCategory: null,
          },
          "san-mateo-county-health": {
            agency: "San Mateo County Health",
            programUrl: "https://www.smchealth.org/node/1201",
            statusUrl: "https://www.smchealth.org/node/1201",
            machineUrl: "https://www.smchealth.org/node/1201",
            absenceBehavior: "unknown",
            errorCategory: null,
          },
        },
        sites: {
          "baker-beach": assessment({
            status: "posted",
            recommendationEffect: "suppress",
            officialLabel: "Official water-contact posting",
            detail: "This active agency status suppresses the site from CastingCompass recommendations.",
            stationIds: ["4608", "4609", "4610"],
            stationNames: ["Baker Beach West", "Baker Beach East", "Baker Beach at Lobos Creek"],
          }),
          "crissy-field-east-beach": assessment({}),
          "gaviota-state-park-beach": assessment({
            status: "posted",
            recommendationEffect: "suppress",
            officialLabel: "Official water-contact posting",
            detail: "A current county-submitted action in the official State Board table suppresses this site from recommendations.",
            sourceId: "california-beachwatch-santa-barbara",
            stationIds: ["WP0000079"],
            stationNames: ["Gaviota State Beach"],
            sampleDates: [],
            actionStartDates: ["2026-06-15"],
            actionEndDates: [],
            sourceUrl: "https://beachwatch.waterboards.ca.gov/public/advisory.php",
          }),
          "pacifica-state-beach": assessment({
            status: "posted",
            recommendationEffect: "suppress",
            officialLabel: "Official water-contact warning or closure",
            detail: "The current County Health posting list names an exact reviewed station for this site, so the recommendation is suppressed.",
            sourceId: "san-mateo-county-health",
            stationIds: ["AB4116"],
            stationNames: ["Linda Mar #5 (at San Pedro Creek)"],
            sampleDates: ["2026-07-13"],
            sourceUrl: "https://www.smchealth.org/node/1201",
          }),
          "bolinas-beach": assessment({
            status: "posted",
            recommendationEffect: "suppress",
            officialLabel: "Official water-contact posting",
            detail: "A current county-submitted action in the official State Board table suppresses this site from recommendations.",
            sourceId: "california-beachwatch-marin",
            stationIds: ["BOLINAS"],
            stationNames: ["Bolinas Beach"],
            sampleDates: [],
            actionStartDates: ["2026-07-15"],
            actionEndDates: [],
            sourceUrl: "https://beachwatch.waterboards.ca.gov/public/advisory.php",
          }),
          "keller-beach": assessment({
            status: "posted",
            recommendationEffect: "suppress",
            officialLabel: "Official water-contact posting",
            detail: "A current district-submitted action in the official State Board table suppresses this site from recommendations.",
            sourceId: "california-beachwatch-east-bay-parks",
            stationIds: ["Keller North Beach"],
            stationNames: ["North Beach"],
            sampleDates: [],
            actionStartDates: ["2026-05-05"],
            actionEndDates: [],
            sourceUrl: "https://beachwatch.waterboards.ca.gov/public/advisory.php",
          }),
          "crown-memorial-state-beach": assessment({
            status: "posted",
            recommendationEffect: "suppress",
            officialLabel: "Official water-contact posting",
            detail: "A current district-submitted action in the official State Board table suppresses this site from recommendations.",
            sourceId: "california-beachwatch-east-bay-parks",
            stationIds: ["Crown Crab Cove"],
            stationNames: ["Crab Cove"],
            sampleDates: [],
            actionStartDates: ["2026-06-23"],
            actionEndDates: [],
            sourceUrl: "https://beachwatch.waterboards.ca.gov/public/advisory.php",
          }),
        },
      }),
    }));
  }
  if (savedSiteRecoveryTest) {
    // Keep the committed forecast fixture inside its availability window so this mutation test
    // exercises recovery behavior instead of expiring as wall-clock time advances.
    await page.clock.setFixedTime(new Date(OPPORTUNITY_FIXTURE_VALID_FROM));
  }
  let profileAttempts = 0;
  await page.route("**/api/auth/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      user: profileRecoveryTest
        ? { id: "user_profile_recovery", email: "profiletest@example.com", ageEligible: true, legalAccepted: true }
        : tripRecoveryTest
          ? { id: "user_trip_recovery", email: "triptest@example.com", ageEligible: true, legalAccepted: true }
          : accountDeletionRecoveryTest
            ? { id: "user_account_deletion", email: "deletiontest@example.com", ageEligible: true, legalAccepted: true }
            : tripDeletionRecoveryTest
              ? { id: "user_trip_deletion", email: "tripdeletiontest@example.com", ageEligible: true, legalAccepted: true }
              : tripEditRecoveryTest
                ? { id: "user_trip_edit", email: "tripedittest@example.com", ageEligible: true, legalAccepted: true }
                : gearMutationRecoveryTest
                  ? { id: "user_gear_recovery", email: "geartest@example.com", ageEligible: true, legalAccepted: true }
                  : signOutRecoveryTest
                    ? { id: "user_signout_recovery", email: "signouttest@example.com", ageEligible: true, legalAccepted: true }
                    : savedSiteRecoveryTest
                      ? { id: "user_saved_site_recovery", email: "savedtest@example.com", ageEligible: true, legalAccepted: true }
        : null,
    }),
  }));
  if (profileRecoveryTest || tripRecoveryTest || accountDeletionRecoveryTest || tripDeletionRecoveryTest || tripEditRecoveryTest || gearMutationRecoveryTest || signOutRecoveryTest || savedSiteRecoveryTest) {
    await page.route("**/api/saved-sites", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ siteIds: ["limantour-beach"] }),
    }));
    await page.route("**/api/gear-profiles", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ gearProfiles: [] }),
    }));
  }
  if (savedSiteRecoveryTest) {
    await page.route("**/api/discussions/*", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ posts: [] }),
    }));
  }
  if (profileRecoveryTest) {
    await page.route("**/api/profile", (route) => {
      profileAttempts += 1;
      if (profileAttempts === 1) {
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "temporary_failure" } }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          savedSites: [{ site_id: "limantour-beach", created_at: "2026-07-17T00:00:00.000Z" }],
          trips: [],
          gearProfiles: [],
        }),
      });
    });
  }
  if (tripDeletionRecoveryTest) {
    await page.route("**/api/profile/reviews/retry", (route) => route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ queued: true }),
    }));
    await page.route("**/api/profile", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        savedSites: [],
        gearProfiles: [],
        trips: [{
          id: "trip_pending_delete",
          source: "past_report",
          site_id: "limantour-beach",
          started_at: "2026-07-16T14:00:00.000Z",
          ended_at: "2026-07-16T16:00:00.000Z",
          moderation_status: "pending",
          contract_status: "valid",
          outcome_class: "no_fish",
          target_encounter_count: 0,
          any_fish_encounter_count: 0,
          angler_hours: 2,
        }],
      }),
    }));
  }
  if (tripEditRecoveryTest) {
    await page.route("**/api/profile/reviews/retry", (route) => route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ queued: true }),
    }));
    await page.route("**/api/profile", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        savedSites: [],
        gearProfiles: [],
        trips: [{
          id: "trip_pending_edit",
          source: "past_report",
          site_id: "limantour-beach",
          started_at: "2026-07-16T14:00:00.000Z",
          ended_at: "2026-07-16T16:00:00.000Z",
          moderation_status: "pending",
          contract_status: "valid",
          outcome_class: "no_fish",
          target_encounter_count: 0,
          any_fish_encounter_count: 0,
          angler_hours: 2,
          angler_count: 1,
          ai_review_status: "reviewed",
          ai_review_json: "{}",
        }],
      }),
    }));
  }
  if (gearMutationRecoveryTest) {
    await page.route("**/api/profile", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        savedSites: [],
        trips: [],
        gearProfiles: [{
          id: "gear_11111111-1111-4111-8111-111111111111",
          name: "Existing preset",
          rod: "Medium spinning rod",
          reel: "3000 spinning reel",
          bait_lure: "Swimbait",
          rig: "Jighead",
        }],
      }),
    }));
  }
  if (signOutRecoveryTest) {
    await page.route("**/api/profile", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ savedSites: [], trips: [], gearProfiles: [] }),
    }));
    await page.route("**/api/auth/turnstile-config", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ turnstile: { enabled: false, available: false, siteKey: null } }),
    }));
  }
  await page.route("**/api/privacy/deletion-status", (route) => route.fulfill({
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "deletion_receipt_not_found" } }),
  }));
  await page.route("**/api/trips/summary", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ completedTrips: 0, anglerHours: 0, halibutEncounters: 0, sitesCovered: 0, past24Hours: {} }),
  }));
  await page.addInitScript(() => {
    if (!new URL(window.location.href).searchParams.has("showRespectReminder")) {
      window.localStorage.setItem("contourcast.respect-water.v1", "dismissed");
    }
  });
  await page.goto("/");
  await expect(page.locator(".availability-filter")).toBeVisible();
});

test("primary controls stay inside common phone viewports", async ({ page }) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  for (const selector of [".topbar", ".topbar-actions", ".availability-filter", ".availability-filter input"]) {
    await expectSelectorInsideViewport(page, selector);
  }
});

test("keyboard users can skip repeated navigation to the main forecast", async ({ page }, testInfo) => {
  const skipLink = page.getByRole("link", { name: "Skip to forecast content" });
  if (testInfo.project.name.startsWith("webkit")) {
    await skipLink.focus();
  } else {
    await page.keyboard.press("Tab");
  }
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  await page.keyboard.press("Enter");

  const main = page.locator("main#main-content");
  await expect(main).toBeFocused();
  await expect(page.locator("body > div header.topbar")).toHaveCount(1);
  await expect(page.locator("main#main-content header.topbar")).toHaveCount(0);
  await expect(page.locator("main#main-content footer")).toHaveCount(0);
});

test("forecast and presentation choices announce their selected state", async ({ page }) => {
  const today = page.getByRole("button", { name: "Today", exact: true });
  const tomorrow = page.getByRole("button", { name: "Tomorrow", exact: true });
  await expect(today).toHaveAttribute("aria-pressed", "true");
  await expect(tomorrow).toHaveAttribute("aria-pressed", "false");
  await tomorrow.click();
  await expect(today).toHaveAttribute("aria-pressed", "false");
  await expect(tomorrow).toHaveAttribute("aria-pressed", "true");
  await today.click();
  await expect(today).toHaveAttribute("aria-pressed", "true");

  const mapAndList = page.getByRole("button", { name: "Map and list view" });
  const listOnly = page.getByRole("button", { name: "List-only view" });
  await expect(mapAndList).toHaveAttribute("aria-pressed", "true");
  await listOnly.click();
  await expect(listOnly).toHaveAttribute("aria-pressed", "true");
  await expect(mapAndList).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".map-wrap")).toBeHidden();
  await expect(page.locator(".site-list .site-card").first()).toBeVisible();
});

test("modal focus is trapped and restored through a nested account surface", async ({ page }, testInfo) => {
  const siteCard = page.locator(".site-card").first();
  await siteCard.click();
  const detail = page.locator(".detail-sheet");
  await expect(detail).toBeFocused();

  const saveLocation = detail.getByRole("button", { name: "Save location" });
  await saveLocation.click();
  const accountDialog = page.locator(".account-modal");
  await expect(accountDialog).toBeFocused();

  await page.evaluate(() => document.querySelector<HTMLElement>(".location-button")?.focus());
  await expect(accountDialog).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(accountDialog).toHaveCount(0);
  await expect(detail).toBeVisible();
  expect(await detail.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  if (testInfo.project.name.startsWith("webkit")) {
    await expect(siteCard).toBeVisible();
  } else {
    await expect(siteCard).toBeFocused();
  }
});

test("the required water reminder traps focus and cannot be dismissed with Escape", async ({ page }) => {
  await page.evaluate(() => {
    window.localStorage.removeItem("castingcompass.respect-water.v1");
    window.localStorage.removeItem("contourcast.respect-water.v1");
  });
  await page.goto("/?showRespectReminder=1");

  const reminder = page.getByRole("dialog", { name: "Respect the water." });
  await expect(reminder).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(reminder).toBeVisible();
  await page.evaluate(() => document.querySelector<HTMLElement>(".account-button")?.focus());
  await expect(reminder).toBeFocused();
  await reminder.getByRole("button", { name: /continue to castingcompass/i }).click();
  await expect(reminder).toHaveCount(0);
});

test("the complete forecast reflows without horizontal document scrolling at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await expect(page.locator(".availability-filter")).toBeVisible();
  const geometry = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    viewportWidth: window.innerWidth,
    main: (() => {
      const box = document.querySelector<HTMLElement>("main#main-content")!.getBoundingClientRect();
      return { left: box.left, right: box.right };
    })(),
  }));
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  expect(geometry.main.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.main.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
});

test("official water-quality status suppresses recommendations and keeps neutral status explicit", async ({ page }) => {
  await expect(page.locator(".water-quality-suppression-notice")).toContainText(
    "6 sites are excluded from recommendations",
  );
  await expect(page.locator(".site-card").filter({ hasText: "Baker Beach" })).toHaveCount(0);
  await expect(page.locator(".site-card").filter({ hasText: "Gaviota State Park Beach" })).toHaveCount(0);
  await expect(page.locator(".site-card").filter({ hasText: "Pacifica State Beach" })).toHaveCount(0);
  await expect(page.locator(".site-card").filter({ hasText: "Bolinas Beach" })).toHaveCount(0);
  await expect(page.locator(".site-card").filter({ hasText: "Keller Beach" })).toHaveCount(0);
  await expect(page.locator(".site-card").filter({ hasText: "Crown Memorial State Beach" })).toHaveCount(0);
  await page.goto("/?site=gaviota-state-park-beach");
  const actionAdvisory = page.locator(".water-quality-advisory");
  await expect(actionAdvisory).toBeVisible();
  await expect(actionAdvisory).toContainText("Official water-contact posting");
  await expect(actionAdvisory).toContainText("Agency action start date: 2026-06-15");
  await expect(actionAdvisory).toContainText("No end date is reported");
  await expect(actionAdvisory.getByRole("link", { name: /official agency status/i })).toHaveAttribute(
    "href",
    "https://beachwatch.waterboards.ca.gov/public/advisory.php",
  );
  await page.goto("/?site=pacifica-state-beach");
  const countyAdvisory = page.locator(".water-quality-advisory");
  await expect(countyAdvisory).toBeVisible();
  await expect(countyAdvisory).toContainText("Official water-contact warning or closure");
  await expect(countyAdvisory).toContainText("Agency sample date: 2026-07-13");
  await expect(countyAdvisory).toContainText("does not improve this fishing score");
  await expect(countyAdvisory.getByRole("link", { name: /official agency status/i })).toHaveAttribute(
    "href",
    "https://www.smchealth.org/node/1201",
  );
  await page.goto("/?site=bolinas-beach");
  const marinAdvisory = page.locator(".water-quality-advisory");
  await expect(marinAdvisory).toBeVisible();
  await expect(marinAdvisory).toContainText("Official water-contact posting");
  await expect(marinAdvisory).toContainText("Agency action start date: 2026-07-15");
  await expect(marinAdvisory).toContainText("does not improve this fishing score");
  await expect(marinAdvisory.getByRole("link", { name: /official agency status/i })).toHaveAttribute(
    "href",
    "https://beachwatch.waterboards.ca.gov/public/advisory.php",
  );
  await page.goto("/?site=keller-beach");
  const eastBayParksAdvisory = page.locator(".water-quality-advisory");
  await expect(eastBayParksAdvisory).toBeVisible();
  await expect(eastBayParksAdvisory).toContainText("Official water-contact posting");
  await expect(eastBayParksAdvisory).toContainText("Agency action start date: 2026-05-05");
  await expect(eastBayParksAdvisory).toContainText("does not improve this fishing score");
  await expect(
    eastBayParksAdvisory.getByRole("link", { name: /official agency status/i }),
  ).toHaveAttribute("href", "https://beachwatch.waterboards.ca.gov/public/advisory.php");
  // Open the exact site through the product's stable deep-link contract. Its rank can move as
  // regional sites are added, so the advisory test must not assume it appears in the first cards.
  await page.goto("/?site=crissy-field-east-beach");
  const advisory = page.locator(".water-quality-advisory");
  await expect(advisory).toBeVisible();
  await expect(advisory).toContainText("No active posting reported");
  await expect(advisory).toContainText("does not improve this fishing score");
  await expect(advisory.getByRole("link", { name: /official agency status/i })).toHaveAttribute(
    "href",
    "https://webapps.sfpuc.org/sapps/beachesandbay.html",
  );
  await expectSelectorInsideViewport(page, ".water-quality-advisory");
});

test("source-bound Santa Barbara chart context stays truthful and mobile-safe", async ({ page }) => {
  await page.goto("/?site=goleta-beach");
  const evidence = page.locator(".structure-depth-evidence");

  await expect(evidence).toBeVisible();
  await expect(evidence).toContainText("NOAA chart context for this location");
  await expect(evidence).toContainText("0–9.1 m");
  await expect(evidence).toContainText("2.4–5.4 m across 3 deduplicated records within 1,000 m");
  await expect(evidence).toContainText("Charted shoreline construction");
  await expect(evidence).toContainText("not an exact depth at the marker");
  await expect(evidence).toContainText("no fixed grid resolution");
  await expect(evidence).toContainText("does not change the fishing score");
  await expect(evidence).toContainText("not for navigation, wading, or access decisions");
  await expect(evidence.getByRole("link", { name: /NOAA source notes/i })).toHaveAttribute(
    "href",
    "https://nauticalcharts.noaa.gov/learn/encdirect/",
  );
  await expectSelectorInsideViewport(page, ".structure-depth-evidence");
});

test("source-bound San Francisco chart context preserves partial source-date precision", async ({ page }) => {
  await page.goto("/?site=torpedo-wharf");
  const evidence = page.locator(".structure-depth-evidence");

  await expect(evidence).toBeVisible();
  await expect(evidence).toContainText("0–1.8 m");
  await expect(evidence).toContainText("some dates have year/month precision");
  await expect(evidence).toContainText("some records have no source date");
  await expect(evidence).toContainText("does not change the fishing score");
  await expect(evidence).toContainText("not for navigation, wading, or access decisions");
  await expectSelectorInsideViewport(page, ".structure-depth-evidence");
});

test("source-bound San Francisco chart context keeps a missing sector band explicitly partial", async ({ page }) => {
  await page.goto("/?site=crane-cove-park");
  const evidence = page.locator(".structure-depth-evidence");

  await expect(evidence).toBeVisible();
  await expect(evidence).toContainText("No reviewed NOAA depth-area band intersected this configured sector");
  await expect(evidence).toContainText("4.9–12 m across 7 deduplicated records within 1,000 m");
  await expect(evidence).toContainText("Charted wreck");
  await expect(evidence).toContainText("the gap is not proof of shallow water, safe access, or castability");
  await expectSelectorInsideViewport(page, ".structure-depth-evidence");
});

test("source-bound San Mateo Coast coverage preserves the closed-site recommendation boundary", async ({ page }) => {
  await page.goto("/?site=pacifica-municipal-pier");
  const closure = page.locator(".closure-notice").filter({ hasText: "temporarily closed access point" });

  await expect(closure).toContainText("1 temporarily closed access point is excluded from ranking");
  await expect(closure.getByRole("link", { name: /official status/i })).toHaveAttribute(
    "href",
    "https://www.cityofpacifica.org/departments/public-works/field-services/pacifica-pier",
  );
  await expect(page.locator(".site-card").filter({ hasText: "Pacifica Municipal Pier" })).toHaveCount(0);
  await expect(page.locator(".detail-sheet")).toHaveCount(0);
  await expect(page.locator(".fish-window-button")).toHaveCount(0);
  await expectSelectorInsideViewport(page, ".closure-notice");
});

test("source-bound San Mateo Coast chart context preserves Half Moon Bay date precision", async ({ page }) => {
  await page.goto("/?site=francis-state-beach");
  const evidence = page.locator(".structure-depth-evidence");

  await expect(evidence).toBeVisible();
  await expect(evidence).toContainText("1.8–3.6 m");
  await expect(evidence).toContainText("2.4–9.1 m across 9 deduplicated records within 1,000 m");
  await expect(evidence).toContainText("Charted obstruction");
  await expect(evidence).toContainText("some dates have year/month precision");
  await expect(evidence).toContainText("some records have no source date");
  await expect(evidence).toContainText("does not change the fishing score");
  await expectSelectorInsideViewport(page, ".structure-depth-evidence");
});

test("source-bound Marin Coast chart context keeps a missing sector band explicitly partial", async ({ page }) => {
  await page.goto("/?site=bolinas-beach");
  const evidence = page.locator(".structure-depth-evidence");

  await expect(evidence).toBeVisible();
  await expect(evidence).toContainText("No reviewed NOAA depth-area band intersected this configured sector");
  await expect(evidence).toContainText("0.3–4.2 m across 6 deduplicated records within 1,000 m");
  await expect(evidence).toContainText("Charted seabed description");
  await expect(evidence).toContainText("some dates have year/month precision");
  await expect(evidence).toContainText("the gap is not proof of shallow water, safe access, or castability");
  await expect(evidence).toContainText("does not change the fishing score");
  await expectSelectorInsideViewport(page, ".structure-depth-evidence");
});

test("source-bound Marin Coast chart context preserves Point Reyes date precision", async ({ page }) => {
  await page.goto("/?site=drakes-beach");
  const evidence = page.locator(".structure-depth-evidence");

  await expect(evidence).toBeVisible();
  await expect(evidence).toContainText("0–3.6 m");
  await expect(evidence).toContainText("0.4–9.6 m across 14 deduplicated records within 1,000 m");
  await expect(evidence).toContainText("Charted seabed description");
  await expect(evidence).toContainText("some dates have year/month precision");
  await expect(evidence).toContainText("some records have no source date");
  await expect(evidence).toContainText("does not change the fishing score");
  await expectSelectorInsideViewport(page, ".structure-depth-evidence");
});

test("source-bound North and East Bay chart context keeps a missing sector band explicitly partial", async ({ page }) => {
  await page.goto("/?site=mcnears-beach-pier");
  const evidence = page.locator(".structure-depth-evidence");

  await expect(evidence).toBeVisible();
  await expect(evidence).toContainText("No reviewed NOAA depth-area band intersected this configured sector");
  await expect(evidence).toContainText("0.6–2.4 m across 6 deduplicated records within 1,000 m");
  await expect(evidence).toContainText("Charted shoreline construction");
  await expect(evidence).toContainText("the gap is not proof of shallow water, safe access, or castability");
  await expect(evidence).toContainText("does not change the fishing score");
  await expectSelectorInsideViewport(page, ".structure-depth-evidence");
});

test("source-bound North and East Bay chart context preserves Berkeley date precision", async ({ page }) => {
  await page.goto("/?site=berkeley-marina-north-basin");
  const evidence = page.locator(".structure-depth-evidence");

  await expect(evidence).toBeVisible();
  await expect(evidence).toContainText("0–1.8 m");
  await expect(evidence).toContainText("0.3–1.8 m across 8 deduplicated records within 1,000 m");
  await expect(evidence).toContainText("Charted obstruction");
  await expect(evidence).toContainText("some dates have year/month precision");
  await expect(evidence).toContainText("some records have no source date");
  await expect(evidence).toContainText("does not change the fishing score");
  await expectSelectorInsideViewport(page, ".structure-depth-evidence");
});

test("source-bound Oakland through South Bay chart context preserves Port View depth and date limits", async ({ page }) => {
  await page.goto("/?site=port-view-park-pier");
  const evidence = page.locator(".structure-depth-evidence");

  await expect(evidence).toBeVisible();
  await expect(evidence).toContainText("5.4–9.1 m");
  await expect(evidence).toContainText("2.1–13.1 m across 12 deduplicated records within 1,000 m");
  await expect(evidence).toContainText("Charted dredged area");
  await expect(evidence).toContainText("some dates have year/month precision");
  await expect(evidence).toContainText("some records have no source date");
  await expect(evidence).toContainText("does not change the fishing score");
  await expectSelectorInsideViewport(page, ".structure-depth-evidence");
});

test("source-bound Oakland through South Bay chart context keeps Coyote Point display-only", async ({ page }) => {
  await page.goto("/?site=coyote-point-jetty");
  const evidence = page.locator(".structure-depth-evidence");

  await expect(evidence).toBeVisible();
  await expect(evidence).toContainText("0–1.8 m");
  await expect(evidence).toContainText("0.6–2.1 m across 12 deduplicated records within 1,000 m");
  await expect(evidence).toContainText("Charted pile or piling");
  await expect(evidence).toContainText("some dates have year/month precision");
  await expect(evidence).toContainText("some records have no source date");
  await expect(evidence).toContainText("does not change the fishing score");
  await expectSelectorInsideViewport(page, ".structure-depth-evidence");
});

test("safe-area contract keeps fixed controls inside simulated insets", async ({ page }) => {
  const insets = { top: 23, right: 17, bottom: 31, left: 19 };
  const applyInsets = () => page.evaluate((values) => {
    let style = document.querySelector<HTMLStyleElement>("#castingcompass-test-safe-area");
    if (!style) {
      style = document.createElement("style");
      style.id = "castingcompass-test-safe-area";
      document.head.append(style);
    }
    style.textContent = `:root {
      --safe-area-top: ${values.top}px !important;
      --safe-area-right: ${values.right}px !important;
      --safe-area-bottom: ${values.bottom}px !important;
      --safe-area-left: ${values.left}px !important;
    }`;
  }, insets);

  await expect(async () => {
    await applyInsets();
    const topbar = await page.locator(".topbar").evaluate((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        top: box.top,
        left: box.left,
        right: box.right,
        viewportWidth: window.innerWidth,
        paddingTop: Number.parseFloat(style.paddingTop),
        paddingRight: Number.parseFloat(style.paddingRight),
        paddingLeft: Number.parseFloat(style.paddingLeft),
      };
    });
    expect(topbar.top).toBeGreaterThanOrEqual(0);
    expect(topbar.left).toBeGreaterThanOrEqual(0);
    expect(topbar.right).toBeLessThanOrEqual(topbar.viewportWidth);
    expect(topbar.paddingTop).toBeGreaterThanOrEqual(insets.top);
    expect(topbar.paddingRight).toBeGreaterThan(insets.right);
    expect(topbar.paddingLeft).toBeGreaterThan(insets.left);
  }).toPass({ intervals: [50, 100, 250], timeout: 8_000 });

  await applyInsets();
  await page.locator(".account-button").click();
  const modal = await page.locator(".account-modal-layer").evaluate((layer) => {
    const box = layer.querySelector<HTMLElement>(".account-modal")!.getBoundingClientRect();
    const style = getComputedStyle(layer);
    return {
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      paddingTop: Number.parseFloat(style.paddingTop),
      paddingRight: Number.parseFloat(style.paddingRight),
      paddingBottom: Number.parseFloat(style.paddingBottom),
      paddingLeft: Number.parseFloat(style.paddingLeft),
    };
  });
  expect(modal.paddingTop).toBeGreaterThan(insets.top);
  expect(modal.paddingRight).toBeGreaterThan(insets.right);
  expect(modal.paddingBottom).toBeGreaterThan(insets.bottom);
  expect(modal.paddingLeft).toBeGreaterThan(insets.left);
  expect(modal.left).toBeGreaterThanOrEqual(insets.left);
  expect(modal.right).toBeLessThanOrEqual(modal.viewportWidth - insets.right);
  expect(modal.top).toBeGreaterThanOrEqual(insets.top);
  expect(modal.bottom).toBeLessThanOrEqual(modal.viewportHeight - insets.bottom);
});

test("map overlays do not collide or clip", async ({ page }) => {
  const centerButton = page.getByRole("button", { name: /fit sites/i });
  const loadMap = page.getByRole("button", { name: /open interactive map/i });
  await expect(async () => {
    const map = page.locator(".map-wrap");
    await expect(map).toBeVisible({ timeout: 1_000 });
    await map.scrollIntoViewIfNeeded({ timeout: 1_000 });
    if (await centerButton.isVisible()) return;
    if (await loadMap.isVisible()) await loadMap.click({ timeout: 1_000 });
    await expect(centerButton).toBeVisible({ timeout: 1_000 });
  }).toPass({ intervals: [100, 250, 500], timeout: 15_000 });

  const viewportWidth = await page.evaluate(() => window.innerWidth);
  const label = await page.locator(".map-overlay-label").boundingBox();
  const center = await centerButton.boundingBox();
  expect(label).not.toBeNull();
  expect(center).not.toBeNull();
  expect(label!.x + label!.width).toBeLessThanOrEqual(center!.x - 4);
  expect(center!.x + center!.width).toBeLessThanOrEqual(viewportWidth + 1);
});

test("map tile cleanup suppresses only the known MapLibre abort rejection", async ({ page }) => {
  await ensureInteractiveMap(page);

  const dispatchResults = await page.evaluate(() => {
    const dispatchRejection = (reason: unknown) => {
      const event = new Event("unhandledrejection", { cancelable: true });
      Object.defineProperty(event, "reason", { value: reason });
      return window.dispatchEvent(event);
    };
    const message = "signal is aborted without reason";

    return {
      expectedMapLibreAbortPropagated: dispatchRejection({
        name: "AbortError",
        message,
        stack: `AbortError: ${message}\n    at q.abortTile (https://castingcompass.com/assets/maplibre-gl-2DjS9JS6.js:1:2)`,
      }),
      applicationAbortPropagated: dispatchRejection({
        name: "AbortError",
        message,
        stack: `AbortError: ${message}\n    at loadForecast (https://castingcompass.com/assets/app.js:2:3)`,
      }),
      mapLibreFailurePropagated: dispatchRejection({
        name: "TypeError",
        message: "Raster source failed",
        stack: "TypeError: Raster source failed\n    at q.abortTile (https://castingcompass.com/assets/maplibre-gl-2DjS9JS6.js:1:2)",
      }),
    };
  });

  expect(dispatchResults.expectedMapLibreAbortPropagated).toBe(false);
  expect(dispatchResults.applicationAbortPropagated).toBe(true);
  expect(dispatchResults.mapLibreFailurePropagated).toBe(true);
});

test("opening multiple location reports does not leak map tile aborts", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/discussions/*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ posts: [] }),
  }));

  await ensureInteractiveMap(page);

  const cards = page.locator(".site-card");
  await expect(cards).not.toHaveCount(0);
  for (let index = 0; index < Math.min(3, await cards.count()); index += 1) {
    await cards.nth(index).click();
    await expect(page.locator(".detail-sheet")).toBeVisible();
    await page.getByRole("button", { name: "Close details" }).click();
    await expect(page.locator(".detail-sheet")).toHaveCount(0);
  }

  expect(pageErrors.filter((message) => /signal is aborted without reason|AbortError/i.test(message))).toEqual([]);
});

test("the 404 recovery page stays truthful and usable on mobile", async ({ page }) => {
  const response = await page.goto("/not-a-real-castingcompass-route");
  expect(response?.status()).toBe(404);
  await expect(page).toHaveTitle("Page not found · CastingCompass");
  await expect(page.getByRole("heading", { name: "That page isn't here." })).toBeVisible();
  const returnLink = page.getByRole("link", { name: /return to the forecast/i });
  await expect(returnLink).toBeVisible();
  await expect(returnLink).toHaveAttribute("href", "/");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/i);
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);

  const geometry = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    card: (() => {
      const box = document.querySelector<HTMLElement>(".not-found-card")!.getBoundingClientRect();
      return { left: box.left, right: box.right, viewportWidth: window.innerWidth };
    })(),
  }));
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  expect(geometry.card.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.card.right).toBeLessThanOrEqual(geometry.card.viewportWidth + 1);
});

test.describe("route render recovery", () => {
  test.use({ serviceWorkers: "block" });

  test("a failed lazy route dependency reaches the safe mobile recovery boundary", async ({ page }) => {
    const map = page.locator(".map-wrap");
    await map.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
    const loadMap = page.getByRole("button", { name: /open interactive map/i });
    if (await loadMap.isVisible()) await loadMap.click({ timeout: 2_000 }).catch(() => undefined);

    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(page.getByRole("heading", { name: "This page could not finish loading." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Return to the forecast" })).toHaveAttribute("href", "/");
    await expect(alert).not.toContainText(/TypeError|ContourMap|digest|stack/i);

    const geometry = await page.evaluate(() => {
      const box = document.querySelector<HTMLElement>(".route-state-card")!.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        left: box.left,
        right: box.right,
        viewportWidth: window.innerWidth,
      };
    });
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.left).toBeGreaterThanOrEqual(-1);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  });
});

test.describe("profile recovery", () => {
  test.use({ serviceWorkers: "block" });

  test("a failed profile load stays unknown until an explicit retry succeeds", async ({ page }) => {
    await expect(page.locator(".account-label")).toHaveText("profiletest");
    await page.locator(".account-button").click();

    const loadError = page.locator(".profile-load-error");
    await expect(loadError).toBeVisible();
    await expect(loadError).toContainText("CastingCompass is not treating the account as empty.");
    expect(await page.locator(".profile-summary strong").allTextContents()).toEqual(["—", "—"]);
    await expect(page.getByText("No saved locations yet.", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Saved locations are unavailable. Retry the profile above.")).toBeVisible();

    await page.getByRole("button", { name: "Retry profile" }).click();
    await expect(loadError).toBeHidden();
    await expect(page.getByText("Limantour Beach", { exact: true })).toBeVisible();
    await expect(page.locator(".profile-summary")).toContainText("1Saved locations");
    await expect(page.locator(".profile-summary")).toContainText("0Completed trips");
  });
});

test.describe("trip network recovery", () => {
  test.use({ serviceWorkers: "block" });

  test("trip submissions pause while offline and never replay automatically", async ({ page, context }) => {
    let reportAttempts = 0;
    await page.route("**/api/trips/report", (route) => {
      reportAttempts += 1;
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ tripId: "unexpected" }) });
    });

    await expect(page.locator(".account-label")).toHaveText("triptest");
    const modal = await preparePastTripForSubmission(page);
    await expect(modal.getByRole("button", { name: "Record no-fish trip" })).toBeVisible();

    await context.setOffline(true);
    await expect(modal.getByRole("alert")).toContainText("trip submissions are paused");
    await expect(modal.getByRole("button", { name: "Reconnect to save report" })).toBeDisabled();

    await context.setOffline(false);
    await expect(modal.getByRole("status").filter({ hasText: "Nothing was resubmitted automatically" })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Record no-fish trip" })).toBeEnabled();
    await page.waitForTimeout(100);
    expect(reportAttempts).toBe(0);
  });

  test("a slow trip save stays pending until authoritative confirmation", async ({ page }) => {
    let reportAttempts = 0;
    await page.route("**/api/trips/report", async (route) => {
      reportAttempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(pastTripReceipt(route)) });
    });

    const modal = await preparePastTripForSubmission(page);
    await modal.getByRole("button", { name: "Record no-fish trip" }).click();
    const status = modal.locator(".trip-form-status");
    await expect(status).toContainText("no report is confirmed yet", { timeout: 5_500 });
    await expect(status.locator("i")).toBeVisible();
    await expect(modal.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(reportAttempts).toBe(1);

    await expect(status).toContainText("No-fish trip recorded and pending review", { timeout: 8_000 });
    await expect(modal.getByRole("button", { name: "Report saved" })).toBeDisabled();
    expect(await page.evaluate(() => window.localStorage.getItem("castingcompass.trip-draft.v1.past"))).toBeNull();
  });

  test("a failed trip save remains ambiguous and keeps its draft", async ({ page }) => {
    let reportAttempts = 0;
    const submittedTripIds: string[] = [];
    await page.route("**/api/trips/report", (route) => {
      reportAttempts += 1;
      const receipt = pastTripReceipt(route);
      submittedTripIds.push(receipt.trip.id);
      if (reportAttempts === 1) return route.abort("connectionfailed");
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(receipt) });
    });

    const modal = await preparePastTripForSubmission(page);
    await modal.getByRole("button", { name: "Record no-fish trip" }).click();
    const alert = modal.getByRole("alert");
    await expect(alert).toContainText("server may already have accepted it");
    await expect(alert).toContainText("retrying here is safe and cannot create a duplicate");
    await expect(modal.getByRole("button", { name: "Retry safely" })).toBeEnabled();
    await expect(modal.locator("fieldset.trip-write-fields input").first()).toBeDisabled();
    expect(reportAttempts).toBe(1);
    expect(await page.evaluate(() => window.localStorage.getItem("castingcompass.trip-draft.v1.past"))).not.toBeNull();
    expect(await page.evaluate(() => window.localStorage.getItem("castingcompass.trip-request.v1.past"))).not.toBeNull();
    expect(await page.evaluate(() => window.localStorage.getItem("castingcompass.trip-pending.v1.past"))).not.toBeNull();

    await modal.getByRole("button", { name: "Close trip report" }).click();
    await expect(modal).toBeHidden();
    await page.locator(".log-trip-button").click();
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("button", { name: "Retry safely" })).toBeEnabled();
    await expect(modal.locator("fieldset.trip-write-fields input").first()).toBeDisabled();
    await modal.getByRole("button", { name: "Retry safely" }).click();
    await expect(modal.getByRole("button", { name: "Report saved" })).toBeDisabled();
    expect(reportAttempts).toBe(2);
    expect(submittedTripIds[1]).toBe(submittedTripIds[0]);
    expect(await page.evaluate(() => window.localStorage.getItem("castingcompass.trip-draft.v1.past"))).toBeNull();
    expect(await page.evaluate(() => window.localStorage.getItem("castingcompass.trip-request.v1.past"))).toBeNull();
    expect(await page.evaluate(() => window.localStorage.getItem("castingcompass.trip-pending.v1.past"))).toBeNull();
  });
});

test.describe("account deletion recovery", () => {
  test.use({ serviceWorkers: "block" });

  test("account deletion pauses while offline and never submits automatically", async ({ page, context }) => {
    let deletionAttempts = 0;
    await page.route("**/api/profile", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ savedSites: [], trips: [], gearProfiles: [] }) });
      }
      deletionAttempts += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: true, deletion: { status: "completed", scope: "account", objectsTotal: 0, objectsDeleted: 0 } }) });
    });

    const { deletion } = await prepareAccountDeletion(page);
    await context.setOffline(true);
    await expect(deletion.getByRole("alert")).toContainText("Account deletion has not been submitted");
    await expect(deletion.getByRole("button", { name: "Reconnect to delete account" })).toBeDisabled();

    await context.setOffline(false);
    await expect(deletion.getByRole("status")).toContainText("No deletion request was submitted automatically");
    await expect(deletion.getByRole("button", { name: "Permanently delete account" })).toBeEnabled();
    await page.waitForTimeout(100);
    expect(deletionAttempts).toBe(0);
  });

  test("confirmed account deletion clears only account-bound browser recovery state", async ({ page }) => {
    await page.route("**/api/profile", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ savedSites: [], trips: [], gearProfiles: [] }) });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ deleted: true, deletion: { status: "completed", scope: "account", objectsTotal: 0, objectsDeleted: 0 } }),
      });
    });

    const { modal, deletion } = await prepareAccountDeletion(page);
    await seedAccountBrowserStorage(page);
    page.once("dialog", (dialog) => dialog.accept());
    await deletion.getByRole("button", { name: "Permanently delete account" }).click();
    await expect(modal.getByRole("heading", { name: "Account access removed." })).toBeVisible();
    expectAccountBrowserStorageCleared(await accountBrowserStorageSnapshot(page));
  });

  test("a slow account deletion stays unconfirmed until the receipt arrives", async ({ page }) => {
    await page.route("**/api/profile", async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ savedSites: [], trips: [], gearProfiles: [] }) });
      }
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: true, deletion: { status: "completed", scope: "account", objectsTotal: 0, objectsDeleted: 0 } }) });
    });

    const { modal, deletion } = await prepareAccountDeletion(page);
    page.once("dialog", (dialog) => dialog.accept());
    await deletion.getByRole("button", { name: "Permanently delete account" }).click();
    const status = deletion.getByRole("status");
    await expect(status).toContainText("account removal has not been confirmed yet", { timeout: 5_500 });
    await expect(status.locator("i")).toBeVisible();
    await expect(deletion.getByRole("button", { name: "Deleting…" })).toBeDisabled();
    await expect(modal.getByRole("heading", { name: "Account access removed." })).toBeVisible({ timeout: 8_000 });
  });

  test("a failed account deletion stays ambiguous and warns against resubmission", async ({ page }) => {
    let deletionAttempts = 0;
    await page.route("**/api/profile", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ savedSites: [], trips: [], gearProfiles: [] }) });
      }
      deletionAttempts += 1;
      return route.abort("connectionfailed");
    });

    const { deletion } = await prepareAccountDeletion(page);
    page.once("dialog", (dialog) => dialog.accept());
    await deletion.getByRole("button", { name: "Permanently delete account" }).click();
    const alert = deletion.getByRole("alert");
    await expect(alert).toContainText("Account access may already be removed");
    await expect(alert).toContainText("Do not submit again");
    await expect(alert).toContainText("deletion-status receipt");
    await expect(deletion.getByRole("button", { name: "Verify deletion status before retrying" })).toBeDisabled();
    expect(deletionAttempts).toBe(1);
  });
});

test.describe("trip deletion recovery", () => {
  test.use({ serviceWorkers: "block" });

  test("trip deletion pauses while offline and never submits automatically", async ({ page, context }) => {
    let deletionAttempts = 0;
    await page.route("**/api/profile/trips/*", (route) => {
      deletionAttempts += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: true, deletion: { status: "completed", scope: "trip", objectsTotal: 0, objectsDeleted: 0 } }) });
    });

    const { modal, trip } = await prepareTripDeletion(page);
    await context.setOffline(true);
    await expect(modal.locator(".trip-deletion-network-status")).toContainText("Trip deletion is paused");
    await expect(trip.getByRole("button", { name: "Reconnect to remove" })).toBeDisabled();

    await context.setOffline(false);
    await expect(modal.locator(".trip-deletion-network-status")).toContainText("No trip edit or deletion was submitted automatically");
    await expect(trip.getByRole("button", { name: "Remove" })).toBeEnabled();
    await page.waitForTimeout(100);
    expect(deletionAttempts).toBe(0);
  });

  test("a slow trip deletion stays unconfirmed until the receipt arrives", async ({ page }) => {
    await page.route("**/api/profile/trips/*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: true, deletion: { status: "completed", scope: "trip", objectsTotal: 0, objectsDeleted: 0 } }) });
    });

    const { modal, trip } = await prepareTripDeletion(page);
    page.once("dialog", (dialog) => dialog.accept());
    await trip.getByRole("button", { name: "Remove" }).click();
    const status = trip.getByRole("status");
    await expect(status).toContainText("trip deletion has not been confirmed yet", { timeout: 5_500 });
    await expect(status.locator("i")).toBeVisible();
    await expect(trip.getByRole("button", { name: "Removing…" })).toBeDisabled();
    await expect(modal.getByRole("heading", { name: "Trip log removed." })).toBeVisible({ timeout: 8_000 });
  });

  test("a failed trip deletion stays ambiguous and blocks resubmission", async ({ page }) => {
    let deletionAttempts = 0;
    await page.route("**/api/profile/trips/*", (route) => {
      deletionAttempts += 1;
      return route.abort("connectionfailed");
    });

    const { trip } = await prepareTripDeletion(page);
    page.once("dialog", (dialog) => dialog.accept());
    await trip.getByRole("button", { name: "Remove" }).click();
    const alert = trip.getByRole("alert");
    await expect(alert).toContainText("This trip may already be removed");
    await expect(alert).toContainText("Do not submit again");
    await expect(alert).toContainText("deletion-status receipt");
    await expect(trip.getByRole("button", { name: "Verify deletion status before retrying" })).toBeDisabled();
    expect(deletionAttempts).toBe(1);
  });
});

test.describe("trip edit recovery", () => {
  test.use({ serviceWorkers: "block" });

  test("trip edit pauses while offline and never submits automatically", async ({ page, context }) => {
    let editAttempts = 0;
    await page.route("**/api/profile/trips/*", (route) => {
      editAttempts += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ updated: true, tripId: "trip_pending_edit", validationEvidenceExcluded: true }),
      });
    });

    const { editor } = await prepareTripEdit(page);
    await context.setOffline(true);
    await expect(editor.getByRole("alert")).toContainText("draft remains on this device");
    await expect(editor.getByRole("button", { name: "Reconnect to save changes" })).toBeDisabled();

    await context.setOffline(false);
    await expect(editor.getByRole("status")).toContainText("No trip edit was submitted automatically");
    await expect(editor.getByRole("button", { name: "Save trip changes" })).toBeEnabled();
    await page.waitForTimeout(100);
    expect(editAttempts).toBe(0);
  });

  test("a slow trip edit stays unconfirmed until the matching receipt arrives", async ({ page }) => {
    await page.route("**/api/profile/trips/*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ updated: true, tripId: "trip_pending_edit", validationEvidenceExcluded: true }),
      });
    });

    const { modal, editor } = await prepareTripEdit(page);
    await editor.getByRole("button", { name: "Save trip changes" }).click();
    const status = editor.getByRole("status");
    await expect(status).toContainText("trip update has not been confirmed yet", { timeout: 5_500 });
    await expect(status.locator("i")).toBeVisible();
    await expect(editor.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await expect(editor).toBeHidden({ timeout: 8_000 });
    await expect(modal.getByRole("status")).toContainText("Saved. Because this completed report was edited");
    expect(await page.evaluate(() => window.localStorage.getItem("castingcompass.profile-trip-draft.v1.trip_pending_edit"))).toBeNull();
  });

  test("a failed trip edit stays ambiguous, retains its draft, and blocks conflicting writes", async ({ page }) => {
    let editAttempts = 0;
    await page.route("**/api/profile/trips/*", (route) => {
      editAttempts += 1;
      return route.abort("connectionfailed");
    });

    const { trip, editor } = await prepareTripEdit(page);
    await editor.getByRole("button", { name: "Save trip changes" }).click();
    const alert = editor.getByRole("alert");
    await expect(alert).toContainText("These trip changes may already be saved");
    await expect(alert).toContainText("Do not submit again");
    await expect(editor.getByRole("button", { name: "Verify saved trip before retrying" })).toBeDisabled();
    expect(await page.evaluate(() => window.localStorage.getItem("castingcompass.profile-trip-draft.v1.trip_pending_edit"))).not.toBeNull();

    await editor.getByRole("button", { name: "Close" }).click();
    await expect(trip.getByRole("button", { name: "Verify saved trip before editing again" })).toBeDisabled();
    await expect(trip.getByRole("button", { name: "Trip update unresolved" })).toBeDisabled();
    expect(editAttempts).toBe(1);
  });

  test("a rejected trip edit remains correctable without losing its draft", async ({ page }) => {
    let editAttempts = 0;
    await page.route("**/api/profile/trips/*", (route) => {
      editAttempts += 1;
      return route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Check the trip times and try again." } }),
      });
    });

    const { editor } = await prepareTripEdit(page);
    await editor.getByRole("button", { name: "Save trip changes" }).click();
    await expect(editor.getByRole("alert")).toContainText("Check the trip times and try again");
    await expect(editor.getByRole("button", { name: "Save trip changes" })).toBeEnabled();
    expect(await page.evaluate(() => window.localStorage.getItem("castingcompass.profile-trip-draft.v1.trip_pending_edit"))).not.toBeNull();
    expect(editAttempts).toBe(1);
  });
});

test.describe("gear mutation recovery", () => {
  test.use({ serviceWorkers: "block" });

  test("gear changes pause while offline and never submit automatically", async ({ page, context }) => {
    let mutationAttempts = 0;
    await page.route("**/api/gear-profiles**", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ gearProfiles: [] }) });
      }
      mutationAttempts += 1;
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ gearProfile: { id: "gear_22222222-2222-4222-8222-222222222222", name: "Recovery test preset", rod: null, reel: null, baitLure: null, rig: null } }) });
    });

    const { gear } = await prepareGearMutation(page);
    await context.setOffline(true);
    await expect(gear.getByRole("alert")).toContainText("Gear changes cannot be submitted");
    await expect(gear.getByRole("button", { name: "Reconnect to save preset" })).toBeDisabled();
    await expect(gear.getByRole("button", { name: "Reconnect to remove" })).toBeDisabled();

    await context.setOffline(false);
    await expect(gear.getByRole("status")).toContainText("No gear change was submitted automatically");
    await expect(gear.getByRole("button", { name: "Save gear preset" })).toBeEnabled();
    await expect(gear.getByRole("button", { name: "Remove" })).toBeEnabled();
    expect(mutationAttempts).toBe(0);
  });

  test("slow gear creation stays unconfirmed until the matching resource arrives", async ({ page }) => {
    await page.route("**/api/gear-profiles**", async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ gearProfiles: [] }) });
      }
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ gearProfile: { id: "gear_22222222-2222-4222-8222-222222222222", name: "Recovery test preset", rod: null, reel: null, baitLure: null, rig: null } }),
      });
    });

    const { gear } = await prepareGearMutation(page);
    await gear.getByRole("button", { name: "Save gear preset" }).click();
    const status = gear.getByRole("status");
    await expect(status).toContainText("No new preset is confirmed yet");
    await expect(status).toContainText("new gear preset has not been confirmed yet", { timeout: 7_500 });
    await expect(status.locator("i")).toBeVisible();
    await expect(gear.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await expect(gear.getByLabel("Preset name")).toHaveValue("", { timeout: 8_000 });
  });

  test("failed gear creation stays ambiguous and retains the form", async ({ page }) => {
    let createAttempts = 0;
    await page.route("**/api/gear-profiles**", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ gearProfiles: [] }) });
      }
      createAttempts += 1;
      return route.abort("connectionfailed");
    });

    const { gear } = await prepareGearMutation(page);
    await gear.getByRole("button", { name: "Save gear preset" }).click();
    const alert = gear.getByRole("alert");
    await expect(alert).toContainText("This preset may already be saved");
    await expect(alert).toContainText("Do not submit it again");
    await expect(gear.getByLabel("Preset name")).toHaveValue("Recovery test preset");
    await expect(gear.getByRole("button", { name: "Verify gear status before retrying" })).toBeDisabled();
    await expect(gear.getByRole("button", { name: "Gear change unresolved" })).toBeDisabled();
    expect(createAttempts).toBe(1);
  });

  test("rejected gear creation remains correctable without losing the form", async ({ page }) => {
    let createAttempts = 0;
    await page.route("**/api/gear-profiles**", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ gearProfiles: [] }) });
      }
      createAttempts += 1;
      return route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Give this preset a shorter name." } }),
      });
    });

    const { gear } = await prepareGearMutation(page);
    await gear.getByRole("button", { name: "Save gear preset" }).click();
    await expect(gear.getByRole("alert")).toContainText("Give this preset a shorter name");
    await expect(gear.getByLabel("Preset name")).toHaveValue("Recovery test preset");
    await expect(gear.getByRole("button", { name: "Save gear preset" })).toBeEnabled();
    expect(createAttempts).toBe(1);
  });

  test("failed gear removal stays ambiguous and blocks every gear write", async ({ page }) => {
    let removalAttempts = 0;
    await page.route("**/api/gear-profiles**", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ gearProfiles: [] }) });
      }
      removalAttempts += 1;
      return route.abort("connectionfailed");
    });

    const { gear } = await prepareGearMutation(page);
    page.once("dialog", (dialog) => dialog.accept());
    await gear.getByRole("button", { name: "Remove" }).click();
    const alert = gear.getByRole("alert");
    await expect(alert).toContainText("This preset may already be removed");
    await expect(alert).toContainText("Do not submit again");
    await expect(gear.getByRole("button", { name: "Verify gear removal before retrying" })).toBeDisabled();
    await expect(gear.getByRole("button", { name: "Verify gear status before retrying" })).toBeDisabled();
    expect(removalAttempts).toBe(1);
  });
});

test.describe("saved-location mutation recovery", () => {
  test.use({ serviceWorkers: "block" });

  test("saved-location changes pause while offline and never submit automatically", async ({ page, context }) => {
    let mutationAttempts = 0;
    await page.route("**/api/saved-sites/*", (route) => {
      mutationAttempts += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ saved: false, siteId: "limantour-beach" }),
      });
    });

    const { controls } = await prepareSavedSiteMutation(page);
    await context.setOffline(true);
    await expect(controls.getByRole("button", { name: "Reconnect to remove saved location" })).toBeDisabled();
    await expect(controls.getByRole("alert")).toContainText("No saved-location change was submitted");

    await context.setOffline(false);
    await expect(controls.getByRole("button", { name: "Saved location" })).toBeEnabled();
    await expect(controls.getByRole("status")).toContainText("No saved-location change was submitted automatically");
    await page.waitForTimeout(100);
    expect(mutationAttempts).toBe(0);
  });

  test("slow saved-location removal stays unconfirmed until the exact receipt arrives", async ({ page }) => {
    await page.route("**/api/saved-sites/*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ saved: false, siteId: "limantour-beach" }),
      });
    });

    const { controls } = await prepareSavedSiteMutation(page);
    await controls.getByRole("button", { name: "Saved location" }).click();
    const status = controls.getByRole("status");
    await expect(status).toContainText("saved-location change has not been confirmed yet", { timeout: 5_500 });
    await expect(status.locator("i")).toBeVisible();
    await expect(controls.getByRole("button", { name: "Removing saved location…" })).toBeDisabled();
    await expect(controls.getByRole("button", { name: "Save location" })).toBeEnabled({ timeout: 8_000 });
    await expect(status).toContainText("removed and confirmed by the server");
  });

  test("malformed saved-location receipt stays unresolved until a read-only check confirms it", async ({ page, context }) => {
    let mutationAttempts = 0;
    await page.route("**/api/saved-sites/*", (route) => {
      mutationAttempts += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ saved: false }),
      });
    });

    const { controls } = await prepareSavedSiteMutation(page);
    await controls.getByRole("button", { name: "Saved location" }).click();
    const alert = controls.getByRole("alert");
    await expect(alert).toContainText("This location may already have changed");
    await expect(alert).toContainText("check server status first");
    await expect(controls.getByRole("button", { name: "Saved-location status unresolved" })).toBeDisabled();
    await expect(controls.getByRole("button", { name: "Check saved-location status" })).toBeEnabled();

    await context.setOffline(true);
    await expect(controls.getByRole("button", { name: "Reconnect to check saved-location status" })).toBeDisabled();
    await context.setOffline(false);
    await page.route("**/api/saved-sites", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ siteIds: [] }),
    }));
    await controls.getByRole("button", { name: "Check saved-location status" }).click();
    await expect(controls.getByRole("button", { name: "Save location" })).toBeEnabled();
    await expect(controls.getByRole("status")).toContainText("no longer saved");
    expect(mutationAttempts).toBe(1);
  });
});

test.describe("sign-out recovery", () => {
  test.use({ serviceWorkers: "block" });

  test("sign-out pauses while offline and never submits automatically", async ({ page, context }) => {
    let signOutAttempts = 0;
    await page.route("**/api/auth/logout", (route) => {
      signOutAttempts += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ signedOut: true, user: null }),
      });
    });

    const { controls } = await prepareSignOut(page);
    await context.setOffline(true);
    await expect(controls.getByRole("button", { name: "Reconnect to sign out" })).toBeDisabled();

    await context.setOffline(false);
    await expect(controls.getByRole("button", { name: "Sign out" })).toBeEnabled();
    await page.waitForTimeout(100);
    expect(signOutAttempts).toBe(0);
  });

  test("an exact sign-out receipt clears only account-bound browser recovery state", async ({ page }) => {
    await page.route("**/api/auth/logout", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ signedOut: true, user: null }),
    }));

    const { modal, controls } = await prepareSignOut(page);
    await seedAccountBrowserStorage(page);
    await controls.getByRole("button", { name: "Sign out" }).click();
    await expect(modal.getByRole("heading", { name: "Welcome back." })).toBeVisible();
    expectAccountBrowserStorageCleared(await accountBrowserStorageSnapshot(page));
  });

  test("confirmed sign-out warns when browser storage cleanup is blocked", async ({ page }) => {
    await page.route("**/api/auth/logout", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ signedOut: true, user: null }),
    }));

    const { modal, controls } = await prepareSignOut(page);
    await seedAccountBrowserStorage(page);
    await page.evaluate(() => {
      Object.defineProperty(Storage.prototype, "removeItem", {
        configurable: true,
        value() {
          throw new DOMException("Storage access blocked", "SecurityError");
        },
      });
    });
    await controls.getByRole("button", { name: "Sign out" }).click();
    await expect(modal.getByRole("heading", { name: "Welcome back." })).toBeVisible();
    await expect(modal.getByText("Signed out. This browser blocked removal of locally stored trip recovery data.", { exact: false })).toBeVisible();
    await expect(modal.getByText("Clear CastingCompass site data before sharing this device.", { exact: false })).toBeVisible();
    const snapshot = await accountBrowserStorageSnapshot(page);
    expect(snapshot.localAccountValues.every((value) => value !== null)).toBe(true);
    expect(snapshot.sessionAccountValues.every((value) => value !== null)).toBe(true);
  });

  test("slow sign-out stays unconfirmed until the exact receipt arrives", async ({ page }) => {
    await page.route("**/api/auth/logout", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ signedOut: true, user: null }),
      });
    });

    const { modal, controls } = await prepareSignOut(page);
    await seedAccountBrowserStorage(page);
    await controls.getByRole("button", { name: "Sign out" }).click();
    const status = controls.getByRole("status");
    await expect(status).toContainText("sign-out is not confirmed yet", { timeout: 5_500 });
    await expect(status.locator("i")).toBeVisible();
    await expect(controls.getByRole("button", { name: "Signing out…" })).toBeDisabled();
    await expect(modal.getByRole("heading", { name: "Welcome back." })).toBeVisible({ timeout: 8_000 });
    await expect(controls).toBeHidden();
    expectAccountBrowserStorageCleared(await accountBrowserStorageSnapshot(page));
  });

  test("malformed sign-out receipt stays unresolved and preserves local account state", async ({ page, context }) => {
    let signOutAttempts = 0;
    await page.route("**/api/auth/logout", (route) => {
      signOutAttempts += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ user: null }),
      });
    });

    const { modal, controls } = await prepareSignOut(page);
    await seedAccountBrowserStorage(page);
    await controls.getByRole("button", { name: "Sign out" }).click();
    const alert = controls.getByRole("alert");
    await expect(alert).toContainText("Your session may still be active");
    await expect(alert).toContainText("check sign-out status first");
    await expect(controls.getByRole("button", { name: "Sign-out status unresolved" })).toBeDisabled();
    await expect(controls.getByRole("button", { name: "Check sign-out status" })).toBeEnabled();
    await expect(modal.getByText("signouttest@example.com")).toBeVisible();
    await context.setOffline(true);
    await expect(controls.getByRole("button", { name: "Reconnect to check sign-out status" })).toBeDisabled();
    await context.setOffline(false);
    await expect(controls.getByRole("button", { name: "Check sign-out status" })).toBeEnabled();
    expect(signOutAttempts).toBe(1);
    const snapshot = await accountBrowserStorageSnapshot(page);
    expect(snapshot.localAccountValues.every((value) => value !== null)).toBe(true);
    expect(snapshot.sessionAccountValues.every((value) => value !== null)).toBe(true);
  });

  test("session check confirms sign-out after a dropped mutation response without replay", async ({ page }) => {
    let signOutAttempts = 0;
    await page.route("**/api/auth/logout", (route) => {
      signOutAttempts += 1;
      return route.abort("connectionfailed");
    });

    const { modal, controls } = await prepareSignOut(page);
    await seedAccountBrowserStorage(page);
    await controls.getByRole("button", { name: "Sign out" }).click();
    await expect(controls.getByRole("button", { name: "Check sign-out status" })).toBeEnabled();
    await page.route("**/api/auth/session", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: null }),
    }));
    await controls.getByRole("button", { name: "Check sign-out status" }).click();
    await expect(modal.getByRole("heading", { name: "Welcome back." })).toBeVisible();
    await expect(controls).toBeHidden();
    expect(signOutAttempts).toBe(1);
    expectAccountBrowserStorageCleared(await accountBrowserStorageSnapshot(page));
  });

  test("session check permits a retry only when the server confirms the session is active", async ({ page }) => {
    let signOutAttempts = 0;
    await page.route("**/api/auth/logout", (route) => {
      signOutAttempts += 1;
      return route.abort("connectionfailed");
    });

    const { controls } = await prepareSignOut(page);
    await controls.getByRole("button", { name: "Sign out" }).click();
    await expect(controls.getByRole("button", { name: "Check sign-out status" })).toBeEnabled();
    await page.route("**/api/auth/session", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "user_signout_recovery", email: "signouttest@example.com", ageEligible: true, legalAccepted: true },
      }),
    }));
    await controls.getByRole("button", { name: "Check sign-out status" }).click();
    await expect(controls.getByRole("alert")).toContainText("session is still active");
    await expect(controls.getByRole("button", { name: "Retry sign out" })).toBeEnabled();
    expect(signOutAttempts).toBe(1);
  });
});

test.describe("mocked Turnstile browser states", () => {
  // Playwright cannot intercept requests claimed by a service worker. Scope
  // blocking to these provider-mock tests; the ordinary mobile tests above
  // retain the installed-PWA/service-worker behavior they had before.
  test.use({ serviceWorkers: "block" });

test("Turnstile sign-in stays usable at 320px and 360px", async ({ page }) => {
  await page.route("**/api/auth/turnstile-config", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      turnstile: { enabled: true, available: true, siteKey: "1x00000000000000000000AA" },
    }),
  }));
  await page.route(/^https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit$/, (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: TURNSTILE_MOCK_SCRIPT,
  }));

  for (const width of [320, 360]) {
    await page.setViewportSize({ width, height: 700 });
    await page.locator(".account-button").click();
    await expect(page.locator(".account-modal")).toBeVisible();
    await expect(page.locator('[data-mock-turnstile="compact"]')).toBeVisible();
    await expect(page.locator('[data-mock-turnstile-retry="never"]')).toBeVisible();
    await expect(page.locator('[data-mock-turnstile-feedback="false"]')).toBeVisible();
    const submit = page.locator(".account-modal form .account-primary");
    await expect(submit).toBeEnabled();
    await expect(page.getByText("Security verification complete.")).toBeVisible();

    const geometry = await page.evaluate(() => {
      const selectors = [".account-modal", ".turnstile-challenge", ".turnstile-widget", "[data-mock-turnstile]"];
      return {
        viewportWidth: window.innerWidth,
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
        elements: selectors.map((selector) => {
          const element = document.querySelector<HTMLElement>(selector)!;
          const box = element.getBoundingClientRect();
          return {
            selector,
            left: box.left,
            right: box.right,
            internalOverflow: element.scrollWidth - element.clientWidth,
          };
        }),
      };
    });
    expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
    for (const element of geometry.elements) {
      expect(element.left, `${element.selector} starts inside ${width}px`).toBeGreaterThanOrEqual(-1);
      expect(element.right, `${element.selector} ends inside ${width}px`).toBeLessThanOrEqual(geometry.viewportWidth + 1);
      expect(element.internalOverflow, `${element.selector} has no horizontal overflow`).toBeLessThanOrEqual(1);
    }

    await page.getByRole("button", { name: "Close account" }).click();
    await expect(page.locator(".account-modal")).toBeHidden();
  }
});

test("an open client re-reads runtime config after off-to-on activation", async ({ page }) => {
  let configRequests = 0;
  await page.route("**/api/auth/turnstile-config", (route) => {
    configRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(configRequests === 1
        ? { turnstile: { enabled: false } }
        : {
            turnstile: {
              enabled: true,
              available: true,
              siteKey: "1x00000000000000000000AA",
            },
          }),
    });
  });
  await page.route(/^https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit$/, (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: TURNSTILE_MOCK_SCRIPT,
  }));
  await page.route("**/api/auth/login", (route) => route.fulfill({
    status: 422,
    contentType: "application/json",
    body: JSON.stringify({
      error: {
        code: "security_verification_required",
        message: "Complete the security verification and try again.",
      },
    }),
  }));

  await page.locator(".account-button").click();
  const form = page.locator(".account-modal form");
  await form.getByLabel("Email").fill("angler@example.com");
  await form.getByLabel("Password").fill("correct-horse-battery-staple");
  await expect(form.locator(".account-primary")).toBeEnabled();
  await form.locator(".account-primary").click();

  await expect(page.locator("[data-mock-turnstile]")).toBeVisible();
  await expect(page.getByText("Security verification complete.")).toBeVisible();
  expect(configRequests).toBeGreaterThanOrEqual(2);
});

test("Turnstile script failure pauses sign-in and a retry performs a fresh load", async ({ page }) => {
  await page.route("**/api/auth/turnstile-config", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      turnstile: { enabled: true, available: true, siteKey: "1x00000000000000000000AA" },
    }),
  }));
  let scriptAttempts = 0;
  await page.route(/^https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit$/, (route) => {
    scriptAttempts += 1;
    if (scriptAttempts === 1) return route.abort("failed");
    return route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: TURNSTILE_MOCK_SCRIPT,
    });
  });

  await page.setViewportSize({ width: 320, height: 700 });
  await page.locator(".account-button").click();
  await expect(page.getByRole("alert")).toContainText("Security verification could not load");
  const retry = page.getByRole("button", { name: "Retry security verification" });
  await expect(retry).toBeVisible();
  await expect(page.locator(".account-modal form .account-primary")).toBeDisabled();
  await retry.click();
  await expect(page.locator('[data-mock-turnstile="compact"]')).toBeVisible();
  await expect(page.getByText("Security verification complete.")).toBeVisible();
  await expect(page.locator(".account-modal form .account-primary")).toBeEnabled();
  expect(scriptAttempts).toBe(2);
});
});
