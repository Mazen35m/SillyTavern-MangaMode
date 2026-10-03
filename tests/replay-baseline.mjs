// Run: MM_REPLAY_DIR=<folder with r01.json.. and fullchat.json> node tests/replay-baseline.mjs [--write snapshot.json] [--check snapshot.json]
//
// 1. Faithfulness: every ComfyUI request recorded from the real run (positive prompt, negative prompt,
//    sampler, steps, CFG, size, model files - seed aside) must be rebuilt EXACTLY by
//    the code, otherwise the replay is not a trustworthy stand-in for the real thing.
// 2. --write: saves the rebuilt graphs of every reply as a snapshot (outside the repo).
// 3. --check: rebuilds them again with the CURRENT code and compares with a snapshot written before a refactor.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { loadRecording, replayReply, recordedJob, essentials } from './replay-lib.mjs';

const dir = process.env.MM_REPLAY_DIR;
if (!dir || !fs.existsSync(dir)) {
    console.log('replay-baseline: MM_REPLAY_DIR not set (the recordings are private, kept on the owner\'s computer) - skipped.');
    process.exit(0);
}
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

const rec = loadRecording(dir);
const positiveOf = (graph) => {
    const ks = Object.values(graph).find((n) => n.class_type === 'KSampler');
    const id = ks.inputs.positive[0];
    return graph[id].inputs.text;
};

const snapshot = {};
let matched = 0;
let total = 0;
const misses = [];
for (const reply of rec.replies) {
    const jobs = replayReply(rec, reply);
    snapshot[reply.tag] = jobs.map((j) => ({ key: j.key, graph: j.graph }));
    // Faithfulness: match each recorded request to a rebuilt job by its positive text.
    const pool = [...jobs];
    for (const request of reply.requests) {
        const recorded = recordedJob(request);
        // Refinement / reference passes are not rebuilt here (not part of the prompt path).
        const hasSampler = Object.values(recorded.graph).some((n) => n.class_type === 'KSampler');
        if (!hasSampler) continue;
        total++;
        const text = positiveOf(recorded.graph);
        const i = pool.findIndex((j) => positiveOf(j.graph) === text);
        if (i < 0) { misses.push({ tag: reply.tag, why: 'no rebuilt job has the recorded positive text', text: text.slice(0, 160) }); continue; }
        const [job] = pool.splice(i, 1);
        try {
            // The recorded run may have used the user's own saved workflow (different node numbers): compare what it asks for.
            assert.deepEqual(essentials(job.graph), essentials(recorded.graph));
            matched++;
        } catch (error) {
            misses.push({ tag: reply.tag, why: 'graph differs', detail: String(error.message).slice(0, 400) });
        }
    }
}
console.log(`replay: ${matched}/${total} recorded ComfyUI requests rebuilt exactly (positive + negative prompt, sampler, steps, CFG, size, model files)`);
for (const m of misses.slice(0, 8)) console.log(' miss:', JSON.stringify(m));

const out = flag('--write');
if (out) { fs.writeFileSync(out, JSON.stringify(snapshot)); console.log(`snapshot written: ${out}`); }
const check = flag('--check');
if (check) {
    const before = JSON.parse(fs.readFileSync(check, 'utf8'));
    assert.deepEqual(snapshot, before);
    console.log('snapshot check: identical to the snapshot taken before the refactor');
}
if (misses.length && !check) process.exitCode = 1;
