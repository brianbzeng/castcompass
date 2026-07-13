import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ user: null }),
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
  const centerButton = page.locator(".map-center-button");
  await map.scrollIntoViewIfNeeded();
  if (!(await centerButton.isVisible())) {
    const loadMap = page.getByRole("button", { name: /open interactive map/i });
    if (await loadMap.isVisible()) {
      await loadMap.click().catch(() => undefined);
    }
  }
  await expect(centerButton).toBeVisible();

  const viewportWidth = await page.evaluate(() => window.innerWidth);
  const label = await page.locator(".map-overlay-label").boundingBox();
  const center = await centerButton.boundingBox();
  expect(label).not.toBeNull();
  expect(center).not.toBeNull();
  expect(label!.x + label!.width).toBeLessThanOrEqual(center!.x - 4);
  expect(center!.x + center!.width).toBeLessThanOrEqual(viewportWidth + 1);
});
