# How the picture rules are organised

Manga Mode separates four things that used to be mixed in one prompt builder, so that a better image model needs a new
adapter and nothing else.

| Layer | Where | What it holds | Changes when |
|---|---|---|---|
| **Core** | `scene-parser.js`, `director.js`, `prompt-builder.js`, `frame-plan.js` | What the story says, what each picture must show, how people are placed, safety rules | The story logic changes |
| **Style profile** | `STYLE_PROFILES` in `model-adapters.js` | The look (colored webtoon, black-and-white manga, semi-realistic, painterly) in model-free words | You want another look |
| **Model adapter** | `ADAPTERS` in `model-adapters.js` | One model's dialect: quality tokens, how an artist is named, sentences or tags. **No patches** | You switch image model |
| **Run settings** | Settings panel, model profiles | Sampler, steps, CFG, size, checkpoint/unet, loras, workflow | You tune one machine |

## Classification of the rules

**Scene meaning (core, every model).** Who is in the picture, what they do, who they look at, the place, the light, the
person's fixed look and outfit, names replaced by visual labels, "From left to right" positions, one picture per beat.

**Picture requirements (core, every model).** The frame (see `DIRECT.md`): the facts the picture must show, who
holds what in which hand, where people stand, and what the frame needs to be able to show (faces, hands, whole body, both people,
the place, an object). Safety negatives (`withSafetyNegative`) also stay in the core.

**Directing decisions (core).** Shot and angle, widening a shot when the facts need more of the scene, establishing shots,
inserts, panel count, first-person (POV) handling, page layout. `momentCamera` only ever widens a shot, never narrows it.

**Model wording (adapter).** Quality tokens (`masterpiece, best quality, score_7` for Anima; the plain tag prefix for tag
models; nothing for a neutral sentence model), the artist phrase (`@name` for Anima, `by name` for tag models, `In the style of
name.` for a sentence model), and whether the prompt is sentences or tags.

**Patches (none in Direct).** A patch is a sentence, a rewrite or a pipeline step added only because one image model
(Anima Turbo) drew something wrong without it. It says nothing about the story; it is a workaround. **The Direct planner (the only planner since 1.1)
contains no patches, for every adapter, Anima included, and has no setting that turns one on.** What Direct adds is a rule of the story or a data check
(whose hand it is, who looks at whom, one outfit per person, known names only), each logged with the failure that caused it in the rule log of `direct-path.js`.
The 1.0.x behaviour survives only to redraw a page that was planned by 1.0.x the way it was planned; all of its patches stay in one place:
`LEGACY_ANIMA_PATCHES` and `LEGACY_SHARED_PATCHES` in `model-adapters.js`. Nothing else reads those two objects.

| Patch (flag) | What the 1.0.x path (older pages only) still does | Why it is a patch, not a rule of the story |
|---|---|---|
| `framingTags` | Booru framing words ("upper body, cowboy shot") next to the quality prefix | Anima keeps to tags for framing; the camera is already said in a sentence |
| `postureSentence` | Says sitting / standing / leaning in a separate sentence | Anima let the action's end swallow the posture |
| `sideAnchors` | "On the left, ... On the right, ..." before each person | Outfits leaked between people on Anima |
| `openSpace` | "a few steps of open space", and deletes dividers / glass from the place text | Anima drew a wall between two talking people |
| `compositionThird` | "placed in the left third, open space on the right" | Anima draws a lone figure dead centre |
| `darkReinforce` | Repeats "low-key, dim, deep shadows" for night | Anima's small text encoder dropped the light |
| `edgeBackground` | "fully drawn and painted edge to edge" | Anima left white backgrounds |
| `singlePicture` | "It is one single continuous picture" | Anima drew two stacked panels |
| `noTextSentence` | "Signs, pages and screens show only unreadable marks" | Anima drew gibberish lettering |
| `insertGuards` | Long guard sentences for hand close-ups | Anima drew the viewer's hands for someone else's |
| `outfitFixes` | Prints become "a small picture print"; "scrunchie on wrist" becomes "on one wrist" | Anima drew lettering on shirts and a scrunchie on each wrist |
| `gazeHoldingClause` | "his eyes on that person's face, even while the hands are busy" | Anima drew people who hold a cup looking at it |
| `onlookerFixes` | "turned toward X, watching"; far watcher "seen from behind at a three-quarter angle"; "looks away from the viewer, into the picture" | Anima lined onlookers up like a group photo |
| `darkDropsVibrant` | A dark frame drops "vibrant full color" from the look's closing words | Anima made night scenes bright |
| `sideAlternation` | The reader's third single-person frame in a row is moved to the other side | Anima centres a lone figure |
| `cropFrames` | A close-up is drawn as an upper-body picture and cut to the head; a tall frame is drawn wider and cut | Anima drew whole bodies for a close-up |

**What Direct keeps, and why it is not a patch.** The scene (who, what they do, who looks at whom, the place, the light);
the frame's facts (who holds what, where people stand, who looks at whom); the camera sentence for the chosen shot and angle ("An upper-body
shot: cropped at the waist"); "From left to right: ..." (positions the story gave); one picture per frame as a *requirement* of
the plan, not as a circumventing sentence; the person's fixed look and outfit; the look the user picked (written only from the
style profile file); the model's quality tokens (a dialect, see the judgment calls below); and the run settings (size, steps,
CFG, sampler, checkpoint, loras).

**Judgment calls, stated so they can be overruled.** (1) The quality tokens `masterpiece, best quality, score_7` stay: they are
how this model family is addressed, not a failure workaround. (2) `withSafetyNegative` (chibi, minors) stays and is inert at CFG
1. (3) Hiding shoes in a waist-up shot, `withShotVariety` (no three frames at the same distance) and `reframe` (a closer crop of
the previous picture) stay: they are layout or consistency rules, not an image-model failure. (4) The reader prompt still tells
the reader to vary "side" and says onlookers are never "lined up like a group photo"; these two lines were written for Anima
and were NOT changed because the test holds the reader's output fixed. (5) The opt-in quality check and its repair actions
(redraw variants, face touch-up, white trim, insert fallback) are a verifier the user switches on; they were off in every test.

**Run settings.** Everything in the model profile. Not touched by this refactor.

## What is proven and what is not

`tests/adapters.test.mjs` and `tests/replay-baseline.mjs` prove that the 1.0.x path (used for older pages) still writes exactly the request 1.0.x wrote
(69 recorded ComfyUI requests rebuilt identically: positive and negative prompt, sampler, steps, CFG, size, model files; seeds
and the node numbering of the graph are not compared, and those graphs held no reference images), that the new path (Direct) emits none
of the old patch wording for any adapter, and that looks are independent of models. They do **not** prove that the patch-free
path draws as well as the patched one; that is an image test (see `MOMENT-CARDS.md` "Patch removal" and `DIRECT.md`). They also do not prove
that a second model draws better.
