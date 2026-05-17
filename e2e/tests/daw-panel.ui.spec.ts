import { test, expect } from "@playwright/test";

test.describe("DAW panel UI", () => {
  test.skip(!process.env.E2E_STACK, "Set E2E_STACK=1 with web + API running");

  test("shows DAW project section when signed in", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Display name").fill("UI Tester");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Sessions")).toBeVisible();
    await expect(page.getByText("DAW project", { exact: false })).toBeVisible();
  });
});
