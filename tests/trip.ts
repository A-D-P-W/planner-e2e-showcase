import * as fs from 'fs';
import * as path from 'path';

// The fixture the demo app loads. Tests read the same file, so a change to the trip changes the expectations with it.
export type Trip = { title: string; start: string; days: { title: string; items: string[] }[]; checklist: { id: string; text: string }[] };
export const trip: Trip = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'demo', 'trip.json'), 'utf-8'));

// Expected labels are computed here in UTC from the fixture's start date, independent of the app's own date code
// and of the machine's time zone.
export function expectedLabel(n: number): string {
  const [y, m, d] = trip.start.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n - 1)).toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
  });
}
