# The Direct planner (default since 1.1)

From 1.1 every reply is planned by **Direct**. There is no planning switch any more: the old "Picture planning" drop-down is gone.

## What it does

One structured call to the story reader (the LLM of your Connection Profile) reads the finished reply and returns, in a fixed JSON shape:

- **frames** - one per picture: `moment` (what happens, in plain words), `shot`, `angle`, `kind` (character / insert / establishing), `new_panel`,
  `emphasis` (normal / peak), `shows` (who is visible with which body parts and **who each person looks at**, which objects, how much of the place),
  the place name, the light, and which dialogue lines belong to the frame;
- the **dialogue** lines (speaker, kind, text), the **new people** and **new places or objects** the reply introduces (with outfit changes marked),
  and the **state** at the end of the reply (place, light, who holds what).

The reader never writes new story. The code then:

1. **Checks** the answer. A data error (an unknown name, a dialogue line used twice or never, the player's own face drawn in first-person view, ...) is a *problem*:
   the reader is asked once to correct it, and a problem that remains is shown as an error on the page. A weaker finding (a visible face with no looks-at, a hand
   with no owner while two people are in the picture, a shot word inside the moment) is *advice*: it is added to the same single retry, and if it remains the page is drawn anyway and the
   warning is kept (`scene.warnings`, shown in the debug block). The code **names** problems; it never repairs or invents data.
2. **Turns the answer into the scene** the page planner, balloons and continuity books already read (`directToScene`). The planner is the same code as before;
   Direct adds no frame, pose or event of its own.
3. **Writes every prompt at draw time** from the frame the planner finally chose (lettering can widen a close-up): the moment, then the fixed look
   of **only the people the frame lists as visible**, the place and objects it lists, the light, and your look's prefix/suffix. Names become the story's visual labels.
   The whole prompt of every frame can be read in the message's debug block.

## What stays general, and what Direct never does

Everything Direct adds is a rule of the *story* or a data check: carry the story's facts across, say whose hand it is, keep each person's look and
gaze, validate the data. It contains **no workaround for one image model** (the 1.0.x prompt patches are not in it) and it does not change a model's weights.
Models and looks stay separate: the look (`STYLE_PROFILES`) and the image model's dialect (`ADAPTERS`) are in `model-adapters.js` (see `RULES.md`); the story reader is
whatever your Connection Profile says (nothing in the code names a reader model).

Text care in the prompt (`direct-text.js`, all in plain grammar): adjectives the reader put in front of a name move behind the label's article ("the sleek black designer sunglasses"),
a label's article is dropped after a possessive, a word the label already says is said once, and a person named twice in a sentence gets "her / his / their" the second time. It only
re-orders and de-duplicates. One outfit per person: a world-book outfit with an "alternatively ..." second outfit keeps the first.

## Redraw, Draw again, old pages

- The message's image button, **Retry**, **Try again** and **Draw again** (the last appears when you edited the message) read the story again with Direct and draw new pictures.
- **Redraw images** (under a page) keeps the reader's frames and dialogue and draws new pictures with new seeds: **no story-reader call**
  (the picture checker still runs if it is on).
- Pages made by 1.0.x stay as they are. Redraw on such a page draws it the way it was planned and says so; "Draw again" re-reads it with Direct.
  Nothing is deleted or rewritten when you update.
- Going back: install release v1.0.1-beta from the Releases page over this folder. Saved chats are not touched by either version.

## Prompt style

Direct writes **sentence** prompts. That is what the natural-language models need (Anima, Qwen-Image, Flux, Z-Image). Tag-only models (Illustrious, NoobAI, Pony)
still work with Direct (the style only changes the prefix and suffix), but their CLIP text encoders were trained on short tag lists, and the 1.0.1 release served them with tags and one text chunk per person: for those, stay on v1.0.1-beta.

**Planned for a later release (not in 1.1): a tag dialect for Direct.** The story reader would stay the one that understands the reply. Only the output dialect would change, as an adapter in `model-adapters.js`:
when a tag style is chosen, the reader also fills one extra field per frame (the moment as short booru-style tags, no names), and the adapter writes the tags, the person-count and camera tags and one chunk per person
from the fixed look and outfit that are already tag-like. It would contain no workaround for any one model, and it needs its own image test on a real Illustrious/NoobAI/Pony setup, which is why it is not squeezed into the closing build.

## What was measured, and its limits

Direct was compared with the old Classic planning and with a hand-written reference on saved replies, key frame only, rated blind by one person.
Under the pass rule written down before the test, **there was no winner**: on the tuning set Direct missed one criterion by 0.006. Overall scores (0-1):
tuning Direct 0.868 against the hand reference 0.872; validation Direct 0.899 against 0.868. This is one rater, a small sample, an imperfect hand reference
and only each reply's key frame; it is **not** a claim that the image model is used to its full capacity.

Cost per reply was about the same as Classic, or slightly lower. In the closing live test of the finished extension (Anima Turbo, google/gemini-3.8-flash as reader and checker):
the first reply of a new chat cost $0.0120 (world book + reader, 5,647 prompt and 2,062 completion tokens), the next replies $0.0108, $0.0093 and (a second reading of the same reply) $0.0097, reader only.
With the quality check on, one 4-frame page cost another $0.021 (6 vision calls: 4 first looks, one redraw, one second look on the failed frame; 19.8k prompt tokens). "Redraw images" itself makes no reader call.
A retry (rare) adds one more reader call. These are four replies of one chat with one reader model: indicative, not a benchmark.

## Known limits

- The reader's JSON is validated, but a weak reader model can still fail the schema or leave a problem after the one retry: you see the error on the page and can press Try again.
- Dense dialogue still gets an extra picture for the last balloons (the page planner, unchanged).
- The image model is the main limit on quality (small local model, static poses).
- The rule log at the bottom of `direct-path.js` lists every rule with the failure that caused it and the test that checks it.
