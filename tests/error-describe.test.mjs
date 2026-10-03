// Run: node tests/error-describe.test.mjs  - the real reason behind SillyTavern's generic "API request failed".
import assert from 'node:assert/strict';
import { describeError, isTransientError, errorHint } from '../util.js';

const wrapped = (msg) => new Error('API request failed', { cause: new Error(msg) });
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('unwraps the cause hidden by the generic wrapper', () => {
    assert.match(describeError(wrapped('HTTP 402: Insufficient credits')), /Insufficient credits/);
    assert.match(describeError(wrapped('HTTP 402: Insufficient credits')), /credit is used up/);
});
t('a bare wrapper (no cause) is still readable', () => {
    assert.equal(describeError(new Error('API request failed')), 'API request failed');
});
t('only generic messages in the chain: all are shown', () => {
    assert.equal(describeError(wrapped('Response not OK')), 'API request failed - Response not OK');
});
t('plain strings and null do not throw', () => {
    assert.equal(describeError('boom'), 'boom');
    assert.equal(describeError(null), 'unknown error');
});
t('hints for the usual statuses', () => {
    assert.match(errorHint('HTTP 401: invalid api key'), /key/);
    assert.match(errorHint('HTTP 429 rate limit'), /rate limit/);
    assert.match(errorHint('503 model experiencing high demand'), /busy/);
    assert.match(errorHint('404 No endpoints found that support structured outputs'), /model id|provider/);
    assert.match(errorHint('400 Bad Request'), /rejected a setting/);
    assert.equal(errorHint('something else'), '');
});
t('retry only what can pass by itself', () => {
    assert.equal(isTransientError(wrapped('HTTP 503: overloaded')), true);
    assert.equal(isTransientError(wrapped('HTTP 429: rate limit')), true);
    assert.equal(isTransientError(new Error('network error')), true);
    assert.equal(isTransientError(wrapped('HTTP 402: Insufficient credits')), false);
    assert.equal(isTransientError(wrapped('HTTP 401: invalid api key')), false);
    assert.equal(isTransientError(wrapped('HTTP 400: Bad Request')), false);
    assert.equal(isTransientError(new Error('No Connection Profile selected')), false);
});
t('a cyclic cause chain terminates', () => {
    const a = new Error('A'); const b = new Error('B', { cause: a }); a.cause = b;
    assert.ok(describeError(a).length > 0);
});
console.log(`${n} passed`);
