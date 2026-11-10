import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import {
  ZERO_MONEY,
  absAgorot,
  divideMoney,
  fromAgorot,
  money,
  moneyOrNull,
  moneyToNumber,
  moneyToNumberOrNull,
  sumMoney,
  toAgorot,
} from './money';

const D = (v: string) => new Prisma.Decimal(v);

test('money() normalizes Decimal, string and float input to an exact 2-decimal Decimal', () => {
  assert.equal(money(D('-12.35')).toFixed(2), '-12.35');
  assert.equal(money('100.10').toFixed(2), '100.10');
  // Binary-float noise from the old Float columns / JS math disappears.
  assert.equal(money(0.1 + 0.2).toString(), '0.3');
  assert.equal(money(19.99 * 3).toString(), '59.97');
  assert.equal(money(1.1 * 3).toString(), '3.3');
  assert.equal(money(-(100.1 + 200.2)).toString(), '-300.3');
  assert.ok(money(0) instanceof Prisma.Decimal);
});

test('money() rejects non-finite input instead of storing NaN', () => {
  assert.throws(() => money(Number.NaN), /finite/);
  assert.throws(() => money(Number.POSITIVE_INFINITY), /finite/);
  assert.throws(() => money('abc'));
});

test('sumMoney is exact where float addition drifts', () => {
  const floats = [0.1, 0.2, 0.3, -0.6];
  assert.notEqual(floats.reduce((s, x) => s + x, 0), 0); // the float bug this fixes
  assert.equal(sumMoney(floats).toString(), '0');
  assert.equal(sumMoney([D('9876.54'), null, undefined, D('-0.01')]).toString(), '9876.53');
  assert.equal(sumMoney([]).toString(), '0');
  assert.ok(ZERO_MONEY.isZero());
});

test('toAgorot / fromAgorot round-trip exactly; matching keys stay integer', () => {
  assert.equal(toAgorot(D('-1234.56')), -123456);
  assert.equal(toAgorot(4.35), 435); // 4.35 * 100 === 434.99999999999994 in floats
  assert.equal(toAgorot((0.1 + 0.2) * 1000), 30000);
  assert.equal(absAgorot(D('-300.00')), 30000);
  assert.equal(fromAgorot(-123456).toString(), '-1234.56');
  assert.equal(toAgorot(fromAgorot(987654321)), 987654321);
});

test('divideMoney rounds half-up to the agorot (avg6 / pacing)', () => {
  assert.equal(divideMoney(D('0.03'), 6).toString(), '0.01'); // 0.005 -> 0.01
  assert.equal(divideMoney(D('46181.01'), 6).toString(), '7696.84'); // 7696.835 -> .84
  assert.equal(divideMoney(D('100'), 3).toString(), '33.33');
  assert.equal(divideMoney(D('-0.03'), 6).toString(), '-0.01'); // away from zero
});

test('moneyToNumber is the only Decimal -> number conversion (UI/JSON boundary)', () => {
  assert.equal(moneyToNumber(D('-12.35')), -12.35);
  assert.equal(moneyToNumber(D('0.30')), 0.3);
  assert.equal(moneyToNumber(0.1 + 0.2), 0.3); // rounds legacy float input to the agorot
  assert.equal(moneyToNumberOrNull(null), null);
  assert.equal(moneyToNumberOrNull(D('1.50')), 1.5);
  assert.equal(moneyOrNull(undefined), null);
  assert.equal(moneyOrNull(D('2'))?.toString(), '2');
  // Decimal's own JSON form is a string — which is why routes must not
  // serialize raw Prisma rows.
  assert.equal(JSON.stringify({ a: D('1.5') }), '{"a":"1.5"}');
});
