import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clamp } from '../src/clamp.mjs';

test('below', () => assert.equal(clamp(-1, 0, 5), 0));
test('just below', () => assert.equal(clamp(0.5, 1, 5), 1));
test('above', () => assert.equal(clamp(9, 0, 5), 5));
test('just above', () => assert.equal(clamp(5.5, 0, 5), 5));
test('inside', () => assert.equal(clamp(3, 0, 5), 3));
