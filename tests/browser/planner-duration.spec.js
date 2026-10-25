import { test, expect } from "@playwright/test";
import { browserErrors } from "./diagnostics.js";

test("custom free time accepts decimal hours and keeps the duration when the unit changes", async ({ page }) => {
  const errors = browserErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/plan");
  const form = page.locator("#plan");
  const pick = (name, value) => form.locator("label").filter({ has: page.locator(`input[name="${name}"][value="${value}"]`) }).click();
  await pick("activity", "study");
  await pick("preset", "custom");

  const amount = form.locator('input[name="custom"]');
  const unit = form.locator('select[name="customUnit"]');
  await expect(amount).toBeVisible();
  await expect(unit).toBeVisible();

  const start = await form.locator('input[name="start"]').inputValue();          // demo clock, e.g. 17:30
  const [h, m] = start.split(":").map(Number);
  const end = h * 60 + m + 90;
  const endText = `${(Math.floor(end / 60) % 12) || 12}:${String(end % 60).padStart(2, "0")} ${Math.floor(end / 60) % 24 < 12 ? "AM" : "PM"}`;

  await unit.selectOption("hours");
  await amount.fill("1.5");
  await expect(page.locator("#until")).toHaveText(`· until ${endText}`);
  await expect(page.locator("#results")).not.toContainText("Choose an activity");

  await unit.selectOption("minutes");
  await expect(amount).toHaveValue("90");
  await expect(page.locator("#until")).toHaveText(`· until ${endText}`);

  await unit.selectOption("hours");
  await expect(amount).toHaveValue("1.5");
  await amount.fill("0");
  await amount.blur();
  await expect(form.locator(".form-error")).toContainText("5 to 720");

  await pick("preset", "60");
  await expect(amount).toBeHidden();
  expect(errors).toEqual([]);
});
