# Testing

## Node suites (no SillyTavern, no LLM, no ComfyUI)

```
node tests/unit.test.mjs
node tests/adapters.test.mjs        # adapters, looks, equivalence with 1.0.x wording
node tests/direct-path.test.mjs     # the Direct planner: schema, checks, assembly, retry, scene, sentence repair
node tests/moment-cards.test.mjs    # the superseded card experiment (still used to redraw older pages)
```
The other suites in `tests/` run the same way.

## Replay equivalence (proves a refactor did not change what is sent to ComfyUI)

The recordings are a person's own chat, so they live outside the repository. Record them once with the browser console
(see below), then:

```
MM_REPLAY_DIR=/path/to/recording node tests/replay-baseline.mjs --write snapshot.json   # before a change
MM_REPLAY_DIR=/path/to/recording node tests/replay-baseline.mjs --check snapshot.json   # after a change
```
The tool rebuilds every ComfyUI request from the recorded storyboard and settings and compares the positive and negative
prompt, sampler, steps, CFG, canvas size, model files and loras (the seed is fixed). Without `MM_REPLAY_DIR` it skips.

Recording layout: `r01.json ...` (one per reply: `tag`, `userText`, `replyIndex`, `manga`, `comfyRequests`) and `fullchat.json`
(`{chat, settings}`). Capture them from the SillyTavern page by hooking `fetch` for the ComfyUI `/prompt` calls and reading
`chat[i].extra.manga` after each reply. Never commit a recording, an image or a key.

## What a code test proves, and what it does not

A code test proves what text and settings the extension sends. Only drawing images proves what the model makes of them.
"Redraw images" re-runs the page planner, prompts and ComfyUI from the saved frames but **not** the story reader, so it cannot test the reader;
use the message's image button ("Draw again": re-reads the same reply) or a new chat for that.

## Patch-removal and prompt tests (1.1)

`tests/adapters.test.mjs` proves that the new path writes none of the old patch wording for any adapter and that the 1.0.x path (older pages) still does.
`tests/repo-hygiene.test.mjs` fails if a picture, a recording (`fullchat.json`, `r01.json`, `snapshot-*.json`, `requests*.json`), a chat message or a key sits in the extension
folder; `.gitignore` lists the same patterns. Recordings and pictures belong in SillyTavern's own data folder, never in this one.

The image test of a code change is: rebuild the ComfyUI requests of a saved reply with the old and the new code (`tests/replay-lib.mjs`, `replayReply`, with the player's name read
from the recording), keep the cards, seeds, settings and graph identical, generate each frame with a few seeds, and rate event, relations, identity and beauty separately.
Do not mix two changes (patch removal, prompt shortening) in one comparison. Results are in `MOMENT-CARDS.md`.
