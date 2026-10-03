// Candidate-region bubble placement engine. Pure geometry/scoring - no DOM access - so the same
// code works whether the occupancy signal comes from the cheap canvas heuristic in
// image-analysis.js or, later, a real detector's boxes converted into the same map shape.
//
// Coordinates here are fractions of the STRIP (the artwork plus its white gutter bands), not of
// the artwork alone. `imageRect` says where the art sits inside that strip; everything outside it
// is gutter, which a balloon may legitimately sit in or straddle. That's the whole point: when the
// frame has no clean space left, manhwa moves the balloon out of the panel rather than parking it
// on someone's face.

import { sampleOccupancy, focalCentroid } from './image-analysis.js';
import { sameName } from './cast-book.js';

// Fractional (0..1) x-position each screen_position hint roughly corresponds to, used only as a
// tie-breaker between otherwise-similar candidates - never as a forced destination.
const HINT_X = { left: 0.06, center: 0.5, right: 0.94 };

const ANCHOR_X_FRACTIONS = [0.02, 0.2, 0.5, 0.8, 0.98];
const ANCHOR_Y_FRACTIONS = [0.01, 0.1, 0.22, 0.34, 0.46, 0.58, 0.7, 0.82, 0.93];
const EDGE_MARGIN_FRAC = 0.015;

const WEIGHT_OCCUPANCY = 100;
const WEIGHT_RESERVED_OVERLAP = 90;
const WEIGHT_FOCAL_PROXIMITY = 12;
const WEIGHT_EDGE_MARGIN = 80;
const WEIGHT_DETACHED = 6;
const WEIGHT_HINT = 3;
// Nudge consecutive balloons to alternate sides rather than stacking in one column, which is what
// gives a real manhwa panel its zig-zag reading path.
const WEIGHT_SAME_SIDE = 5;
// Covering a face is the worst placement there is (a balloon sat on the player's head, 08h52 #2).
// Scaled by how much of the head zone the balloon covers.
const WEIGHT_FACE = 140;
// A candidate that would cover more than this share of any head zone is only used when nothing else fits.
const MAX_FACE_COVER = 0.25;

// Groups may not overlap each other at all (beyond a rounding allowance) as long as ANY
// non-overlapping slot exists - a hard constraint rather than a weighted preference, because
// overlapping balloons are never acceptable while a slightly worse position always is.
const MAX_OVERLAP_FRAC = 0.02;

// Each successive group must start lower than the one before it, so vertical order always matches
// speech order and the reader never has to guess which balloon comes first.
const READING_ORDER_STEP = 0.02;
// Breathing room left between stacked groups when reserving space for the ones still to come.
const READING_ORDER_GAP = 0.01;

/**
 * @typedef {object} BubbleGroupInput
 * @property {string} id
 * @property {number} width Rendered pixel width of the stacked bubble group.
 * @property {number} height Rendered pixel height of the stacked bubble group.
 * @property {'left'|'center'|'right'|null} hintSide Speaker's scene screen_position, or null if unmatched/unknown.
 */

/**
 * @typedef {object} BubblePlacement
 * @property {number} left Px offset from the strip's left edge.
 * @property {number} top Px offset from the strip's top edge.
 * @property {'start'|'center'|'end'} align How bubbles should be justified within the group's own box.
 * @property {'left'|'center'|'right'} tailSide Direction the tail should point.
 * @property {boolean} tailUp True when the group sits in the gutter below the art, so its tail has to point back up.
 */

/**
 * Places bubble groups across the strip, preferring genuine negative space - which now includes
 * the gutters - over any fixed corner. `screen_position` hints only ever contribute a small
 * tie-breaking bonus (`WEIGHT_HINT` vs. `WEIGHT_OCCUPANCY`).
 * @param {object} params
 * @param {number} params.stripWidth Rendered strip width in px (artwork + gutters).
 * @param {number} params.stripHeight Rendered strip height in px.
 * @param {{x0: number, y0: number, x1: number, y1: number}} params.imageRect Where the art sits within the strip, in strip fractions.
 * @param {BubbleGroupInput[]} params.groups In speech order - placement keeps them in that order top-to-bottom.
 * @param {import('./image-analysis.js').OccupancyMap | null} params.occupancyMap Null if analysis failed/unavailable - candidates then fall back to hint + margin scoring only.
 * @returns {Map<string, BubblePlacement>}
 */
export function placeBubbleGroups({ stripWidth, stripHeight, imageRect, groups, occupancyMap, avoid = [] }) {
    const results = new Map();
    if (!stripWidth || !stripHeight || !Array.isArray(groups) || !groups.length) return results;

    const art = imageRect || { x0: 0, y0: 0, x1: 1, y1: 1 };
    // Head zones arrive in image fractions; placement works in strip fractions.
    const faces = (avoid || []).map((z) => ({
        x0: art.x0 + Math.max(0, z.x0) * (art.x1 - art.x0),
        x1: art.x0 + Math.min(1, z.x1) * (art.x1 - art.x0),
        y0: art.y0 + Math.max(0, z.y0) * (art.y1 - art.y0),
        y1: art.y0 + Math.min(1, z.y1) * (art.y1 - art.y0),
    })).filter((z) => z.x1 > z.x0 && z.y1 > z.y0);
    const focal = toStripPoint(focalCentroid(occupancyMap), art);
    // With several speakers, one global centroid sits between them and every tail would point at
    // empty middle ground. Each speaker's tail then aims at the busiest area on their side of the
    // frame - found in the image, with screen_position only choosing which side to look at.
    const distinctSides = new Set(groups.map((g) => g.hintSide).filter(Boolean));
    const sideFocal = distinctSides.size > 1 ? {
        left: toStripPoint(focalCentroid(occupancyMap, [0, 0.55]), art),
        center: focal,
        right: toStripPoint(focalCentroid(occupancyMap, [0.45, 1]), art),
    } : null;
    const reserved = [];
    let minY0 = 0;
    let prevY0 = 0;
    let prevXAnchor = null;

    // Sizes are needed up front: each group has to leave enough room BELOW it for every group that
    // still has to be placed, otherwise the first balloon happily takes the lowest empty slot and
    // the ordering constraint becomes unsatisfiable for everything after it.
    const sized = groups
        .filter((g) => g.width && g.height)
        .map((g) => ({
            group: g,
            wFrac: Math.min(1 - EDGE_MARGIN_FRAC * 2, g.width / stripWidth),
            hFrac: Math.min(1 - EDGE_MARGIN_FRAC * 2, g.height / stripHeight),
        }));

    for (let i = 0; i < sized.length; i++) {
        const { group, wFrac, hFrac } = sized[i];

        let reservedBelow = 0;
        for (let j = i + 1; j < sized.length; j++) reservedBelow += sized[j].hFrac + READING_ORDER_GAP;
        const maxY1 = 1 - reservedBelow;

        const context = { occupancyMap, art, focal, reserved, hintSide: group.hintSide, prevXAnchor, faces };

        // Honour the hard constraints first; only if nothing at all fits do we fall back to pure
        // scoring, since a compromised position still beats dropping the balloon entirely.
        // Then give up the rules one at a time, least important first: strict top-to-bottom order
        // (side by side still reads fine), then a face, then any order, and only last may two
        // balloons stack (three lines in a small frame all landed on one spot, 08h52 #10; a
        // close-up's face was covered to keep the order, #14).
        let best = search(wFrac, hFrac, context, { minY0, maxY1, order: true, faces: true, overlap: true })
            // Loose order: beside the previous balloon is fine, above it is not ("and cheap wire?"
            // landed above the question it ends, 08h52 #16).
            || search(wFrac, hFrac, context, { minY0: Math.max(0, prevY0 - 0.02), maxY1: 1, order: true, faces: true, overlap: true })
            || search(wFrac, hFrac, context, { minY0, maxY1, order: true, faces: false, overlap: true })
            || search(wFrac, hFrac, context, { minY0: 0, maxY1: 1, order: false, faces: false, overlap: true })
            || search(wFrac, hFrac, context, { minY0: 0, maxY1: 1, order: false, faces: false, overlap: false });
        if (!best) continue;

        reserved.push(best.rect);
        prevY0 = best.rect.y0;
        minY0 = best.rect.y0 + READING_ORDER_STEP;
        prevXAnchor = best.xAnchor;

        const target = (group.target && toStripPoint(group.target, art))
            || (sideFocal && group.hintSide && sideFocal[group.hintSide])
            || focal;
        // How much busy artwork the chosen spot covers (0 = clean or gutter, 1 = fully busy).
        const onArt = intersectionFraction(best.rect, art);
        const artRect = onArt > 0 ? toArtRect(best.rect, art) : null;
        const coverage = artRect ? sampleOccupancy(occupancyMap, artRect) * onArt : 0;
        results.set(group.id, {
            coverage,
            left: best.rect.x0 * stripWidth,
            top: best.rect.y0 * stripHeight,
            align: best.xAnchor <= 0.1 ? 'start' : best.xAnchor >= 0.9 ? 'end' : 'center',
            tailSide: resolveTailSide(best.rect, target, group.hintSide),
            tailUp: resolveTailUp(best.rect, target, art),
        });
    }

    return results;
}

function search(wFrac, hFrac, context, { minY0, maxY1, order = true, faces = true, overlap = true }) {
    let best = null;
    for (const xAnchor of ANCHOR_X_FRACTIONS) {
        for (const yAnchor of ANCHOR_Y_FRACTIONS) {
            const rect = anchorToRect(xAnchor, yAnchor, wFrac, hFrac);

            if (order && (rect.y0 < minY0 - 1e-6 || rect.y1 > maxY1 + 1e-6)) continue;
            if (overlap && context.reserved.some((r) => intersectionFraction(rect, r) > MAX_OVERLAP_FRAC)) continue;
            if (faces && (context.faces || []).some((z) => intersectionFraction(z, rect) > MAX_FACE_COVER)) continue;

            // With nothing left enforced, stacked balloons still score far worse than any art.
            const stacked = overlap ? 0 : context.reserved.reduce((sum, r) => sum + intersectionFraction(rect, r), 0) * 1000;
            const score = scoreCandidate(rect, { ...context, xAnchor }) + stacked;
            if (!best || score < best.score) best = { score, rect, xAnchor };
        }
    }
    return best;
}

function anchorToRect(xAnchor, yAnchor, wFrac, hFrac) {
    let x0;
    if (xAnchor <= 0.1) x0 = xAnchor;
    else if (xAnchor >= 0.9) x0 = xAnchor - wFrac;
    else x0 = xAnchor - wFrac / 2;

    x0 = clamp(x0, EDGE_MARGIN_FRAC, Math.max(EDGE_MARGIN_FRAC, 1 - EDGE_MARGIN_FRAC - wFrac));
    const y0 = clamp(yAnchor, EDGE_MARGIN_FRAC, Math.max(EDGE_MARGIN_FRAC, 1 - EDGE_MARGIN_FRAC - hFrac));

    return { x0, y0, x1: x0 + wFrac, y1: y0 + hFrac };
}

function scoreCandidate(rect, { occupancyMap, art, focal, reserved, hintSide, xAnchor, prevXAnchor, faces = [] }) {
    let score = 0;
    for (const zone of faces) score += intersectionFraction(zone, rect) * WEIGHT_FACE;

    // Occupancy only means anything where the balloon actually covers artwork; whatever hangs over
    // a gutter is free by definition, so the cost scales with how much of it sits on the art.
    const onArt = intersectionFraction(rect, art);
    if (onArt > 0) {
        const artRect = toArtRect(rect, art);
        if (artRect) score += sampleOccupancy(occupancyMap, artRect) * WEIGHT_OCCUPANCY * onArt;
    } else {
        // Entirely in a gutter: allowed, and common in real manhwa - just not the first choice.
        score += WEIGHT_DETACHED;
    }

    for (const other of reserved) {
        score += intersectionFraction(rect, other) * WEIGHT_RESERVED_OVERLAP;
    }

    if (focal) {
        const cx = (rect.x0 + rect.x1) / 2;
        const cy = (rect.y0 + rect.y1) / 2;
        const dist = Math.hypot(cx - focal.x, cy - focal.y);
        score += Math.max(0, 1 - dist) * WEIGHT_FOCAL_PROXIMITY;
    }

    const smallestMargin = Math.min(rect.x0, rect.y0, 1 - rect.x1, 1 - rect.y1);
    score += Math.max(0, EDGE_MARGIN_FRAC - smallestMargin) * WEIGHT_EDGE_MARGIN;

    if (hintSide && HINT_X[hintSide] !== undefined && Math.abs(xAnchor - HINT_X[hintSide]) > 0.15) {
        score += WEIGHT_HINT;
    }

    if (prevXAnchor !== null && prevXAnchor !== undefined && Math.abs(xAnchor - prevXAnchor) < 0.2) {
        score += WEIGHT_SAME_SIDE;
    }

    return score;
}

/** Strip-space rect -> art-space rect (clipped), or null when it misses the art entirely. */
function toArtRect(rect, art) {
    const w = art.x1 - art.x0;
    const h = art.y1 - art.y0;
    if (w <= 0 || h <= 0) return null;

    const x0 = clamp((rect.x0 - art.x0) / w, 0, 1);
    const x1 = clamp((rect.x1 - art.x0) / w, 0, 1);
    const y0 = clamp((rect.y0 - art.y0) / h, 0, 1);
    const y1 = clamp((rect.y1 - art.y0) / h, 0, 1);

    return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/** Fraction of `rect`'s own area that lies inside `other`. */
function intersectionFraction(rect, other) {
    const ix = Math.max(0, Math.min(rect.x1, other.x1) - Math.max(rect.x0, other.x0));
    const iy = Math.max(0, Math.min(rect.y1, other.y1) - Math.max(rect.y0, other.y0));
    const area = Math.max(1e-6, (rect.x1 - rect.x0) * (rect.y1 - rect.y0));
    return (ix * iy) / area;
}

/** Art-space point (as image-analysis reports it) -> strip space. */
function toStripPoint(point, art) {
    if (!point) return null;
    return {
        x: art.x0 + point.x * (art.x1 - art.x0),
        y: art.y0 + point.y * (art.y1 - art.y0),
    };
}

/**
 * Tail points from the bubble toward whichever is available: the analyzed focal point (the
 * probable subject), or failing that, the speaker's screen_position hint as a weak fallback.
 */
function resolveTailSide(rect, focal, hintSide) {
    const cx = (rect.x0 + rect.x1) / 2;
    const targetX = focal ? focal.x : (hintSide && HINT_X[hintSide] !== undefined ? HINT_X[hintSide] : 0.5);

    const dx = targetX - cx;
    if (Math.abs(dx) < 0.08) return 'center';
    return dx < 0 ? 'left' : 'right';
}

/**
 * The tail points back up whenever the speaker is above the balloon: a balloon in the gutter below
 * the art, or one whose centre sits clearly below the subject's focal point inside the art.
 */
export function resolveTailUp(rect, target, art) {
    if (rect.y0 >= art.y1) return true;
    if (!target) return false;
    const cy = (rect.y0 + rect.y1) / 2;
    return cy > target.y + TAIL_UP_MARGIN;
}

const TAIL_UP_MARGIN = 0.05;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * Final gutter sizes after a gutter expansion: a side that ended up without a balloon goes back to
 * its base size, and balloons move up by however much the top gutter shrank.
 */
export function trimGutters({ usesTop, usesBottom, grow, baseTop, baseBottom }) {
    const top = usesTop ? baseTop + grow : baseTop;
    const bottom = usesBottom ? baseBottom + grow : baseBottom;
    return { top, bottom, shiftY: usesTop ? 0 : -grow };
}

const ZONE_Y = { 'extreme close-up': 0.42, 'close-up': 0.36, 'medium shot': 0.22, 'full shot': 0.15, 'wide shot': 0.3 };
const ZONE_SIZE = { 'extreme close-up': [0.9, 0.75], 'close-up': [0.55, 0.5], 'medium shot': [0.3, 0.26], 'full shot': [0.2, 0.16], 'wide shot': [0.12, 0.1] };
const SIDE_X = { left: 0.28, center: 0.5, right: 0.72 };

/** The located head of a person, by exact name or by another form of it ("Roland" / "Guard Roland"). Pure. */
export function locatedFor(located, name) {
    if (!name || !located) return null;
    const key = String(name).toLowerCase();
    if (located.has(key)) return located.get(key);
    for (const [k, v] of located) if (sameName(k, name)) return v;
    return null;
}

/**
 * Where the visible people's heads probably are, in image fractions: the located hair point when
 * the image analysis found one, else the side they stand on and the usual head height for the
 * shot. Not face detection - a zone to keep balloons off. With two people on opposite sides both
 * zones are kept, so a mirrored screen_position still protects both faces.
 * @param {Array<{name: string, screen_position?: string}>} people
 * @param {Map<string, {x: number, y: number, spreadY?: number}>} located lower-cased name -> point
 * @param {string} shot
 */
export function headZones(people, located, shot) {
    const [w, h] = ZONE_SIZE[shot] || [0.28, 0.24];
    const n = people.length;
    return people.map((person, i) => {
        const point = locatedFor(located, person?.name);
        const x = point ? point.x : (SIDE_X[person?.screen_position] ?? (n === 1 ? 0.5 : (i + 0.5) / n));
        const y = point ? Math.min(0.9, point.y + (point.spreadY ? point.spreadY : 0.04)) : (ZONE_Y[shot] ?? 0.22);
        const zw = point?.spreadY ? Math.max(w * 0.6, Math.min(0.9, point.spreadY * 5)) : w;
        const zh = point?.spreadY ? Math.max(h * 0.6, Math.min(0.8, point.spreadY * 4.5)) : h;
        return { x0: x - zw / 2, x1: x + zw / 2, y0: y - zh / 2, y1: y + zh / 2 };
    });
}
