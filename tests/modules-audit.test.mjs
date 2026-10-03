// Property tests for the modules the first audit did not cover: layout, balloons, crops, image analysis,
// set book, hair colours. Run: node tests/modules-audit.test.mjs   (pure logic; nothing is drawn or paid)
import assert from 'node:assert/strict';
import { chooseLayout, frameGenerationSize, MAX_FRAMES, FRAME_GAP } from '../page-layout.js';
import { placeBubbleGroups, headZones, trimGutters } from '../bubble-placement.js';
import { computeGroupGeometry, computeTailShape, toShoutGeometry, segmentsToPathData } from '../bubble-geometry.js';
import { computeCropRect, headCropRect, faceRegion, pickHead, peopleCenterX } from '../panel-crop.js';
import { locateTopClumps, locateHairBlob, hairColorOf, skinToneOf } from '../image-analysis.js';
import { findKnownSet, mergeSet, matchPlace } from '../set-book.js';
import { samePlace } from '../director.js';
import { splitLongLine } from '../bubbles.js';

let passed = 0; let failed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log(`ok   - ${name}`); } catch (e) { failed++; console.log(`FAIL - ${name}\n       ${String(e.message).split('\n').slice(0, 4).join('\n       ')}`); } };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const finite = (...v) => v.every((x) => Number.isFinite(x));

test('layout: every frame lies inside the page, frames do not overlap, nothing is left empty (2-6 frames, 500 random pages)', () => {
    const bad = [];
    for (let seed = 1; seed <= 500; seed++) {
        const r = rng(seed); const pick = (a) => a[Math.floor(r() * a.length)];
        const n = 2 + Math.floor(r() * 5);
        const frames = Array.from({ length: n }, () => ({ kind: pick(['character', 'insert', 'establishing']), people: Math.floor(r() * 4), shot: pick(['wide shot', 'full shot', 'medium shot', 'close-up', 'extreme close-up']), emphasis: r() < 0.25 ? 'main' : 'normal', words: Math.floor(r() * 40) }));
        const L = chooseLayout(frames, { seed: String(seed) });
        const a = L.aspect;
        let area = 0;
        for (const f of L.frames) {
            if (!finite(f.x0, f.x1, f.y0, f.y1, f.aspect, f.share)) { bad.push(`seed ${seed}: NaN`); continue; }
            if (f.x0 < -1e-6 || f.x1 > 1 + 1e-6 || f.y0 < -1e-6 || f.y1 > a + 1e-6) bad.push(`seed ${seed}: frame outside the page`);
            if (f.x1 - f.x0 <= 0 || f.y1 - f.y0 <= 0) bad.push(`seed ${seed}: empty frame`);
            area += (f.x1 - f.x0) * (f.y1 - f.y0);
        }
        for (let i = 0; i < L.frames.length; i++) for (let j = i + 1; j < L.frames.length; j++) {
            const A = L.frames[i], B = L.frames[j];
            const ix = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0); const iy = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
            if (ix > 1e-6 && iy > 1e-6) bad.push(`seed ${seed}: frames ${i} and ${j} overlap`);
        }
        // the gaps take at most FRAME_GAP-wide strips: holes bigger than that are white space
        const hole = a - area;
        if (hole > a * 0.2) bad.push(`seed ${seed}: ${(hole / a * 100).toFixed(0)}% of the page is empty (${L.template})`);
        const first = L.frames[0];
        if (!first.touchesTop) bad.push(`seed ${seed}: first frame does not touch the top`);
        if (!L.frames.some((f) => f.touchesBottom)) bad.push(`seed ${seed}: no frame touches the bottom (${L.template}, a=${a}) - white band under the page`);
    }
    assert.equal(bad.length, 0, `${bad.length} problems, e.g. ${[...new Set(bad)].slice(0, 4).join(' | ')}`);
});
test('layout: generation size is a multiple of 64 inside 512..1664', () => {
    for (const aspect of [0.2, 0.42, 0.62, 1, 1.8, 3, 9]) for (const share of [0.05, 0.2, 0.5, 1]) {
        const { width, height } = frameGenerationSize(aspect, share);
        assert.ok(width % 64 === 0 && height % 64 === 0 && width >= 512 && height >= 512 && width <= 1664 && height <= 1664, `${aspect}/${share}: ${width}x${height}`);
    }
});
test('crops: every crop rectangle stays inside the picture and has area (600 random cases)', () => {
    const bad = [];
    for (let seed = 1; seed <= 600; seed++) {
        const r = rng(seed); const pick = (a) => a[Math.floor(r() * a.length)];
        const src = 0.4 + r() * 2; const shot = pick(['medium shot', 'close-up', 'extreme close-up']); const ta = r() < 0.5 ? null : 0.5 + r() * 1.5;
        const focal = r() < 0.2 ? null : { x: r(), y: r() };
        const head = r() < 0.5 ? null : { x: r(), y: r() * 0.6, spreadY: 0.01 + r() * 0.1 };
        const box = { x0: r() * 0.7, y0: r() * 0.7, x1: 0, y1: 0 }; box.x1 = box.x0 + 0.03 + r() * 0.3; box.y1 = box.y0 + 0.03 + r() * 0.3; box.x1 = Math.min(1, box.x1); box.y1 = Math.min(1, box.y1);
        for (const [name, rect] of [['computeCropRect', computeCropRect(focal, src, shot, ta, head)], ['headCropRect', headCropRect(box, src, shot, ta)], ['faceRegion', faceRegion(box, src)]]) {
            if (!finite(rect.x0, rect.y0, rect.x1, rect.y1) || rect.x0 < -1e-9 || rect.y0 < -1e-9 || rect.x1 > 1 + 1e-9 || rect.y1 > 1 + 1e-9 || rect.x1 - rect.x0 <= 0 || rect.y1 - rect.y0 <= 0) bad.push(`${name} seed ${seed}: ${JSON.stringify(rect)}`);
        }
    }
    assert.equal(bad.length, 0, `${bad.length} bad, e.g. ${bad.slice(0, 3).join(' | ')}`);
});
test('image analysis: clump and hair finders never return NaN and stay in the picture (300 random point clouds)', () => {
    for (let seed = 1; seed <= 300; seed++) {
        const r = rng(seed); const n = Math.floor(r() * 4000); const pts = [];
        const cx = r(), cy = r() * 0.6;
        for (let i = 0; i < n; i++) { if (r() < 0.7) pts.push(Math.min(1, Math.max(0, cx + (r() - 0.5) * 0.15)), Math.min(1, Math.max(0, cy + (r() - 0.5) * 0.2))); else pts.push(r(), r()); }
        for (const c of locateTopClumps(pts, 160 * 120, 3)) assert.ok(finite(c.x, c.y, c.share, c.spreadX, c.spreadY) && c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1, `seed ${seed}`);
        const h = locateHairBlob(pts, 160 * 120);
        if (h) assert.ok(finite(h.x, h.y, h.share) && h.x >= 0 && h.x <= 1, `hair seed ${seed}`);
    }
    assert.deepEqual(locateTopClumps([], 100), []);
    assert.equal(pickHead([], null, 0.5), null);
    assert.equal(peopleCenterX([]), 0.5);
});
test('hair colour is found in "red-haired" as well as "red hair"', () => {
    assert.equal(hairColorOf('a red-haired woman'), 'red');
    assert.equal(hairColorOf('long pink hair, amber eyes'), 'pink');
    assert.equal(hairColorOf('blonde-haired boy'), 'blonde');
    assert.equal(hairColorOf('black hair'), null);
    assert.equal(skinToneOf('a dark-skinned guard'), 'dark');
});
test('balloons: every placed balloon is inside the strip, none is NaN, and order is kept (500 random panels)', () => {
    const bad = [];
    for (let seed = 1; seed <= 500; seed++) {
        const r = rng(seed); const W = 300 + Math.floor(r() * 300); const H = 200 + Math.floor(r() * 700);
        const art = r() < 0.5 ? { x0: 0, y0: 0, x1: 1, y1: 1 } : { x0: 0, y0: 0.08, x1: 1, y1: 0.92 };
        const n = 1 + Math.floor(r() * 5);
        const groups = Array.from({ length: n }, (_, i) => ({ id: `g${i}`, width: 80 + Math.floor(r() * 220), height: 40 + Math.floor(r() * 120), hintSide: ['left', 'center', 'right', null][Math.floor(r() * 4)], target: r() < 0.5 ? { x: r(), y: r() } : null }));
        const cells = new Float32Array(20 * 14).map(() => r());
        const res = placeBubbleGroups({ stripWidth: W, stripHeight: H, imageRect: art, groups, occupancyMap: r() < 0.2 ? null : { cols: 20, rows: 14, cells }, avoid: r() < 0.5 ? [{ x0: 0.3, x1: 0.6, y0: 0.1, y1: 0.4 }] : [] });
        for (const g of groups) {
            const p = res.get(g.id);
            if (!p) { bad.push(`seed ${seed}: ${g.id} not placed`); continue; }
            if (!finite(p.left, p.top)) { bad.push(`seed ${seed}: NaN`); continue; }
            if (p.left < -1 || p.top < -1 || p.left + g.width > W + 1 + (g.width > W ? g.width - W : 0) || p.top + g.height > H + 1 + (g.height > H ? g.height - H : 0)) bad.push(`seed ${seed}: ${g.id} outside (${p.left.toFixed(0)},${p.top.toFixed(0)} ${g.width}x${g.height} in ${W}x${H})`);
        }
    }
    assert.equal(bad.length, 0, `${bad.length} bad, e.g. ${bad.slice(0, 3).join(' | ')}`);
});
test('balloons: groups that fit are never placed on top of each other (300 random panels with room)', () => {
    let overlaps = 0;
    for (let seed = 1; seed <= 300; seed++) {
        const r = rng(seed + 5000); const W = 560; const H = 700;
        const n = 1 + Math.floor(r() * 3);
        const groups = Array.from({ length: n }, (_, i) => ({ id: `g${i}`, width: 120 + Math.floor(r() * 100), height: 60 + Math.floor(r() * 60), hintSide: null, target: null }));
        const res = placeBubbleGroups({ stripWidth: W, stripHeight: H, imageRect: { x0: 0, y0: 0, x1: 1, y1: 1 }, groups, occupancyMap: null, avoid: [] });
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
            const a = res.get(`g${i}`), b = res.get(`g${j}`);
            const ix = Math.min(a.left + groups[i].width, b.left + groups[j].width) - Math.max(a.left, b.left);
            const iy = Math.min(a.top + groups[i].height, b.top + groups[j].height) - Math.max(a.top, b.top);
            if (ix > 4 && iy > 4) overlaps++;
        }
    }
    assert.equal(overlaps, 0, `${overlaps} overlapping pairs`);
});
test('balloon geometry: finite size, lobes inside the group, tails and shouts finite (300 random groups)', () => {
    for (let seed = 1; seed <= 300; seed++) {
        const r = rng(seed + 9000); const n = 1 + Math.floor(r() * 2);
        const boxes = Array.from({ length: n }, () => ({ width: 20 + Math.floor(r() * 220), height: 14 + Math.floor(r() * 120) }));
        const g = computeGroupGeometry(boxes);
        assert.ok(g && finite(g.width, g.height) && g.width > 0 && g.height > 0, `seed ${seed}`);
        for (const l of g.lobes) assert.ok(finite(l.cx, l.cy, l.rx, l.ry) && l.cx - l.rx >= -1 && l.cx + l.rx <= g.width + 1 && l.cy - l.ry >= -1 && l.cy + l.ry <= g.height + 1, `lobe outside, seed ${seed}`);
        assert.ok(segmentsToPathData(g.segments).length > 0);
        for (const side of ['left', 'center', 'right']) for (const up of [false, true]) { const t = computeTailShape(g, side, undefined, up); if (t) for (const pt of [...t.outer, ...t.inner]) assert.ok(finite(pt.x, pt.y), `tail NaN seed ${seed}`); }
        const s = toShoutGeometry(computeGroupGeometry([boxes[0]])); assert.ok(finite(s.width, s.height));
    }
    assert.equal(computeGroupGeometry([]), null);
    assert.ok(computeGroupGeometry([{ width: 0, height: 0 }]), 'a failed measurement still gives a balloon');
});
test('balloon text: splitting a long line keeps every word, in order, in pieces of at most maxWords', () => {
    for (let seed = 1; seed <= 200; seed++) {
        const r = rng(seed); const n = 1 + Math.floor(r() * 90);
        const words = Array.from({ length: n }, (_, i) => (r() < 0.1 ? `w${i},` : `w${i}`)); const text = words.join(' ');
        const max = 6 + Math.floor(r() * 20);
        const parts = splitLongLine(text, max);
        assert.equal(parts.join(' '), text); for (const p of parts) assert.ok(p.split(' ').length <= max, `${p.split(' ').length} > ${max}`);
    }
});
test('set book: places named in Arabic or with accents are kept and found (they were dropped: only a-z was read)', () => {
    const chat = [{ extra: { manga: { scene: { places: [{ name: 'مقهى الحي', kind: 'place', label: 'the cafe', look: 'a small warm cafe' }, { name: 'Café Lumière', kind: 'place', label: 'the café', look: 'brass and wood' }] } } } }, {}];
    const known = findKnownSet(chat, 1);
    assert.equal(known.length, 2, `kept ${known.length} of 2`);
    assert.equal(matchPlace('مقهى الحي', known)?.name, 'مقهى الحي');
    assert.equal(matchPlace('Cafe Lumiere', known)?.name, 'Café Lumière');
    assert.equal(mergeSet(known, [{ name: 'سوق المدينة', kind: 'place', label: 'the market', look: 'busy stalls' }]).length, 3);
});
test('same place: different non-Latin places are different places (everything was "the same place")', () => {
    assert.equal(samePlace('مقهى الحي', 'ساحة السوق'), false);
    assert.equal(samePlace('مقهى الحي', 'مقهى الحي القديم'), true);
    assert.equal(samePlace('the tavern', 'tavern door'), true);
    assert.equal(samePlace('the tavern', 'the harbor'), false);
    assert.equal(samePlace('', 'the harbor'), true, 'an unknown place keeps the old behaviour');
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
