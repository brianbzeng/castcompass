import { expect, test, type Page, type Route } from "@playwright/test";

test.use({ serviceWorkers: "block" });

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function pastTripReceipt(route: Route, hasPhoto = true) {
  const tripId = route.request().postData()?.match(/trip_[a-f0-9-]{36}/)?.[0];
  if (!tripId) throw new Error("Past-trip request did not include a client trip identity.");
  return {
    trip: { id: tripId, status: "completed", source: "past_report", hasPhoto },
    receipt: { operation: "past", tripId },
  };
}

async function preparePastTrip(page: Page) {
  await expect(page.locator(".account-label-compact")).toHaveText("Profile");
  await expect(page.locator(".data-pill")).toHaveAttribute(
    "aria-label",
    /Current status: (?:live|cached)$/,
  );
  await page.locator(".log-trip-button").click();
  const modal = page.locator(".trip-modal");
  await expect(modal).toBeVisible();
  const location = modal.getByRole("combobox", { name: "Fishing location" });
  await expect(location).toBeVisible();
  await expect(modal.locator(".site-combobox-status")).toHaveText(/^Selected: .+$/);
  await modal.getByLabel("Fishing mode for the whole trip").selectOption("shore");
  await modal.getByLabel("Did the score influence this trip?").selectOption("no");
  await modal.getByRole("button", { name: "Continue to gear + result" }).click();
  for (const checkbox of await modal.locator(".consent-field input").all()) await checkbox.check();
  return modal;
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      user: { id: "user_photo_ui", email: "photo-ui@example.com", ageEligible: true, legalAccepted: true },
    }),
  }));
  await page.route("**/api/saved-sites", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ siteIds: [] }),
  }));
  await page.route("**/api/gear-profiles", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ gearProfiles: [] }),
  }));
  await page.route("**/api/trips/summary", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ completedTrips: 0, anglerHours: 0, halibutEncounters: 0, sitesCovered: 0, past24Hours: {} }),
  }));
  await page.addInitScript(() => window.localStorage.setItem("contourcast.respect-water.v1", "dismissed"));
  await page.goto("/");
});

test("selected and rejected photos expose local preview, type, size, and removable state", async ({ page }) => {
  const modal = await preparePastTrip(page);
  const input = modal.locator('input[type="file"]');

  await input.setInputFiles({ name: "verification.png", mimeType: "image/png", buffer: PNG });
  const selected = modal.locator(".photo-field-selected");
  await expect(selected).toContainText("verification.png");
  await expect(selected).toContainText(`PNG · ${PNG.length} B`);
  await expect(selected).toContainText("Selected only—nothing has uploaded yet.");
  await expect(selected.getByRole("img", { name: "Selected verification photo preview" })).toBeVisible();
  await expect(selected.getByRole("button", { name: "Remove" })).toBeVisible();
  await expect(selected.getByRole("progressbar")).toHaveCount(0);

  await selected.getByRole("button", { name: "Remove" }).click();
  await expect(modal.getByText("Choose a photo", { exact: true })).toBeVisible();

  await input.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") });
  const rejected = modal.locator(".photo-field-invalid");
  await expect(rejected).toContainText("notes.txt");
  await expect(rejected).toContainText("text/plain · 12 B");
  await expect(rejected).toContainText("Use a JPEG, PNG, or WebP photo.");
  await rejected.getByRole("button", { name: "Dismiss" }).click();
  await expect(modal.getByText("Choose a photo", { exact: true })).toBeVisible();
});

test("pending UI stays indeterminate until an exact stored-photo receipt confirms success", async ({ page }) => {
  let releaseResponse!: () => void;
  const held = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route("**/api/trips/report", async (route) => {
    await held;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(pastTripReceipt(route)),
    });
  });

  const modal = await preparePastTrip(page);
  await modal.locator('input[type="file"]').setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  await modal.getByRole("button", { name: "Record no-fish trip" }).click();

  const sending = modal.locator(".photo-field-sending");
  await expect(sending).toContainText("No attachment is confirmed yet.");
  const progress = sending.getByRole("progressbar", { name: "Sending verification photo with trip report" });
  await expect(progress).toHaveAttribute("aria-valuetext", "Sending with the report; byte progress is unavailable");
  await expect(progress).not.toHaveAttribute("aria-valuenow", /.+/);
  await expect(sending.getByRole("button", { name: "Remove" })).toHaveCount(0);

  releaseResponse();
  await expect(modal.locator(".photo-field-confirmed")).toContainText("exact trip receipt confirms a private stored photo");
  await expect(modal.locator(".trip-form-status")).toContainText("verification photo is stored privately with the trip");
});

test("an exact receipt that does not confirm the photo stays ambiguous and retries idempotently", async ({ page }) => {
  let attempts = 0;
  const tripIds: string[] = [];
  await page.route("**/api/trips/report", async (route) => {
    attempts += 1;
    const receipt = pastTripReceipt(route, attempts !== 1);
    tripIds.push(receipt.trip.id);
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(receipt) });
  });

  const modal = await preparePastTrip(page);
  await modal.locator('input[type="file"]').setInputFiles({ name: "retry.png", mimeType: "image/png", buffer: PNG });
  await modal.getByRole("button", { name: "Record no-fish trip" }).click();

  const ambiguous = modal.locator(".photo-field-ambiguous");
  await expect(ambiguous).toContainText("Outcome unknown. Keep this file selected and use the same safe report retry.");
  await expect(ambiguous).toContainText("cancel control is intentionally unavailable");
  await expect(ambiguous.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await modal.getByRole("button", { name: "Retry safely" }).click();

  await expect(modal.locator(".photo-field-confirmed")).toBeVisible();
  expect(attempts).toBe(2);
  expect(tripIds[1]).toBe(tripIds[0]);
});

test("an authoritative rejection exposes remove and explicit whole-report retry", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/trips/report", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      return route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "photo_rejected", message: "The photo was rejected." } }),
      });
    }
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(pastTripReceipt(route)),
    });
  });

  const modal = await preparePastTrip(page);
  await modal.locator('input[type="file"]').setInputFiles({ name: "correctable.png", mimeType: "image/png", buffer: PNG });
  await modal.getByRole("button", { name: "Record no-fish trip" }).click();

  const failed = modal.locator(".photo-field-failed");
  await expect(failed).toContainText("Not confirmed. Correct any report error, then retry the whole report explicitly.");
  await expect(failed.getByRole("button", { name: "Remove" })).toBeEnabled();
  await failed.getByRole("button", { name: "Retry report with this photo" }).click();

  await expect(modal.locator(".photo-field-confirmed")).toBeVisible();
  expect(attempts).toBe(2);
});
