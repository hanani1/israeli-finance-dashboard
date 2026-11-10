import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RELATIVE_DATE_PRESETS,
  parseDatePreset,
  relativePresetRange,
  resolveDateRange,
} from './datePresets';

// "Last N months" = the current Israeli calendar month plus the N-1 previous
// whole months, ending today (Israel-local). See the relative date presets ADR
// in docs/decisions.

test('relativePresetRange: card example — 2026-11-02', () => {
  const now = new Date('2026-11-02T10:00:00.000Z');
  assert.deepEqual(relativePresetRange('3m', now), { from: '2026-09-01', to: '2026-11-02' });
  assert.deepEqual(relativePresetRange('6m', now), { from: '2026-06-01', to: '2026-11-02' });
  assert.deepEqual(relativePresetRange('12m', now), { from: '2025-12-01', to: '2026-11-02' });
});

test('relativePresetRange: on the 1st of a month the window still includes the current month', () => {
  const now = new Date('2026-09-01T09:00:00.000Z');
  assert.deepEqual(relativePresetRange('3m', now), { from: '2026-07-01', to: '2026-09-01' });
});

test('relativePresetRange: last day of a month', () => {
  const now = new Date('2026-08-31T12:00:00.000Z');
  assert.deepEqual(relativePresetRange('6m', now), { from: '2026-03-01', to: '2026-08-31' });
});

test('relativePresetRange: January rolls back into the previous year', () => {
  const jan = new Date('2026-01-15T12:00:00.000Z');
  assert.deepEqual(relativePresetRange('3m', jan), { from: '2025-11-01', to: '2026-01-15' });
  assert.deepEqual(relativePresetRange('6m', jan), { from: '2025-08-01', to: '2026-01-15' });
  assert.deepEqual(relativePresetRange('12m', jan), { from: '2025-02-01', to: '2026-01-15' });
  const feb = new Date('2026-02-10T12:00:00.000Z');
  assert.deepEqual(relativePresetRange('3m', feb), { from: '2025-12-01', to: '2026-02-10' });
  const dec = new Date('2026-12-31T12:00:00.000Z');
  assert.deepEqual(relativePresetRange('12m', dec), { from: '2026-01-01', to: '2026-12-31' });
});

test('relativePresetRange: Israel midnight, not UTC, decides "today" (winter, IST UTC+2)', () => {
  // 2026-10-31T22:30Z is already 00:30 on 1 Nov in Israel.
  const now = new Date('2026-10-31T22:30:00.000Z');
  assert.deepEqual(relativePresetRange('3m', now), { from: '2026-09-01', to: '2026-11-01' });
  // One hour earlier it is still 31 Oct in Israel.
  const before = new Date('2026-10-31T21:30:00.000Z');
  assert.deepEqual(relativePresetRange('3m', before), { from: '2026-08-01', to: '2026-10-31' });
});

test('relativePresetRange: Israel midnight in summer (IDT UTC+3) and at New Year', () => {
  const july = new Date('2026-06-30T21:30:00.000Z'); // 00:30 on 1 Jul IDT
  assert.deepEqual(relativePresetRange('3m', july), { from: '2026-05-01', to: '2026-07-01' });
  const newYear = new Date('2025-12-31T22:30:00.000Z'); // 00:30 on 1 Jan 2026 IST
  assert.deepEqual(relativePresetRange('3m', newYear), { from: '2025-11-01', to: '2026-01-01' });
});

test('relativePresetRange: leap day', () => {
  const leap = new Date('2028-02-29T12:00:00.000Z');
  assert.deepEqual(relativePresetRange('3m', leap), { from: '2027-12-01', to: '2028-02-29' });
  assert.deepEqual(relativePresetRange('12m', leap), { from: '2027-03-01', to: '2028-02-29' });
  // Leap-day start of IST day: 2028-02-28T22:00Z is 00:00 on 29 Feb.
  assert.deepEqual(relativePresetRange('6m', new Date('2028-02-28T22:00:00.000Z')), {
    from: '2027-09-01',
    to: '2028-02-29',
  });
});

test('relativePresetRange: from is never after to', () => {
  const now = new Date('2026-03-01T00:00:00.000Z');
  for (const preset of RELATIVE_DATE_PRESETS) {
    const { from, to } = relativePresetRange(preset, now);
    assert.ok(from <= to, `${preset}: ${from} > ${to}`);
  }
});

test('parseDatePreset: only known relative presets are accepted', () => {
  assert.equal(parseDatePreset('3m'), '3m');
  assert.equal(parseDatePreset('6m'), '6m');
  assert.equal(parseDatePreset('12m'), '12m');
  assert.equal(parseDatePreset('custom'), null);
  assert.equal(parseDatePreset('24m'), null);
  assert.equal(parseDatePreset(''), null);
  assert.equal(parseDatePreset(null), null);
  assert.equal(parseDatePreset(undefined), null);
});

const defaults = { from: '2026-11-01', to: '2026-11-02' };
const now = new Date('2026-11-02T10:00:00.000Z');

test('resolveDateRange: a preset in the URL wins over stale from/to and is recomputed', () => {
  assert.deepEqual(
    resolveDateRange({ range: '3m', from: '2026-01-01', to: '2026-01-31' }, now, defaults),
    { preset: '3m', from: '2026-09-01', to: '2026-11-02' },
  );
});

test('resolveDateRange: no preset → custom dates from the URL, else defaults', () => {
  assert.deepEqual(
    resolveDateRange({ from: '2026-01-01', to: '2026-01-31' }, now, defaults),
    { preset: 'custom', from: '2026-01-01', to: '2026-01-31' },
  );
  assert.deepEqual(resolveDateRange({}, now, defaults), { preset: 'custom', ...defaults });
  assert.deepEqual(
    resolveDateRange({ range: 'bogus', from: '2026-02-01' }, now, defaults),
    { preset: 'custom', from: '2026-02-01', to: '2026-11-02' },
  );
});
