// Run: node tests/repo-hygiene.test.mjs - the repository must never carry a user's chat data, test pictures, keys or test recordings.
// It scans every file under the extension folder (except node_modules / .git). It cannot know what a person will `git add`,
// but it fails loudly if such a file is sitting in the folder that gets uploaded, and .gitignore lists the same patterns.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p); else files.push(p);
    }
})(root);

const rel = (p) => path.relative(root, p).replace(/\\/g, '/');
const ALLOWED_JSON = /^(manifest\.json|recommended-settings\.json|comfyui-bridge\/.*\.json|workflows\/.*\.json)$/;
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

test('no pictures, recordings or request dumps in the extension folder', () => {
    for (const f of files.map(rel)) {
        assert.doesNotMatch(f, /\.(png|jpe?g|webp|gif)$/i, `${f}: a picture in the repository folder`);
        assert.doesNotMatch(f, /(^|\/)(fullchat|snapshot-[^/]*|requests[^/]*|r\d\d)\.json$/, `${f}: a test recording in the repository folder`);
        if (f.endsWith('.json')) assert.match(f, ALLOWED_JSON, `${f}: an unexpected JSON file (chat data?)`);
    }
});

test('no chat messages, keys or tokens inside any text file', () => {
    for (const f of files) {
        if (!/\.(js|mjs|json|md|html|css|txt)$/i.test(f)) continue;
        const text = fs.readFileSync(f, 'utf8');
        assert.doesNotMatch(text, /"mes"\s*:\s*"/, `${rel(f)}: looks like a chat message`);
        assert.doesNotMatch(text, /sk-or-v1-[A-Za-z0-9]{10,}|sk-ant-[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{30,}/, `${rel(f)}: looks like an API key`);
        assert.doesNotMatch(text, /"extra"\s*:\s*\{\s*"manga"/, `${rel(f)}: looks like a saved storyboard`);
    }
});

test('.gitignore lists the recording and picture patterns', () => {
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    for (const pattern of ['fullchat.json', 'snapshot-*.json', 'requests*.json', 'manga_*.png']) assert.ok(ignore.includes(pattern), `${pattern} in .gitignore`);
});

console.log(`${n} tests passed`);
