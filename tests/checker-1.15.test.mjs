// 1.15: the checker is told to be tolerant on the action (study of 35 labelled pictures: false redraws 46% -> 21%, false passes 0 -> 1 of 11).
import assert from 'node:assert/strict';
import { frameCheckRequest, FRAME_CHECK_SYSTEM, judge } from '../vision-check.js';
import { DEFAULT_SETTINGS } from '../settings.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('the checker instructions carry the tolerance paragraph', () => {
    assert.match(FRAME_CHECK_SYSTEM, /HOW STRICT TO BE ON THE ACTION/);
    assert.match(FRAME_CHECK_SYSTEM, /When unsure, answer true/);
    assert.match(FRAME_CHECK_SYSTEM, /cut off by the edge of the picture/);
});
t('a request uses the given instructions, else the default ones', () => {
    const exp = { text: 'Frame kind: medium shot.' };
    assert.equal(frameCheckRequest('data:x', exp).messages[0].content, FRAME_CHECK_SYSTEM);
    assert.equal(frameCheckRequest('data:x', exp, 'custom').messages[0].content, 'custom');
});
t('the default checker model is the measured one (flash-lite redrew 67% of good pictures)', () => {
    assert.equal(DEFAULT_SETTINGS.visionModel, 'google/gemini-3.8-flash');
});
t('a key moment that is not shown still fails a frame (the faults the study found)', () => {
    const v = judge({ figures: [], action_shown: false, panels: 1, background: 'full scene', lettering: 'none', illogical: '', defects: '', extra_main_figures: 0, barrier: false }, { labels: [], contact: true, kind: 'character' });
    assert.equal(v.pass, false);
    assert.match(v.reasons.join(' '), /key moment is not shown/);
});
console.log(`${n} passed`);
