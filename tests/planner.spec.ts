import { test, expect, type Page } from '@playwright/test';
import { trip, expectedLabel } from './trip';

// The browser runs in America/Los_Angeles (playwright.config.ts). The fixture trip runs from Mon 28 Oct to Wed 13 Nov
// 2030 and crosses the end of daylight saving time (Sun 3 Nov 2030, 02:00 PDT -> 01:00 PST), so the instants below
// carry an explicit UTC offset.
const DURING_TRIP = '2030-11-01T12:00:00-07:00';

// Every test fixes the browser clock before the app loads, so "today" never depends on when the suite runs.
async function open(page: Page, at: string = DURING_TRIP) {
  await page.clock.setFixedTime(new Date(at));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
}

test.describe('loading', () => {
  test('title names the trip', async ({ page }) => {
    await open(page);
    await expect(page).toHaveTitle(`${trip.title} · Trip Planner (demo)`);
  });

  test('a failed fixture load shows an error instead of an empty page', async ({ page }) => {
    await page.route('**/trip.json', route => route.fulfill({ status: 500, body: 'server error' }));
    await page.goto('/');
    await expect(page.getByRole('alert')).toHaveText('Could not load the trip data (HTTP 500).');
  });

  // Trip data is untrusted input. A fixture whose text is markup must appear as that literal text, and its script must
  // never run: every view is opened so each rendering path sees the payload.
  test('markup in the trip data is shown as text and never runs', async ({ page }) => {
    const payload = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
    const hostile = { ...trip, title: payload, days: trip.days.map(d => ({ title: payload, items: [payload] })),
      checklist: [{ id: 'x', text: payload }] };
    await page.route('**/trip.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hostile) }));
    await open(page);
    for (const view of ['Full plan', 'List', 'Today']) await page.getByRole('button', { name: view, exact: true }).click();
    await page.getByRole('button', { name: 'Full plan', exact: true }).click();
    await page.getByRole('button', { name: /^Day 1 · / }).click();
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    await expect(page.locator('main img, main b, header img, header b')).toHaveCount(0);
    await expect(page.locator('#day-1').getByRole('listitem')).toHaveText(payload);
  });
  test('the app makes no requests outside the local demo server', async ({ page, baseURL }) => {
    const requests: string[] = [];
    page.on('request', r => requests.push(r.url()));
    page.on('websocket', ws => requests.push(ws.url())); // WebSocket connections are not 'request' events
    await open(page);
    for (const view of ['Full plan', 'List', 'Today']) await page.getByRole('button', { name: view, exact: true }).click();
    const origin = new URL(baseURL!).origin;
    expect(requests.length).toBeGreaterThanOrEqual(2); // the page and trip.json: the listener did see traffic
    expect(requests.filter(u => new URL(u).origin !== origin)).toEqual([]);
  });
});

test.describe('Today view', () => {
  // [clock instant, expected heading]
  const cases: [string, string][] = [
    ['2030-10-25T12:00:00-07:00', 'Trip starts in 3 days'],
    ['2030-10-27T23:30:00-07:00', 'Trip starts in 1 day'],
    ['2030-10-28T00:00:00-07:00', `Today is Day 1 of ${trip.days.length}`],
    ['2030-11-03T01:30:00-07:00', `Today is Day 7 of ${trip.days.length}`], // before the clocks go back
    ['2030-11-03T23:30:00-08:00', `Today is Day 7 of ${trip.days.length}`], // 25-hour day: still Day 7
    ['2030-11-04T00:30:00-08:00', `Today is Day 8 of ${trip.days.length}`],
    ['2030-11-13T23:59:00-08:00', `Today is Day ${trip.days.length} of ${trip.days.length}`],
    ['2030-11-14T00:00:00-08:00', 'Trip complete'],
  ];
  for (const [at, heading] of cases) {
    test(`at ${at} shows "${heading}"`, async ({ page }) => {
      await open(page, at);
      await expect(page.getByRole('heading', { level: 2 })).toHaveText(heading);
    });
  }

  test('during the trip lists that day\'s items', async ({ page }) => {
    await open(page, '2030-11-03T12:00:00-08:00');
    await expect(page.getByText(`${expectedLabel(7)} · ${trip.days[6].title}`)).toBeVisible();
    await expect(page.getByRole('listitem')).toHaveText(trip.days[6].items);
  });
});

test.describe('Full plan view', () => {
  test.beforeEach(async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Full plan' }).click();
  });

  // One web-first assertion: it retries until the buttons match, and checks the count, the order and every label
  // (a missing, extra, reordered or mislabeled day each fails it, and the diff names the day).
  test('lists every day in order with its date, with no date repeated or skipped across the clock change', async ({ page }) => {
    await expect(page.getByRole('button', { name: /^Day \d+ · / })).toHaveText(trip.days.map((_, i) => `Day ${i + 1} · ${expectedLabel(i + 1)}`));
  });

  test('a day opens and closes', async ({ page }) => {
    const day = page.getByRole('button', { name: `Day 3 · ${expectedLabel(3)}` });
    const items = page.locator('#day-3').getByRole('listitem');
    await expect(items.first()).toBeHidden();
    await day.click();
    await expect(day).toHaveAttribute('aria-expanded', 'true');
    await expect(items).toHaveText(trip.days[2].items);
    await day.click();
    await expect(day).toHaveAttribute('aria-expanded', 'false');
    await expect(items.first()).toBeHidden();
  });
});

test.describe('List view', () => {
  test('shows every checklist item, unticked at first', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'List' }).click();
    await expect(page.getByRole('heading', { name: 'Packing list' })).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(trip.checklist.length);
    for (const item of trip.checklist) await expect(page.getByRole('checkbox', { name: item.text })).not.toBeChecked();
  });

  test('a ticked item stays ticked after a reload, and only that item', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'List' }).click();
    await page.getByRole('checkbox', { name: 'Sunscreen' }).check();
    await page.reload();
    await page.getByRole('button', { name: 'List' }).click();
    await expect(page.getByRole('checkbox', { name: 'Sunscreen' })).toBeChecked();
    for (const item of trip.checklist.filter(i => i.text !== 'Sunscreen')) {
      await expect(page.getByRole('checkbox', { name: item.text })).not.toBeChecked();
    }
  });
});
