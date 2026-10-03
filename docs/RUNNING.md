# Running and re-testing Manga Mode

## Run

1. Start ComfyUI (`ComfyUI-Easy-Install/Start ComfyUI.bat`) - it must listen on http://127.0.0.1:8188.
   For the custom workflow, `ComfyUI/custom_nodes/ComfyUI-MangaMode-Bridge` must be installed
   (restart ComfyUI once after adding or updating it). Its `mangamode_bridge.json` names the
   SillyTavern folder; on every Ctrl+S in ComfyUI the bridge copies the workflow into
   SillyTavern's `data/default-user/user/workflows` as "MangaMode - <name>.json" (+ ".ui").
   Tip: in the ComfyUI console window turn off QuickEdit (title bar -> Properties): a stray click
   in that window pauses ComfyUI until Esc is pressed.
2. Start SillyTavern and open http://127.0.0.1:8000.
3. Extensions panel -> Manga Mode:
   - Enable, pick the scene-parser Connection Profile ("Manga Parser", OpenRouter).
   - World book: built by itself with the first panel of a chat (Show / Rebuild buttons).
   - Quality check ON (vision model google/gemini-3.8-flash, 1-2 redraws per picture).
   - ComfyUI URL `http://127.0.0.1:8188`; time limit per picture 300 s.
   - Model profile: "Anima Turbo v1.1 (natural)" (files: see DOWNLOADS.md), or a custom workflow:
     pick a workflow saved in ComfyUI in the "Workflow" drop-down ("the true one" is a copy of the
     built-in one with %prompt% / %negative% in its text boxes; the first one found is picked for you on a first run). Edit it in ComfyUI, Ctrl+S, done.
     Character reference in a custom workflow (IP-Adapter): an "easy loadImageBase64" node with
     %reference% (or %reference_face%) in its base64 box feeds the reference image, and
     %reference_weight% in the adapter's weight box; tick "Character reference" in Manga Mode.
     Frames without a reference are drawn with the adapter taken out of the graph (no grey picture).
4. Chat normally. Each character reply gets a page; the image button on a message (re)draws it,
   including old messages. "Redraw images" keeps the storyboard and only draws again.

## Re-test

Pure logic (no SillyTavern or ComfyUI needed), from this folder:

    node tests/unit.test.mjs
    node tests/regression-1.07.test.mjs   # audit regressions, webtoon mode; "todo" lines would be known faults not fixed yet
    node tests/modules-audit.test.mjs     # layout, balloons, crops, image analysis, set book (random inputs)

Live pipeline, in the SillyTavern page's browser console:

    MangaMode.redraw(6)   // redraw one message (index in SillyTavern.getContext().chat)
