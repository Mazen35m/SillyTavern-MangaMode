// Manga-style layouts for one webtoon panel that holds several frames (sub-images).
//
// The scene parser decides WHICH beats belong together in a panel and which one carries it
// ("emphasis": main). This module decides the GEOMETRY, the way a manga artist would: the key
// frame gets the most area (roughly 45-60%), each frame gets a shape that suits what it shows (a
// tall frame for one person's close-up, a wide one for an establishing view, a squarer one for two
// people), and the arrangement is not always the same - big frame left or right, a wide frame on
// top or at the bottom, or three stacked strips for a quick action sequence.
//
// Pure geometry - no DOM - so it is unit tested. Coordinates are fractions of the panel's width;
// `aspect` is the panel's height / width.

/** Space between frames, as a fraction of the panel width. */
export const FRAME_GAP = 0.018;

// Preferred frame shape (width / height) and how far from it is still fine.
function preferredAspect(frame) {
    const kind = frame.kind || 'character';
    const people = Math.max(0, frame.people ?? 1);
    const shot = frame.shot || 'medium shot';
    if (kind === 'establishing') return { ideal: 1.8, min: 1.3, max: 2.6 };
    if (kind === 'insert') return { ideal: 1.2, min: 0.75, max: 1.9 };
    if (shot === 'extreme close-up') return { ideal: 1.6, min: 1.1, max: 2.4 };
    if (shot === 'wide shot') return people >= 2 ? { ideal: 1.35, min: 1.0, max: 2.0 } : { ideal: 1.6, min: 1.1, max: 2.4 };
    if (people >= 2) return { ideal: 1.05, min: 0.75, max: 1.5 };
    // Tall narrow close-ups get a second copy of the person to fill the height (Vanessa #2 redraw).
    if (shot === 'close-up') return { ideal: 0.9, min: 0.72, max: 1.3 };
    if (shot === 'full shot') return { ideal: 0.62, min: 0.45, max: 0.9 };
    return { ideal: 0.75, min: 0.55, max: 1.05 }; // one person, medium shot
}

// Candidate arrangements. Each returns frame rects [x0, y0, x1, y1] in reading order for a panel
// of height `a` (width 1), before gaps are applied. `p` sizes the first split, `q` the second.
function rectsFor(template, a, p, q) {
    switch (template) {
        case 'cols': return [[0, 0, p, a], [p, 0, 1, a]];
        case 'rows': return [[0, 0, 1, a * p], [0, a * p, 1, a]];
        // Big frame left, two stacked on the right (upper one q of the height).
        case 'bigLeft': return [[0, 0, p, a], [p, 0, 1, a * q], [p, a * q, 1, a]];
        // Two stacked on the left, big frame right.
        case 'bigRight': return [[0, 0, 1 - p, a * q], [0, a * q, 1 - p, a], [1 - p, 0, 1, a]];
        // The middle frame big on the right, the first and last stacked on the left (read left
        // top, right, left bottom - used only when the middle frame carries the panel).
        case 'midRight': return [[0, 0, 1 - p, a * q], [1 - p, 0, 1, a], [0, a * q, 1 - p, a]];
        // Full-width frame on top (p of the height), two side by side below (left one q wide).
        case 'topFull': return [[0, 0, 1, a * p], [0, a * p, q, a], [q, a * p, 1, a]];
        // Two side by side on top (left one q wide), full-width frame below (p of the height).
        case 'bottomFull': return [[0, 0, q, a * (1 - p)], [q, 0, 1, a * (1 - p)], [0, a * (1 - p), 1, a]];
        // Three strips, heights p[] - a quick action sequence read top to bottom.
        case 'stack3': return p.map((h, i) => [0, a * p.slice(0, i).reduce((x, y) => x + y, 0), 1, a * p.slice(0, i + 1).reduce((x, y) => x + y, 0)]);
        default: return [];
    }
}

function candidates(n, mainIndex) {
    const out = [];
    const aspects = [0.6, 0.7, 0.8, 0.95, 1.1, 1.25, 1.4, 1.55];
    if (n === 2) {
        const splits = mainIndex === 0 ? [0.5, 0.58, 0.64] : mainIndex === 1 ? [0.5, 0.42, 0.36] : [0.5];
        for (const a of aspects) for (const p of splits) {
            out.push({ template: 'cols', a, p });
            out.push({ template: 'rows', a, p });
        }
    } else if (n === 3) {
        const thirds = [0.38, 0.5, 0.62];
        for (const a of aspects) {
            for (const p of [0.4, 0.45, 0.5, 0.56, 0.62]) for (const q of [0.36, 0.42, 0.5, 0.58, 0.64]) {
                out.push({ template: 'bigLeft', a, p, q });
                out.push({ template: 'bigRight', a, p, q });
                if (mainIndex === 1) out.push({ template: 'midRight', a, p, q });
            }
            for (const p of [0.38, 0.45, 0.5, 0.56, 0.62]) for (const q of thirds) {
                out.push({ template: 'topFull', a, p, q });
                out.push({ template: 'bottomFull', a, p, q });
            }
            const orders = mainIndex === 0 ? [[0.42, 0.29, 0.29]] : mainIndex === 1 ? [[0.29, 0.42, 0.29]] : mainIndex === 2 ? [[0.29, 0.29, 0.42]] : [[1 / 3, 1 / 3, 1 / 3]];
            for (const o of orders) out.push({ template: 'stack3', a, p: o });
        }
    }
    return out;
}

// Which frame in each template is drawn biggest (for the "main frame is the biggest" rule).
function areaOf(r) {
    return Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
}

/**
 * Small deterministic jitter so near-equal layouts vary between replies instead of always being
 * the same one - but the same reply always gets the same layout on re-render.
 */
function jitter(seed, key) {
    let h = 2166136261;
    for (const ch of `${seed}|${key}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return ((h >>> 0) % 1000) / 1000;
}

/**
 * Picks the layout for a panel of 2 or 3 frames.
 * @param {Array<{kind?: string, people?: number, shot?: string, emphasis?: string}>} frames In reading order.
 * @param {{seed?: string}} [options]
 * @returns {{template: string, aspect: number, frames: Array<{x0: number, y0: number, x1: number, y1: number, aspect: number, share: number}>, score: number}}
 */
export function chooseLayout(frames, { seed = '' } = {}) {
    const n = frames.length;
    if (n < 2 || n > MAX_FRAMES) throw new Error(`chooseLayout handles 2-${MAX_FRAMES} frames, got ${n}`);
    const mainIndex = frames.findIndex((f) => f.emphasis === 'main');
    const cands = n <= 3
        ? candidates(n, mainIndex).map((cand) => ({ ...cand, rects: rectsFor(cand.template, cand.a, cand.p, cand.q) }))
        : pageCandidates(frames, mainIndex);
    let best = null;
    for (const cand of cands) {
        const score = scoreLayout(frames, cand, mainIndex, n) + jitter(seed, `${cand.template}:${cand.a}:${cand.p}:${cand.q}`) * 0.12;
        if (!best || score < best.score) best = { ...cand, score };
    }
    return {
        template: best.template,
        aspect: best.a,
        score: best.score,
        frames: best.rects.map((r) => withGap(r, best.a, areaOf(r) / best.a)),
    };
}

/** Most frames one panel may hold (a manga page's worth of one continuous moment). */
export const MAX_FRAMES = 6;

function frameCost(frame, r, total) {
    const w = r[2] - r[0];
    const h = r[3] - r[1];
    const aspect = w / h;
    const share = areaOf(r) / total;
    const pref = preferredAspect(frame);
    const miss = Math.log(aspect / pref.ideal) ** 2;
    const outside = aspect < pref.min ? Math.log(pref.min / aspect) : aspect > pref.max ? Math.log(aspect / pref.max) : 0;
    // Bigger frames matter more: a badly shaped main frame costs more than a small insert.
    return { cost: (miss + outside * 4) * (0.5 + share), share };
}

function scoreLayout(frames, cand, mainIndex, n) {
    let score = 0;
    const minShare = n <= 3 ? 0.17 : 0.11;
    const shares = cand.rects.map((r, i) => {
        const { cost, share } = frameCost(frames[i], r, cand.a);
        score += cost;
        // Nothing too small to read.
        if (share < minShare) score += (minShare - share) * 30;
        // Lettering needs room: a frame with a long exchange must not be the smallest one.
        const needs = Math.min(0.5, 0.04 + (frames[i].words || 0) * 0.006);
        if ((frames[i].words || 0) && share < needs) score += (needs - share) * 12;
        // ...in absolute size too (page width = 1): a close-up's face fills the middle, so it holds
        // fewer words. Three balloons in a half-width close-up of a short two-column page covered
        // the face (08h52 #14); this pushes such a page toward a taller layout.
        const capacity = areaOf(r) * (/close-up/.test(frames[i].shot || '') ? 60 : 100);
        if ((frames[i].words || 0) > capacity) score += ((frames[i].words - capacity) / Math.max(1, capacity)) * 3;
        return share;
    });
    if (mainIndex >= 0) {
        const mainShare = shares[mainIndex];
        const biggest = Math.max(...shares);
        score += Math.max(0, biggest - mainShare) * 14;
        const floor = n === 2 ? 0.4 : n === 3 ? (mainIndex === 1 ? 0.34 : 0.4) : Math.max(0.2, 0.9 / n);
        if (mainShare < floor) score += (floor - mainShare) * 6;
        if (n === 3 && mainShare > 0.62) score += (mainShare - 0.62) * 4;
    } else {
        // No key frame: keep the frames close in size.
        score += (Math.max(...shares) - Math.min(...shares)) * 1.5;
    }
    // A very tall or very flat panel reads badly in a chat column; a page of many frames may be taller.
    const tallest = n <= 3 ? 1.45 : 1.45 + 0.15 * (n - 3);
    if (cand.a > tallest) score += (cand.a - tallest) * 3;
    if (cand.a < 0.6) score += (0.6 - cand.a) * 4;
    if (n === 3 && cand.a < 0.85) score += (0.85 - cand.a) * 2;
    // Reading order is clearest row by row; a column read top-to-bottom first costs a little.
    if (cand.template === 'bigRight' || cand.template === 'colRight') score += 0.08;
    if (cand.template === 'midRight') score += 0.2;
    return score;
}

/** Ordered splits of n frames into rows of 1-3 frames. */
function compositions(n) {
    if (n === 0) return [[]];
    const out = [];
    for (let k = 1; k <= Math.min(3, n); k++) for (const rest of compositions(n - k)) out.push([k, ...rest]);
    return out;
}

const ROW_HEIGHTS = [0.28, 0.34, 0.4, 0.47, 0.55, 0.64, 0.75, 0.88];

/** Widths for one row of frames: the main frame (if in this row) gets the most room. */
function rowWidths(k, mainInRow) {
    if (k === 1) return [[1]];
    if (k === 2) return mainInRow === 0 ? [[0.5, 0.5], [0.6, 0.4]] : mainInRow === 1 ? [[0.5, 0.5], [0.4, 0.6]] : [[0.5, 0.5], [0.42, 0.58], [0.58, 0.42]];
    if (mainInRow >= 0) {
        const w = [0.27, 0.27, 0.27];
        w[mainInRow] = 0.46;
        return [w, [1 / 3, 1 / 3, 1 / 3]];
    }
    return [[1 / 3, 1 / 3, 1 / 3], [0.4, 0.3, 0.3], [0.3, 0.3, 0.4]];
}

/**
 * Candidate pages for 4-6 frames: rows of 1-3 frames (each row's height chosen to fit its frames),
 * or a tall frame down one side with the rest stacked beside it - the arrangements a manga page
 * uses to pack one moment into several frames.
 */
function pageCandidates(frames, mainIndex) {
    const n = frames.length;
    const out = [];
    for (const rows of compositions(n)) {
        // Each row independently: best width split and height for its own frames.
        let y = 0;
        let start = 0;
        const rects = [];
        for (const k of rows) {
            const mainInRow = mainIndex >= start && mainIndex < start + k ? mainIndex - start : -1;
            let bestRow = null;
            for (const widths of rowWidths(k, mainInRow)) {
                for (const h of ROW_HEIGHTS) {
                    let x = 0;
                    const rowRects = widths.map((w) => { const r = [x, y, x + w, y + h]; x += w; return r; });
                    const cost = rowRects.reduce((sum, r, i) => sum + frameCost(frames[start + i], r, 1).cost, 0);
                    if (!bestRow || cost < bestRow.cost) bestRow = { cost, rowRects, h };
                }
            }
            rects.push(...bestRow.rowRects);
            y += bestRow.h;
            start += k;
        }
        out.push({ template: `rows:${rows.join('-')}`, a: Math.round(y * 1000) / 1000, rects });
    }
    // A tall frame on one side (the main one, or the first/last) with the rest stacked beside it.
    for (const side of ['colLeft', 'colRight']) {
        const tallIndex = side === 'colLeft' ? 0 : n - 1;
        const stacked = n - 1;
        if (stacked > 4) continue;
        for (const p of [0.45, 0.55, 0.62]) {
            for (const a of [1.0, 1.2, 1.4, 1.6]) {
                const rects = [];
                const x0 = side === 'colLeft' ? p : 0;
                const x1 = side === 'colLeft' ? 1 : 1 - p;
                const tall = side === 'colLeft' ? [0, 0, p, a] : [1 - p, 0, 1, a];
                const h = a / stacked;
                const stack = Array.from({ length: stacked }, (_, i) => [x0, i * h, x1, (i + 1) * h]);
                if (side === 'colLeft') rects.push(tall, ...stack);
                else rects.push(...stack, tall);
                out.push({ template: side, a, p, rects, tallIndex });
            }
        }
    }
    return out;
}

/** Frame rect with half a gap trimmed on every inner edge, plus its final shape. */
function withGap(r, a, share) {
    const g = FRAME_GAP / 2;
    const x0 = r[0] > 1e-6 ? r[0] + g : r[0];
    const x1 = r[2] < 1 - 1e-6 ? r[2] - g : r[2];
    const y0 = r[1] > 1e-6 ? r[1] + g : r[1];
    const y1 = r[3] < a - 1e-6 ? r[3] - g : r[3];
    return { x0, y0, x1, y1, aspect: (x1 - x0) / (y1 - y0), share, touchesTop: r[1] <= 1e-6, touchesBottom: r[3] >= a - 1e-6 };
}

/**
 * Generation size for a frame of the given shape: about one megapixel for a big frame, a little
 * less for a small one (faster), multiples of 64, within sane bounds.
 * @param {number} aspect width / height
 * @param {number} share The frame's fraction of the panel area.
 */
export function frameGenerationSize(aspect, share = 0.5) {
    const pixels = (share >= 0.38 ? 1.0 : share >= 0.18 ? 0.82 : 0.68) * 1024 * 1024;
    const clampAspect = Math.min(2.5, Math.max(0.42, aspect));
    let width = Math.sqrt(pixels * clampAspect);
    let height = pixels / width;
    const snap = (v) => Math.min(1664, Math.max(512, Math.round(v / 64) * 64));
    width = snap(width);
    height = snap(height);
    return { width, height };
}
