import { test, expect } from '@playwright/test';
import { trip, expectedLabel } from './trip';

// Checks of the fixture and of the test helper. They need no browser, so they run once, in the "server" project.
test('the fixture trip has 17 days', () => {
  expect(trip.days.length).toBe(17); // a trip shortened by mistake would otherwise shrink every expectation with it
});

// Anchors checked against an external calendar, so a wrong expectedLabel() cannot hide a wrong app label.
for (const [n, text] of [[1, 'Mon, Oct 28'], [7, 'Sun, Nov 3'], [8, 'Mon, Nov 4'], [17, 'Wed, Nov 13']] as const) {
  test(`anchor: Day ${n} is ${text}`, () => {
    expect(expectedLabel(n)).toBe(text);
  });
}
