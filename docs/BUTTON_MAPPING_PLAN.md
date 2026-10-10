# OpenPuck: expanded button mapping + multiple profiles

Fork of safijari/openpuck (AGPL-3.0), planned against main @ 5f17c1d.
Status: planning only, no firmware or panel code changed yet.

## Decisions (2026-10-10)

1. Profiles are per emulated TYPE; the single-HID "game" variants share profiles with their composite
   counterparts (PS5 + PS5_GAME, DS4_GAME + HIDGYRO + PS3, Xbox + Xbox OG, HORI + Switch Pro).
2. Lizard gets profiles too. Steam / DInput / SInput stay out (host binds them). (Read "yes" as answering
   "should Lizard get profiles"; confirm.)
3. Borrow from the upstream profile PRs and credit their authors (see Credit).
4. **3 profiles per type.**
5. Switch gesture: modifier + LB (previous) / RB (next), with haptic pulses = profile number, always on.
6. (Why the fork dropped the Switch profiles: unknown. Moot.)
7. **A/B swap is part of the profile**, so e.g. a Switch Pro profile can turn swap on or off.

## Where things stand today

- Remappable sources: L4, R4, L5, R5, QAM only (`TypeCfg.back[4]`, `qamMap`), plus the A/B+X/Y swap flag,
  trackpad->stick/D-pad (`g_padStickCfg`), DualSense Create->touchpad. Everything else is hard-wired.
- Config is per TYPE (`ET_XBOX/SWITCH/DS4/DS5`, `etypeForMode()` in config.h). Steam/Lizard/DInput/SInput
  are `ET_NONE`.
- Target code space: 0 none, 1-4 A/B/X/Y, 5-8 LB/RB/L3/R3, 9-11 Back/Start/Guide, 12-15 D-pad,
  16 PS touch, 17 PS mute, 18 Switch capture, 19/20 LT/RT.
- code->button tables are duplicated: `codeToXB` (mode_xinput), `codeToSwitch` (mode_switch_hori),
  `codeToJc` (mode_switch_pro), `xboxOgApplyRemap` (mode_xbox_og), `psOrBackCode` (gamepad_util).
- Common entry point: every builder gets buttons via `shortcutHostButtons(btnsOf(r))`. Chord detection
  (rf_link.cpp ~4225) uses RAW `g_in[slot].buttons`. `mode_lizard.cpp` does not call
  `shortcutHostButtons`; it evaluates `g_lizardMap` directly on the button word.
- Storage: `cfg.bin` (struct Cfg, tail-append only, rewritten whole), `lizard_map.bin` (own magic/version,
  `storageWriteFile` = tmp + readback verify). Flash writes are loop-context only. LittleFS region is small
  (~28 KB in the host test), so keep new files compact.
- WebUSB status blob 214 B vs 256 B FIFO: new data needs its own ops/frames (like lizard 0x11->0xAA and the
  0xAE settings frame). Panel `types.js` already uses "profile" for per-type tabs: rename those to "controller
  type" in UI strings.
- Fork history: 54a4562 ported upstream #303's 7 Switch Pro profiles; ef7177b removed them. cfg.bin still has
  `reservedProfiles[37]`; WebUSB fields 190-229 are answered but ignored. Don't reuse those fields.

## Latent inconsistency (fix as part of the shared layer)

Under A/B swap, paddle/QAM codes mean different things per mode (read from code, not hardware-tested):
Xbox paddles = absolute host button (swap ignored) but Xbox QAM goes through swap; Xbox OG ignores swap for
both; Switch HORI/Pro and PS apply swap after the code. Rule going forward: remap output is Steam-position
TB_* bits and swap applies afterward. Visible change only for Xbox-type users with swap on. Note in release
notes. (Assumed OK; swap-per-profile makes the rule matter more.)

## Upstream notes and credit

### safijari/openpuck#303 (Froggerdog; single commit 6fdd6eb, tool-authored as "Codex"; open)
7 Switch-only back-button profiles, each selectable directly by a chord (`SwProfiles`: enabled, active,
back[4][4], chord[7], extraBack[3][4]); also trackpad D-pad, HD rumble, QAM modifier, shortcut feedback.
Already ported then removed in this fork. Take: direct-select-by-chord is an alternative to cycling; haptic
pulse count = profile index (their "1/2/3 vibrations").

### safijari/openpuck#309 (cadenabelcannon-ctrl; commit 2f078e0, Claude-assisted; opened 2026-10-09; open)
4 paddle profiles per emulated type, on-controller. Take:
- Gesture: back-4 + RB next / LB previous; buzzes = profile number. (Matches Decision 5.)
- Gesture debounce: chord must be stable 40 ms, fires once per hold, re-arms on release, ignored while
  `USBDevice.suspended()`.
- Gesture buttons are masked from the host (`g_in` and raw report) while the modifier is held.
- Deferred save: batch changes, write ~3 s after the last one, and flush from `saveCfg()` too.
- First-run seeding: profile 1 = current config, others = presets. We seed 2-3 as copies of profile 1
  (cycling is a no-op until edited); their presets (face buttons / D-pad / off) are an alternative.
- Paddle-assign (learn) mode: back-4 + Start, then tap a paddle and tap its target; same paddle twice = off;
  no input reaches the host; 30 s idle timeout; 1/2/3 buzzes = selected/saved/cleared. Optional phase 6 for us,
  generalized to any source.
- Feedback that bypasses the rumble-off toggle (a UI signal must be felt) -> fork's `hapticShortcutFeedback`
  is gated by `SHORTCUT_FEEDBACK` and capped at 3 pulses (fits 3 profiles); add a "force" path rather than
  a second sequencer.
Diverge:
- They keep the active profile in `cfg.bin` and the rest in `/paddles.bin` (two sources of truth); we keep
  all profiles in one file.
- Their save does `InternalFS.remove()` then write (as read from the diff), so a power cut between the two
  loses the file; we use `storageWriteFile` (tmp + verify).
- Profile = 4 paddle codes only; ours = whole map + swap + trackpad->stick.
- Hard-coded back-4 modifier; ours follows `SHORTCUT_QAM`/`shortcutHeld()`.
- Hardware tested only on Switch 2 in Switch Pro mode, single controller; panel can't show/edit non-active
  profiles. We need multi-slot and non-Switch testing notes.
- If upstream merges #309 first, merging it into the fork would collide in rf_link.cpp/config.cpp/OpenPuck.ino.
  Option: import `/paddles.bin` (magic 0x50, ver 1) into `btnmap.bin` on first boot.

### Credit (mechanics)
- Every commit that adapts their code or design carries a `Co-authored-by` trailer for the PR author
  (GitHub noreply addresses from the API; they have no public display name) plus a body line naming the PR and
  commit, in the style 54a4562 already used:
  - `Co-authored-by: Froggerdog <30682457+Froggerdog@users.noreply.github.com>`
  - `Co-authored-by: cadenabelcannon-ctrl <255264000+cadenabelcannon-ctrl@users.noreply.github.com>`
- Source files that copy (not just inspire) code keep a header note pointing at the PR.
- README `# Acknowledgements` gets entries for #303 and #309; `docs/CONTROLLER_FEATURES.md` (which already
  documents #303) gets a profiles section naming both.
- 54a4562 credited #303 in text but without a trailer. Rewriting it needs a force-push, so leave history
  alone; the README entry covers it.
- Not planned unless asked: commenting on or linking back from the upstream PRs.
- #270 (ixelyth, Lizard stick inputs) is already in the fork (bd115c5); relevant only if Lizard profiles touch it.

## Design

### 1. Shared remap layer (new `remap.{h,cpp}`)
- ~24 sources: A B X Y, LB RB, L3 R3, D-up/down/left/right, View, Menu, Steam, L4 R4 L5 R5, QAM,
  L-pad click, R-pad click, digital L2/R2. Touch bits and analog axes out of scope for now.
- `uint8_t target[NSRC]` with explicit target codes (0 = disabled); `defaultMap(type)` = identity for the
  physical buttons, today's paddle defaults (5,6,7,8), QAM default (18 on Switch). Legacy `qamMap` 0 meant
  "hardcoded default" while `back` 0 meant "none": migration translates, it doesn't copy.
- Applied in parallel from the raw word (new word from source bits) so A<->B swaps don't cascade; multiple
  sources to one target OR together. After `shortcutHostButtons` so chords still see physical buttons.
  Steam-button remap only affects emulated reports; wake / power-switch / mode logic stay on raw.
- Delete the five duplicated code->button tables. LT/RT targets keep the "force analog to 0xFF" behavior.
  Targets a mode can't express are ignored; the panel filters by type.

### 2. Profiles (3 per type)
- Name: "mapping profile". A profile = `{map[NSRC], abSwap, padStick[2]}`. Rumble, LED, pad haptics and grip
  strength stay per type.
- Storage: new `/btnmap.bin` (magic, version, per type: active index + 3 profiles) via `storageWriteFile`,
  deferred save as above. About 4 x 3 x 28 B, ~350 B.
- Live mirrors `g_back/g_qamMap/g_abSwap/g_padStick` stay, fed from the active profile. Legacy WebUSB fields
  (4, 5-8, 21, 40 + et*9 + k) edit the active profile of that type. `TypeCfg` bytes stay on disk for downgrade.
- Migration: no `btnmap.bin` -> profile 1 of each type from current `TypeCfg` + `g_padStickCfg` + swap;
  profiles 2-3 copies of it.
- Switching: modifier (per `SHORTCUT_QAM`) + LB/RB = prev/next, edge-triggered with latch, 40 ms stable, not
  while suspended, 1-3 pulses always (ignores `SHORTCUT_FEEDBACK`). Add LB/RB to the `shortcutHostButtons`
  mask while the modifier is held. Applies to the whole puck (all slots) at first; per-slot is a later question.
- The RF path can't write flash: set a dirty flag + deadline, write from loop.

### 3. Lizard profiles
- Lizard is a pseudo-type (index 4) in the same active-profile table; 3 `LizardMap`s (~770 B each).
  `lizard_map.bin` stays profile 1 so downgrade works; profiles 2-3 and the active index go in a new file.
- Applies to MODE_LIZARD only (the saved map is live only there). Gesture and LB/RB masking must be added in
  `mode_lizard.cpp` since it bypasses `shortcutHostButtons`. WebUSB lizard ops need a profile index.

### 4. WebUSB + panel
- New op/frame pair: read a type's profiles, write one map entry, set swap/padStick, select active, copy,
  reset. Op/frame numbers to be picked from docs/PROTOCOL.md (not yet checked). Status blob unchanged unless
  one spare nibble for "active profile" fits.
- `panel/types.js`: button grid (glyph + `glyphSelect`; icons exist for every pad button), a 3-slot profile
  strip per type and for Lizard (active marker, copy-from, reset), swap toggle moves into the profile.
  Keep the reset-to-defaults confirm, reworded. `panel/backup.js` exports/imports profiles and still imports
  old backups. Docs: PROTOCOL.md, CODE_MAP.md, CONTROLLER_FEATURES.md, README.

## Phases

0. Characterization test: record each builder's output for every source x code x swap setting, pattern
   `tests/lizard_map/run.py` (host-compiled with mocks). Add the README acknowledgement.
1. Shared remap layer over the existing 5 sources. Only intended change: the Xbox swap rule.
2. All sources + swap per profile + `btnmap.bin` + migration + WebUSB ops (one profile live).
3. 3 profiles + on-controller switching + feedback.
4. Panel UI, backup/import, docs.
5. Lizard profiles.
6. Optional: learn mode (tap source, tap target), analog sources (trigger->button, stick/trigger swap),
   profile names, per-slot profiles.

## Constraints

- AGENTS.md: kernel-style clang-format 18, 80 cols, "why" comments only; `make check` is the CI gate.
- Planned without hardware access: firmware changes can only be host-tested until flashed. `make build` (Arduino/nRF
  toolchain) availability in the authoring environment is unchecked.
- cfg.bin changes tail-append only; flash writes loop-context only.

## Still open

1. Confirm Decision 2 reading (Lizard gets profiles; Steam/DInput/SInput stay out).
2. Profiles 2-3 seeded as copies of profile 1 (default), or #309-style presets?
3. Learn mode (phase 6): wanted at all?
4. Phases 0-1 start on this branch (`feat/button-mapping`) once the items above are settled.
