// Lightweight, canvas-only image analysis used as a stand-in for real object/face detection.
// Produces a coarse "how visually busy is this region" grid - NOT face or person detection, just a
// cheap proxy (edge/variance density + a permissive skin-tone-ish color heuristic) good enough to
// steer bubble placement away from obviously occupied areas. Kept behind `computeOccupancyMap` /
// `sampleOccupancy` / `focalCentroid` so a real detector's output could replace the map's contents
// later without touching the placement engine in bubble-placement.js.

const GRID_COLS = 20;
const GRID_ROWS = 14;
const ANALYSIS_MAX_DIM = 160; // downsample target - keeps the pixel pass cheap regardless of source image size

/**
 * @typedef {{cols: number, rows: number, cells: Float32Array}} OccupancyMap
 */

/**
 * @param {HTMLImageElement} imgEl Already-loaded (`complete && naturalWidth > 0`) image element.
 * @returns {OccupancyMap | null} Null if analysis isn't possible for any reason - callers must
 *   treat that as "no signal" and fall back to hint-only placement, not as an error to surface.
 */
export function computeOccupancyMap(imgEl) {
    try {
        if (!imgEl || !imgEl.naturalWidth || !imgEl.naturalHeight) return null;

        const scale = ANALYSIS_MAX_DIM / Math.max(imgEl.naturalWidth, imgEl.naturalHeight);
        const sampleW = Math.max(1, Math.round(imgEl.naturalWidth * scale));
        const sampleH = Math.max(1, Math.round(imgEl.naturalHeight * scale));

        const canvas = document.createElement('canvas');
        canvas.width = sampleW;
        canvas.height = sampleH;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(imgEl, 0, 0, sampleW, sampleH);

        const { data } = ctx.getImageData(0, 0, sampleW, sampleH);

        const luminance = new Float32Array(sampleW * sampleH);
        const skin = new Uint8Array(sampleW * sampleH);
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            luminance[p] = 0.299 * r + 0.587 * g + 0.114 * b;
            skin[p] = isSkinish(r, g, b) ? 1 : 0;
        }

        const cells = new Float32Array(GRID_COLS * GRID_ROWS);
        const cellW = sampleW / GRID_COLS;
        const cellH = sampleH / GRID_ROWS;

        for (let cy = 0; cy < GRID_ROWS; cy++) {
            for (let cx = 0; cx < GRID_COLS; cx++) {
                const x0 = Math.floor(cx * cellW);
                const x1 = Math.max(x0 + 1, Math.floor((cx + 1) * cellW));
                const y0 = Math.floor(cy * cellH);
                const y1 = Math.max(y0 + 1, Math.floor((cy + 1) * cellH));

                let sum = 0, sumSq = 0, edgeSum = 0, skinSum = 0, n = 0;
                for (let y = y0; y < y1 && y < sampleH; y++) {
                    for (let x = x0; x < x1 && x < sampleW; x++) {
                        const p = y * sampleW + x;
                        const lum = luminance[p];
                        sum += lum;
                        sumSq += lum * lum;
                        skinSum += skin[p];
                        if (x + 1 < sampleW) edgeSum += Math.abs(lum - luminance[p + 1]);
                        if (y + 1 < sampleH) edgeSum += Math.abs(lum - luminance[p + sampleW]);
                        n++;
                    }
                }
                if (!n) continue;

                const mean = sum / n;
                const variance = Math.max(0, sumSq / n - mean * mean);
                const edgeDensity = edgeSum / n;
                const skinRatio = skinSum / n;

                // Weighted combination, constants tuned by eye rather than derived - this is a coarse
                // "busyness" proxy, not a calibrated detector.
                cells[cy * GRID_COLS + cx] = clamp01(edgeDensity / 40) * 0.5
                    + clamp01(Math.sqrt(variance) / 60) * 0.3
                    + skinRatio * 0.2;
            }
        }

        return { cols: GRID_COLS, rows: GRID_ROWS, cells };
    } catch (error) {
        console.warn('[Manga Mode] Bubble placement image analysis failed, falling back to hint-only placement:', error);
        return null;
    }
}

/**
 * Coarse, permissive RGB skin-tone heuristic - a proxy signal only, not a claim of detecting
 * actual skin or faces. Deliberately loose since manga/anime skin shading varies a lot.
 */
function isSkinish(r, g, b) {
    return r > 95 && g > 40 && b > 20 && r > g && r > b && (r - g) > 10 && (r - Math.min(g, b)) > 15;
}

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

/**
 * Average occupancy across a fractional rect (0..1 image-relative coordinates) of the map.
 * @param {OccupancyMap | null} map
 * @param {{x0: number, y0: number, x1: number, y1: number}} rect
 * @returns {number} 0 (no signal / empty) to 1 (fully busy).
 */
export function sampleOccupancy(map, rect) {
    if (!map) return 0;
    const { cols, rows, cells } = map;
    const cx0 = clampIndex(Math.floor(rect.x0 * cols), cols);
    const cx1 = clampIndex(Math.floor(Math.max(rect.x1 * cols - 1e-6, rect.x0 * cols)), cols);
    const cy0 = clampIndex(Math.floor(rect.y0 * rows), rows);
    const cy1 = clampIndex(Math.floor(Math.max(rect.y1 * rows - 1e-6, rect.y0 * rows)), rows);

    let sum = 0, n = 0;
    for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
            sum += cells[cy * cols + cx];
            n++;
        }
    }
    return n ? sum / n : 0;
}

/**
 * Occupancy-weighted centroid of the whole map, in fractional (0..1) coordinates - a rough proxy
 * for "where the visually important subject probably is," used only to aim bubble tails.
 * @param {OccupancyMap | null} map
 * @param {[number, number] | null} [xRange] Restrict to a horizontal band (fractions), e.g. the left
 *   part of the frame, to locate the figure on that side when several people speak in one panel.
 * @returns {{x: number, y: number} | null}
 */
export function focalCentroid(map, xRange = null) {
    if (!map) return null;
    const { cols, rows, cells } = map;
    const cxStart = xRange ? clampIndex(Math.floor(xRange[0] * cols), cols) : 0;
    const cxEnd = xRange ? clampIndex(Math.ceil(xRange[1] * cols) - 1, cols) : cols - 1;
    let sumW = 0, sumX = 0, sumY = 0;
    for (let cy = 0; cy < rows; cy++) {
        for (let cx = cxStart; cx <= cxEnd; cx++) {
            const w = cells[cy * cols + cx];
            sumW += w;
            sumX += w * (cx + 0.5) / cols;
            sumY += w * (cy + 0.5) / rows;
        }
    }
    if (sumW <= 0) return null;
    return { x: sumX / sumW, y: sumY / sumW };
}

function clampIndex(i, max) {
    return Math.max(0, Math.min(max - 1, i));
}

// Hue windows (degrees) for hair colours distinctive enough to find in a panel. Dark hair (black,
// brown) is left out on purpose: shadows and outlines match it everywhere.
const HAIR_HUES = {
    pink: { h: [[300, 360], [0, 8]], s: [0.18, 0.85], v: [0.55, 1] },
    red: { h: [[345, 360], [0, 14]], s: [0.5, 1], v: [0.3, 0.95] },
    orange: { h: [[12, 35]], s: [0.5, 1], v: [0.5, 1] },
    blonde: { h: [[36, 58]], s: [0.3, 0.9], v: [0.65, 1] },
    green: { h: [[75, 165]], s: [0.3, 1], v: [0.3, 1] },
    blue: { h: [[190, 250]], s: [0.35, 1], v: [0.3, 1] },
    purple: { h: [[255, 300]], s: [0.25, 1], v: [0.3, 1] },
};
const HAIR_WORDS = [
    [/\b(pink|rose|magenta)\b/, 'pink'],
    [/\b(red|crimson|scarlet|ruby)\b/, 'red'],
    [/\b(orange|auburn|copper|ginger)\b/, 'orange'],
    [/\b(blonde?|golden|gold|yellow)\b/, 'blonde'],
    [/\b(green|emerald|teal)\b/, 'green'],
    [/\b(blue|azure|cyan|navy)\b/, 'blue'],
    [/\b(purple|violet|lavender|lilac)\b/, 'purple'],
];

/**
 * The distinctive hair colour named in an appearance text ("long pink hair" -> "pink"), or null.
 * @param {string} text
 * @returns {string | null}
 */
export function hairColorOf(text) {
    const source = String(text || '').toLowerCase().replace(/_/g, ' ');
    for (const part of source.split(',')) {
        if (!/\bhair(?:ed)?\b/.test(part)) continue; // "red hair" and "red-haired"
        for (const [pattern, color] of HAIR_WORDS) {
            if (pattern.test(part)) return color;
        }
    }
    return null;
}

function toHsv(r, g, b) {
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const d = max - min;
    let h = 0;
    if (d > 0) {
        const rr = r / 255, gg = g / 255, bb = b / 255;
        if (max === rr) h = 60 * (((gg - bb) / d) % 6);
        else if (max === gg) h = 60 * ((bb - rr) / d + 2);
        else h = 60 * ((rr - gg) / d + 4);
    }
    if (h < 0) h += 360;
    return { h, s: max === 0 ? 0 : d / max, v: max };
}

/**
 * Where a hair colour sits in the image - used to find which figure is which, because the scene
 * parser's screen_position is a guess made before the image existed. Only the upper 80% of the
 * frame is searched (heads, not floors). Returns null when the colour is too rare to trust.
 * @param {HTMLImageElement} imgEl
 * @param {string} color One of the HAIR_HUES keys.
 * @returns {{x: number, y: number, share: number} | null} Image-fraction coordinates.
 */
export function locateColor(imgEl, color) {
    const spec = HAIR_HUES[color];
    if (!spec || !imgEl?.naturalWidth) return null;
    try {
        const scale = ANALYSIS_MAX_DIM / Math.max(imgEl.naturalWidth, imgEl.naturalHeight);
        const w = Math.max(1, Math.round(imgEl.naturalWidth * scale));
        const h = Math.max(1, Math.round(imgEl.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(imgEl, 0, 0, w, h);
        const rows = Math.round(h * 0.8);
        const { data } = ctx.getImageData(0, 0, w, rows);
        const points = [];
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
            const { h: hue, s, v } = toHsv(data[i], data[i + 1], data[i + 2]);
            if (s < spec.s[0] || s > spec.s[1] || v < spec.v[0] || v > spec.v[1]) continue;
            if (!spec.h.some(([a, b]) => hue >= a && hue <= b)) continue;
            points.push((p % w) / w, Math.floor(p / w) / h);
        }
        return locateHairBlob(points, w * rows);
    } catch {
        return null;
    }
}

// Anime skin as Anima draws it (a warm, mid-saturated tone). Sunlit sand and pale wood overlap a
// little, which is why only the highest dense clump counts as a face.
const SKIN_TONES = {
    light: { h: [4, 28], s: [0.25, 0.62], v: [0.5, 0.97] },
    // Very pale anime skin in bright light (Frieren: hue ~16, saturation ~0.15, value ~0.95) - the
    // light range missed it and the crop landed on the wooden desk instead. White clothes and paper
    // stay below 0.08 saturation.
    pale: { h: [8, 30], s: [0.08, 0.26], v: [0.82, 1] },
    tan: { h: [6, 30], s: [0.3, 0.7], v: [0.36, 0.86] },
    dark: { h: [2, 32], s: [0.28, 0.78], v: [0.16, 0.62] },
};

/**
 * Which skin range to look for, from a character's stated traits ("dark skin", "tanned", "pale").
 * Any card must work: a dark-skinned character was invisible to the light-skin range.
 */
export function skinToneOf(traits) {
    const t = String(traits || '').toLowerCase();
    if (/\b(dark|deep brown|ebony|black|mahogany|chocolate)[- ]?(skin|skinned|complexion)|\bdark-skinned\b/.test(t)) return 'dark';
    if (/\b(tan|tanned|olive|brown|bronze|caramel|light-brown|sun-kissed|dusky)[- ]?(skin|skinned|complexion)|\btanned\b/.test(t)) return 'tan';
    return 'light';
}

/** Skin ranges to search for a stated tone: light skin is looked for with the pale range too. */
export function skinRanges(tone) {
    return tone === 'light' ? ['light', 'pale'] : [tone];
}

/**
 * Rough face positions, highest first: dense clumps of skin-coloured pixels, each taken as the
 * highest clump left after the previous ones are removed. Works when hair colour does not (pale
 * blonde hair in sunlight is nearly white; yellow grass matches "blonde").
 * @returns {{x: number, y: number, share: number, spreadX: number, spreadY: number}[]}
 */
export function locateFaces(imgEl, max = 3, tones = ['light']) {
    const ranges = [...new Set((tones && tones.length ? tones : ['light']).flatMap(skinRanges))].map((t) => SKIN_TONES[t] || SKIN_TONES.light);
    if (!imgEl?.naturalWidth) return [];
    try {
        const scale = ANALYSIS_MAX_DIM / Math.max(imgEl.naturalWidth, imgEl.naturalHeight);
        const w = Math.max(1, Math.round(imgEl.naturalWidth * scale));
        const h = Math.max(1, Math.round(imgEl.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(imgEl, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);
        const points = [];
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
            const { h: hue, s, v } = toHsv(data[i], data[i + 1], data[i + 2]);
            if (!ranges.some((r) => hue >= r.h[0] && hue <= r.h[1] && s >= r.s[0] && s <= r.s[1] && v >= r.v[0] && v <= r.v[1])) continue;
            points.push((p % w) / w, Math.floor(p / w) / h);
        }
        return locateTopClumps(points, w * h, max);
    } catch {
        return [];
    }
}

/** The highest face only (see locateFaces), or null. */
export function locateFace(imgEl, tones) {
    return locateFaces(imgEl, 1, tones)[0] || null;
}

/**
 * Up to `max` compact clumps among the points, highest first (faces sit above arms and legs; a
 * clump whose window overlaps an earlier one is the same person's neck or shoulder). Pure.
 * @param {number[]} points Flat [x0, y0, ...] image fractions.
 * @param {number} total Pixels examined.
 */
export function locateTopClumps(points, total, max = 3) {
    const found = [];
    let rest = points;
    while (found.length < max) {
        const clump = locateTopClump(rest, total);
        if (!clump) break;
        found.push(clump);
        // Remove this person's face, neck and shoulders before looking again.
        const kept = [];
        for (let i = 0; i < rest.length; i += 2) {
            if (Math.abs(rest[i] - clump.x) < 0.13 && rest[i + 1] > clump.y - 0.12 && rest[i + 1] < clump.y + 0.3) continue;
            kept.push(rest[i], rest[i + 1]);
        }
        if (kept.length === rest.length) break;
        rest = kept;
    }
    // Later "faces" far below the first are hands, arms or legs, unless they are about as high.
    return found.filter((f, i) => i === 0 || f.y < found[0].y + 0.2);
}

/**
 * The highest compact clump among the points. Pure.
 * @param {number[]} points Flat [x0, y0, ...] image fractions.
 * @param {number} total Pixels examined.
 */
export function locateTopClump(points, total) {
    const n = points.length / 2;
    if (!total || n / total < 0.003) return null;
    const G = 20;
    const cellPixels = total / (G * G);
    const grid = new Float64Array(G * G);
    for (let i = 0; i < points.length; i += 2) {
        grid[Math.min(G - 1, Math.floor(points[i + 1] * G)) * G + Math.min(G - 1, Math.floor(points[i] * G))]++;
    }
    // A face-sized clump: its 3x3 neighbourhood is at least a third skin.
    let seed = null;
    for (let cy = 0; cy < G && !seed; cy++) {
        let bestSum = 0;
        for (let cx = 0; cx < G; cx++) {
            let sum = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const x = cx + dx, y = cy + dy;
                    if (x >= 0 && y >= 0 && x < G && y < G) sum += grid[y * G + x];
                }
            }
            if (sum > bestSum && sum >= cellPixels * 9 * 0.33) { bestSum = sum; seed = { x: (cx + 0.5) / G, y: (cy + 0.5) / G }; }
        }
    }
    if (!seed) return null;
    // Centre on the clump with a head-sized window.
    let bx = seed.x, by = seed.y + 0.03, stats = null;
    const R = 0.09;
    for (let iter = 0; iter < 3; iter++) {
        let m = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
        for (let i = 0; i < points.length; i += 2) {
            const fx = points[i], fy = points[i + 1];
            if (Math.abs(fx - bx) > R || Math.abs(fy - by) > R) continue;
            m++; sx += fx; sy += fy; sxx += fx * fx; syy += fy * fy;
        }
        if (!m) break;
        bx = sx / m; by = sy / m;
        stats = { m, spreadX: Math.sqrt(Math.max(0, sxx / m - bx * bx)), spreadY: Math.sqrt(Math.max(0, syy / m - by * by)) };
    }
    if (!stats || stats.m / total < 0.002) return null;
    return { x: bx, y: by, share: stats.m / total, spreadX: stats.spreadX, spreadY: stats.spreadY, ...faceExtent(points, bx, by) };
}

/**
 * Vertical extent of the face around (x, y): skin rows in a narrow column, walking up and down
 * from the centre until a row is much narrower than the face (the chin/neck below, the hairline
 * above). A size measure that does not saturate like the window spread does. Pure.
 */
function faceExtent(points, x, y) {
    const BINS = 100;
    const rows = new Float64Array(BINS);
    for (let i = 0; i < points.length; i += 2) {
        if (Math.abs(points[i] - x) > 0.08 || Math.abs(points[i + 1] - y) > 0.25) continue;
        rows[Math.min(BINS - 1, Math.max(0, Math.floor(points[i + 1] * BINS)))]++;
    }
    const c = Math.min(BINS - 1, Math.max(0, Math.floor(y * BINS)));
    let peak = 0;
    for (let r = Math.max(0, c - 5); r <= Math.min(BINS - 1, c + 5); r++) peak = Math.max(peak, rows[r]);
    if (!peak) return { top: y, bottom: y, faceH: 0 };
    const smooth = (r) => (rows[r] + (rows[r - 1] ?? rows[r]) + (rows[r + 1] ?? rows[r])) / 3;
    let top = c, bottom = c;
    while (top > 0 && smooth(top - 1) >= peak * 0.5) top--;
    while (bottom < BINS - 1 && smooth(bottom + 1) >= peak * 0.5) bottom++;
    return { top: top / BINS, bottom: (bottom + 1) / BINS, faceH: (bottom + 1 - top) / BINS };
}

/**
 * The head among matching pixels: the densest compact clump (preferring the upper part of the
 * picture), not the centroid of every match - yellow grass or sunlit sand also matches "blonde",
 * and a centroid across hair + grass lands on neither (a close-up crop came out as a headless torso).
 * Pure so it can be unit tested.
 * @param {number[]} points Flat [x0, y0, x1, y1, ...] image fractions of the matching pixels.
 * @param {number} total Pixels examined.
 */
export function locateHairBlob(points, total) {
    const n = points.length / 2;
    const share = total ? n / total : 0;
    if (share < 0.006) return null;
    const G = 16;
    const grid = new Float64Array(G * G);
    for (let i = 0; i < points.length; i += 2) {
        const cx = Math.min(G - 1, Math.floor(points[i] * G));
        const cy = Math.min(G - 1, Math.floor(points[i + 1] * G));
        grid[cy * G + cx]++;
    }
    let best = -1, bx = 0.5, by = 0.3;
    for (let cy = 0; cy < G; cy++) {
        for (let cx = 0; cx < G; cx++) {
            let sum = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const x = cx + dx, y = cy + dy;
                    if (x >= 0 && y >= 0 && x < G && y < G) sum += grid[y * G + x];
                }
            }
            // Heads sit high in the picture; ground and grass sit low.
            const fy = (cy + 0.5) / G;
            const score = sum * (1.2 - fy);
            if (score > best) { best = score; bx = (cx + 0.5) / G; by = fy; }
        }
    }
    // Mean-shift the window onto the clump, then measure it.
    const RX = 0.15, RY = 0.2;
    let stats = null;
    for (let iter = 0; iter < 3; iter++) {
        let m = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
        for (let i = 0; i < points.length; i += 2) {
            const fx = points[i], fy = points[i + 1];
            if (Math.abs(fx - bx) > RX || Math.abs(fy - by) > RY) continue;
            m++; sx += fx; sy += fy; sxx += fx * fx; syy += fy * fy;
        }
        if (!m) break;
        bx = sx / m; by = sy / m;
        stats = {
            m,
            spreadX: Math.sqrt(Math.max(0, sxx / m - bx * bx)),
            spreadY: Math.sqrt(Math.max(0, syy / m - by * by)),
        };
    }
    if (!stats || stats.m / total < 0.004) return null;
    // Share of all matches outside the clump: a second clump of the same colour far away is a
    // second head (a duplicate) or scenery.
    return { x: bx, y: by, share, spreadX: stats.spreadX, spreadY: stats.spreadY, clumpShare: stats.m / n };
}
