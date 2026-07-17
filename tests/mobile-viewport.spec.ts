import { expect, test } from "@playwright/test";

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

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ user: null }),
  }));
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
