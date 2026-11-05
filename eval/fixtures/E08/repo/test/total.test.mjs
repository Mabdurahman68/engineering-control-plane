import assert from 'node:assert/strict';
import { test } from 'node:test';
import { total, TAX } from '../src/total.mjs';

test('the tax rate', () => {
  assert.equal(TAX, 0.2);
});
test('adds every price', () => {
  assert.equal(total([10, 20]), 33);
});
test('no prices', () => {
  assert.equal(total([]), 0);
});
