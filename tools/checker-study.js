// Checker study helpers. Load in the SillyTavern tab (never refresh the page afterwards):
//   await import('/scripts/extensions/third-party/SillyTavern-MangaMode/tools/checker-study.js?v=' + Date.now());
// Needs settings.debug = true while the replies are drawn (the checker's input and answer are then stored with every attempt).
//
//   const items = __studyItems();                    // every checked picture of the open chat
//   __studySheet(items, 0, 6);                       // contact sheet of 6 pictures with captions (look at it, then label)
//   __studyRun(items, ['openai/gpt-6-luna', 'google/gemini-3.1-flash-lite'], 2);   // runs the real checker (background)
//   __studyEval(items, { 0: 'good', 1: 'fault', ... });   // false redraws / false passes per model and per policy
//
// Costs about $0.002-0.004 per check call.
const BASE = '/scripts/extensions/third-party/SillyTavern-MangaMode/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reasons that are about taste or about the checker's reading of the action, not about a defect of the picture.
const SOFT = /not doing what was described|action is not clearly shown|does not look at|partly blank background|prominent lettering|differs in a small detail/i;
export const isSoft = (reason) => SOFT.test(String(reason));

window.__studyItems = () => {
    const chat = SillyTavern.getContext().chat;
    const items = []; const seen = new Set();
    chat.forEach((m, mi) => (m.extra?.manga?.panels || []).forEach((p, pi) => (p.quality?.history || []).forEach((a, ai) => {
        if (!a.url || !a.expectation || seen.has(a.url)) return;
        seen.add(a.url);
        items.push({ i: items.length, mi, pi, ai, url: a.url, expectation: a.expectation, pass: a.pass, reasons: a.reasons || [], looks: a.looks, answer: a.answer });
    })));
    return items;
};

window.__studySheet = (items, from = 0, count = 6) => {
    document.getElementById('__sheet')?.remove();
    const d = document.createElement('div'); d.id = '__sheet';
    d.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;background:#111;color:#eee;display:grid;grid-template-columns:1fr 1fr;gap:2px;overflow:auto;align-content:start;font:9px sans-serif';
    for (const it of items.slice(from, from + count)) {
        const w = document.createElement('div'); w.style.cssText = 'position:relative';
        const im = document.createElement('img'); im.src = it.url; im.style.cssText = 'width:100%;display:block';
        const n = document.createElement('div'); n.textContent = it.i; n.style.cssText = 'position:absolute;top:2px;left:4px;color:#ff0;font:bold 18px sans-serif;text-shadow:0 0 3px #000';
        const cap = document.createElement('div');
        const doing = String(it.expectation.text || '').split('\n').filter((l) => /^- "|^Frame kind|^Key moment/.test(l)).map((l) => l.replace(/^- /, '').slice(0, 170)).join(' | ');
        cap.textContent = `${it.pass ? 'PASS' : 'FAIL'} ${it.reasons.map((r) => String(r).slice(0, 60)).join(' ; ')}  ::  ${doing}`;
        cap.style.cssText = 'padding:2px;max-height:9em;overflow:hidden';
        w.append(im, n, cap); d.append(w);
    }
    document.body.append(d);
    return `sheet ${from}-${from + count - 1}`;
};

window.__studyRes = window.__studyRes || {};
window.__studyRun = async (items, models, runs = 2, concurrency = 4, variant = null) => {
    const vc = await import(BASE + 'vision-check.js?study=2');
    const context = SillyTavern.getContext();
    const base = context.extensionSettings.mangaMode;
    const jobs = [];
    const tag = variant?.tag ? `#${variant.tag}` : '';
    for (const it of items) for (const m of models) for (let r = 0; r < runs; r++) if (!window.__studyRes[`${it.i}|${m}${tag}|${r}`]) jobs.push({ it, m, r });
    window.__studyState = { total: jobs.length, done: 0, errors: 0, cost: 0 };
    let next = 0;
    const worker = async () => {
        while (next < jobs.length) {
            const { it, m, r } = jobs[next++];
            try {
                const res = await vc.checkFrame(context, { ...base, visionModel: m }, it.url, it.expectation, variant?.system ? { system: variant.system(vc.FRAME_CHECK_SYSTEM) } : {});
                window.__studyRes[`${it.i}|${m}${tag}|${r}`] = { pass: res.pass, major: res.major, reasons: res.reasons, answer: res.answer };
                window.__studyState.cost += Number(res.usage?.cost || 0);
            } catch (e) { window.__studyState.errors++; window.__studyRes[`${it.i}|${m}${tag}|${r}`] = { error: String(e.message || e).slice(0, 100) }; }
            window.__studyState.done++;
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    window.__studyState.finished = true;
    return window.__studyState;
};

// A policy gets the runs of ONE model on ONE picture (run 0, run 1, ...) and says "redraw this picture".
const hardOnly = (res) => ({ ...res, reasons: res.reasons.filter((r) => !isSoft(r)), pass: !res.reasons.some((r) => !isSoft(r)) });
const POLICIES = (vc) => ({
    // what 1.14 does: one look, any reason redraws
    'one look, any reason': (runs) => !runs[0].pass,
    // what 1.14 does with confirmChecks on: a second look must agree on a reason
    'two looks (1.14)': (runs) => runs.length < 2 ? !runs[0].pass : !vc.confirmVerdict(runs[0], runs[1]).pass,
    'one look, hard reasons only': (runs) => !hardOnly(runs[0]).pass,
    'two looks, hard reasons only': (runs) => runs.length < 2 ? !hardOnly(runs[0]).pass : !vc.confirmVerdict(hardOnly(runs[0]), hardOnly(runs[1])).pass,
    'both looks fail (any reason)': (runs) => runs.every((r) => !r.pass),
    'both looks fail (hard only)': (runs) => runs.every((r) => !hardOnly(r).pass),
});

/**
 * labels: { [item index]: 'good' | 'fault' } (decided by eye). Returns, per model and policy:
 * falseRedraw = good pictures that would be redrawn / all good, falsePass = faulty pictures that would pass / all faulty.
 */
window.__studyEval = async (items, labels) => {
    const vc = await import(BASE + 'vision-check.js?study=2');
    const pols = POLICIES(vc);
    const out = {};
    const models = [...new Set(Object.keys(window.__studyRes).map((k) => k.split('|')[1]))];
    for (const m of models) for (const [pname, pol] of Object.entries(pols)) {
        let good = 0; let goodRedraw = 0; let bad = 0; let badPass = 0;
        for (const it of items) {
            const lab = labels[it.i]; if (lab !== 'good' && lab !== 'fault') continue;
            const runs = Object.entries(window.__studyRes).filter(([k, v]) => k.startsWith(`${it.i}|${m}|`) && !v.error).sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
            if (!runs.length) continue;
            const redraw = pol(runs);
            if (lab === 'good') { good++; goodRedraw += redraw ? 1 : 0; } else { bad++; badPass += redraw ? 0 : 1; }
        }
        out[`${m.split('/')[1] || m} | ${pname}`] = `falseRedraw ${goodRedraw}/${good} (${good ? Math.round(100 * goodRedraw / good) : '-'}%)  falsePass ${badPass}/${bad} (${bad ? Math.round(100 * badPass / bad) : '-'}%)`;
    }
    return out;
};
