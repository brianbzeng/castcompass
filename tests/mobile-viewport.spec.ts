import { expect, test, type Page } from "@playwright/test";

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
  await page.getByRole("button", { name: "Log a past trip" }).click();
  const modal = page.locator(".trip-modal");
  await modal.getByRole("combobox", { name: "Fishing location" }).fill("Limantour Beach");
  await modal.getByRole("option", { name: /Limantour Beach/ }).click();
  await modal.getByLabel("Fishing mode for the whole trip").selectOption("shore");
  await modal.getByLabel("Did the score influence this trip?").selectOption("no");
  await modal.getByRole("button", { name: "Continue to gear + result" }).click();
  for (const checkbox of await modal.locator(".consent-field input").all()) await checkbox.check();
  return modal;
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

test.beforeEach(async ({ page }, testInfo) => {
  const testTitle = testInfo.titlePath.join(" ");
  if (testTitle.includes("failed lazy route dependency")) {
    await page.route("**/assets/ContourMap-*.js", (route) => route.abort());
  }
  const profileRecoveryTest = testTitle.includes("failed profile load stays unknown");
  const tripRecoveryTest = testTitle.includes("trip submissions pause while offline") ||
    testTitle.includes("slow trip save stays pending") ||
    testTitle.includes("failed trip save remains ambiguous");
  const accountDeletionRecoveryTest = testTitle.includes("account deletion pauses while offline") ||
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
        : null,
    }),
  }));
  if (profileRecoveryTest || tripRecoveryTest || accountDeletionRecoveryTest || tripDeletionRecoveryTest || tripEditRecoveryTest || gearMutationRecoveryTest) {
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
    window.localStorage.setItem("contourcast.respect-water.v1", "dismissed");
  });
  await page.goto("/");
  await expect(page.locator(".availability-filter")).toBeVisible();
});

test("primary controls stay inside common phone viewports", async ({ page }) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  for (const selector of [".topbar", ".topbar-actions", ".availability-filter", ".availability-filter input"]) {
    const locators = page.locator(selector);
    for (let index = 0; index < await locators.count(); index += 1) {
      const box = await locators.nth(index).boundingBox();
      expect(box, `${selector} should have a box`).not.toBeNull();
      expect(box!.x, `${selector} starts inside the viewport`).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width, `${selector} ends inside the viewport`).toBeLessThanOrEqual(
        (await page.evaluate(() => window.innerWidth)) + 1,
      );
    }
  }
});

test("map overlays do not collide or clip", async ({ page }) => {
  const map = page.locator(".map-wrap");
  const centerButton = page.getByRole("button", { name: /center bay/i });
  await map.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
  if (!(await centerButton.isVisible())) {
    const loadMap = page.getByRole("button", { name: /open interactive map/i });
    if (await loadMap.isVisible()) {
      await loadMap.click().catch(() => undefined);
    }
  }
  await expect(centerButton).toBeVisible({ timeout: 15_000 });

  const viewportWidth = await page.evaluate(() => window.innerWidth);
  const label = await page.locator(".map-overlay-label").boundingBox();
  const center = await centerButton.boundingBox();
  expect(label).not.toBeNull();
  expect(center).not.toBeNull();
  expect(label!.x + label!.width).toBeLessThanOrEqual(center!.x - 4);
  expect(center!.x + center!.width).toBeLessThanOrEqual(viewportWidth + 1);
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
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ tripId: "trip_slow_success" }) });
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
    await page.route("**/api/trips/report", (route) => {
      reportAttempts += 1;
      return route.abort("connectionfailed");
    });

    const modal = await preparePastTripForSubmission(page);
    await modal.getByRole("button", { name: "Record no-fish trip" }).click();
    const alert = modal.getByRole("alert");
    await expect(alert).toContainText("server may already have accepted the report");
    await expect(alert).toContainText("check your Profile before retrying to avoid a duplicate");
    await expect(modal.getByRole("button", { name: "Record no-fish trip" })).toBeEnabled();
    expect(reportAttempts).toBe(1);
    expect(await page.evaluate(() => window.localStorage.getItem("castingcompass.trip-draft.v1.past"))).not.toBeNull();
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
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ gearProfile: { id: "gear_22222222-2222-4222-8222-222222222222", name: "Recovery test preset", rod: null, reel: null, baitLure: null, rig: null } }),
      });
    });

    const { gear } = await prepareGearMutation(page);
    await gear.getByRole("button", { name: "Save gear preset" }).click();
    const status = gear.getByRole("status");
    await expect(status).toContainText("new gear preset has not been confirmed yet", { timeout: 5_500 });
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
