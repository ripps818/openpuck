# OpenPuck: expanded button mapping + multiple profiles

Fork of safijari/openpuck (AGPL-3.0), planned against main @ 5f17c1d.
Status: phases 0-5 done on `feat/button-mapping` (see Phases). Questions answered 2026-10-10 (see Decisions).

## Decisions (2026-10-10)

1. Profiles are per emulated TYPE; the single-HID "game" variants share profiles with their composite
   counterparts (PS5 + PS5_GAME, DS4_GAME + HIDGYRO + PS3, Xbox + Xbox OG, HORI + Switch Pro).
2. Lizard gets profiles too (confirmed 2026-10-10). Steam / DInput / SInput stay out (host binds them).
3. Borrow from the upstream profile PRs and credit their authors (see Credit).
4. **3 profiles per type.**
5. Switch gesture: modifier + a "previous" and a "next" button (default LB / RB), with haptic pulses = profile
   number. Configurable on the mapping page (2026-10-10): an enable toggle (default on) plus a choice of the two
   buttons. The setting is puck-wide, not per profile, and works even when the Mode shortcuts master switch is
   off (it needs its own modifier check; the modifier itself still follows `SHORTCUT_QAM`). The panel only offers
   buttons that no mode shortcut uses (not A/B/X/Y, D-pad, pad clicks); the chosen two are masked from the host
   while the modifier is held.
6. (Why the fork dropped the Switch profiles: unknown. Moot.)
7. **A/B swap is no longer a flag.** It becomes a one-shot "Apply Nintendo layout" button that overwrites the
   four face-button entries (A<->B, X<->Y) of the profile being edited (2026-10-10). Revised the same day: while
   the four are exchanged the button reads "Revert Nintendo layout" and the same op (0x2E) puts them back, so it
   is a toggle with no flag behind it (the state is the map). Firmware drops `g_abSwap` from the builders; the
   map is the only source of truth, which removes the Xbox swap inconsistency below.
8. Profiles 2-3 are seeded as copies of profile 1 (confirmed 2026-10-10).
9. **On-controller learn mode is wanted** (2026-10-10), entered with modifier + Steam. It does not add any
   first-layer buttons: layer 1 stays at profile prev/next. Flow, each step confirmed by a rumble: modifier +
   Steam (enter) -> press the button to remap (source) -> press the button it should act as (target, saved to the
   active profile). Details in "Learn mode" below.

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

## Removing the swap flag (replaces the old "swap rule" problem)

Today `g_abSwap` is applied in every builder, and paddle/QAM codes mean different things per mode (read from
code, not hardware-tested): Xbox paddles = absolute host button (swap ignored) but Xbox QAM goes through swap;
Xbox OG ignores swap for both; Switch HORI/Pro and PS apply swap after the code. With the flag gone, targets
are literal Steam-position codes and the map does the swapping.
- Phase 1 must not change behaviour: the live map is built per mode from `TypeCfg` (identity + paddles + QAM +
  swapped face entries when `abSwap` is set), translating paddle/QAM targets through the swap only where that
  mode does so today. The characterization test (phase 0) proves it.
- Phase 2 migration bakes that translation into the stored maps (e.g. a Switch paddle on A with swap on stores
  B), so the per-mode quirk table can be deleted.
- Found in phase 1: PS3's swap was not an A/B + X/Y exchange (swap on gave A->Triangle, B->Circle, X->Cross,
  Y->Square). Fixed after phase 1 (Xbox equivalents A = Cross, B = Circle, X = Square, Y = Triangle; swap now
  exchanges the pairs like every other mode), so PS3 users who had swap on see a corrective change: mention it in
  the release notes. `tests/button_map` golden updated for the ps3 swap=1 lines only.
- Old panels and backups keep working: legacy swap fields 21 and `40 + et*9 + 5` write the Nintendo preset
  (value 1) or restore those four entries to identity (value 0) on the active profile. The status blob's swap
  bytes (p[7], per-type q[5]) report "the four entries are currently swapped".

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
- Name: "mapping profile". A profile = `{map[NSRC], padStick[2]}`. Rumble, LED, pad haptics and grip
  strength stay per type.
- Storage: new `/btnmap.bin` (magic, version, per type: active index + 3 profiles) via `storageWriteFile`,
  deferred save as above. About 4 x 3 x 28 B, ~350 B.
- Live mirrors `g_back/g_qamMap/g_padStick` stay, fed from the active profile (`g_abSwap` is gone, see above). Legacy WebUSB fields
  (4, 5-8, 21, 40 + et*9 + k) edit the active profile of that type. `TypeCfg` bytes stay on disk for downgrade.
- Migration: no `btnmap.bin` -> profile 1 of each type from current `TypeCfg` + `g_padStickCfg` + swap;
  profiles 2-3 copies of it.
- Switching: modifier (per `SHORTCUT_QAM`) + the configured prev/next buttons (default LB/RB), edge-triggered
  with latch, 40 ms stable, not while suspended, 1-3 pulses always (ignores `SHORTCUT_FEEDBACK`). The gesture
  settings (enabled, prev code, next code) are puck-wide, 3 bytes in the `btnmap.bin` header. Add the chosen
  buttons to the `shortcutHostButtons` mask while the modifier is held. Applies to the whole puck (all slots)
  at first; per-slot is a later question.
- The RF path can't write flash: set a dirty flag + deadline, write from loop.

### 3. Lizard profiles
- Lizard is a pseudo-type (index 4) in the same active-profile table; 3 `LizardMap`s (~770 B each).
  `lizard_map.bin` stays profile 1 so downgrade works; profiles 2-3 and the active index go in a new file.
- Applies to MODE_LIZARD only (the saved map is live only there). Gesture and LB/RB masking must be added in
  `mode_lizard.cpp` since it bypasses `shortcutHostButtons`. WebUSB lizard ops need a profile index.

### 3b. Learn mode (phase 6)
- Entry: modifier (per `SHORTCUT_QAM`) + Steam, same debounce as the gesture (40 ms stable, once per hold,
  re-arms on release, ignored while suspended). Works for the four emulated types only; in Steam, Lizard,
  DInput and SInput modes it does nothing (Lizard bindings are a different, mask-based map).
- Steps, each with its own forced rumble (bypasses `SHORTCUT_FEEDBACK` and the rumble-off toggle, via the same
  path as the profile pulses): 1) entered, 2) source captured (the next remappable button pressed), 3) target
  saved. Steam is masked from the host while the modifier is held, so entering does not leak Guide, and the
  Steam + Y shutdown check must ignore the chord while the modifier is held.
- While active: no input reaches the host, mode shortcuts and the profile gesture are suspended, 30 s idle
  timeout (distinct rumble), modifier + Steam again cancels. The target is the physical button pressed, read
  as its Steam-position code, so "press A to make it act as A" needs no menu.
- Clearing (2026-10-10): at the source step, **holding a button for about 1 s** gives a long rumble and resets
  that button's mapping to its default (identity for the physical buttons, today's defaults for the paddles
  and QAM; not "disabled", which stays panel-only). Learn mode stays active for the next source, so several
  buttons can be reset in a row. Because a tap and a hold must be told apart, a source is captured on
  **release** (held under the threshold), and the reset fires at the threshold without waiting for release,
  after which that release is ignored. The target step captures on press and has no hold behaviour.
- Buttons still held when learn mode starts (the modifier and Steam) are ignored until they are released, so
  entering never captures itself.
- Writes `map[source] = target` into the active profile through the same deferred save as the panel, so the
  panel shows the change on its next read.
- Rumble vocabulary (to settle in phase 6; must stay distinct from the 1-3 pulses that mean "profile N"):
  entry, source captured, saved, reset (the long one), timeout.

### 4. WebUSB + panel
- New op/frame pair: read a type's profiles, write one map entry, apply the Nintendo preset, set padStick,
  select active, copy, reset, set the gesture. Free numbers (checked against PROTOCOL.md at 5f17c1d): ops
  `0x2C` and up, but the range check in `webusbPoll` (`op > 0x2B`) must be extended; device-to-host frames
  `0xB0` and up (`0xA5`-`0xAF` are taken). Status blob unchanged unless one spare nibble for "active profile"
  fits.
- This is the protocol bump: v29 shipped as `ripps-5f17c1dc`, so the first new op bumps to 30 (one bump for the
  whole feature). Update the version comment and the panel's `p[0]>=N` gate.
- PlayStation types (DS4, DS5, which cover PS3 too) never show A/B/X/Y (2026-10-10): face sources and targets
  carry the PlayStation symbols (Cross, Circle, Square, Triangle = codes 1-4, the glyphs the panel already has),
  and the Nintendo preset button on those types is worded as exchanging the symbols (Cross <-> Circle,
  Square <-> Triangle). The data and the ops are the same for every type; this is labels only.
- `panel/types.js`: button grid (glyph + `glyphSelect`; icons exist for every pad button), a 3-slot profile
  strip per type and for Lizard (active marker, copy-from, reset), the swap toggle becomes an "Apply Nintendo layout"
  button, and a gesture card (enable + prev/next dropdowns).
  Keep the reset-to-defaults confirm, reworded. `panel/backup.js` exports/imports profiles and still imports
  old backups. Docs: PROTOCOL.md, CODE_MAP.md, CONTROLLER_FEATURES.md, README.

## Phases

0. Characterization test: record each builder's output for every source x code x swap setting, pattern
   `tests/lizard_map/run.py` (host-compiled with mocks). Add the README acknowledgement.
   **Done**: `tests/button_map/run.py` + `golden.txt` (22 digest groups over 7 builders; `--dump` to diff two versions of
   the code, `--update` only for an intended change). README acknowledgement added.
1. Shared remap layer over the existing 5 sources, `g_abSwap` folded into the live map. No behaviour change.
   **Done** (`OpenPuck/remap.{h,cpp}`; `tests/button_map` digests unchanged). The live map is computed per call from
   `g_abSwap` / `g_back[]` / `g_qamMap` (no cached copy to go stale); `RemapStyle` carries each mode's swap
   quirk. The five code tables are gone; Switch Capture travels as a `capture` flag since no TB_* bit is free.
2. (in steps) 2a: map-based remap core, 24 sources, live map built from the legacy settings (**done**: only
   the Xbox OG swap + QAM corner changed, see `tests/button_map`); 2b (**done**: `btnmap.{h,cpp}`, `tests/button_profiles`): profile store, `btnmap.bin`, migration,
   legacy fields edit the active profile; 2c (**done**): WebUSB ops `0x2C`-`0x32`, the `0xB0` frame, protocol
   v30, PROTOCOL.md. Select / copy / reset / per-profile pad -> stick are already in the ops, so phase 3 only
   adds the on-controller gesture.
   All sources + Nintendo preset + `btnmap.bin` + migration (bakes the swap translation) + WebUSB ops (one
   profile live).
3. 3 profiles + on-controller switching (configurable gesture) + feedback.
   **Done**: `btnmapGesture` (rf_link per-report block), `g_gestureMask` hiding the two buttons in `shortcutHostButtons`,
   forced rumble (`hapticShortcutFeedback(.., true)`), op `0x33` and the gesture trailer of the `0xB0` frame,
   `btnmap.bin` version 2 (version 1 still reads). A change made on the controller is written 3 s after the last
   one (loop context): the page erase can still cost one short input hitch in play, 3 s after the last switch.
4. Panel UI, backup/import, docs.
   **Done**: `panel/profiles.js` (profile strip, 24-source grid, Nintendo / PlayStation swap button, copy,
   reset, gesture card), shown from status v30 with the older paddle / QAM / swap controls hidden
   (`.prof-legacy` -> `.prof-off`). Status blob byte 211 carries each type's active profile (2 bits each), so
   the panel reloads a type only when that changes. Reset to defaults resets all three profiles. Backup version 3
   carries the profiles and the gesture; restore sends only the entries that differ. `modeSwitchReboot` flushes a
   pending `btnmap.bin` write. Test: `tests/button_profiles/panel.cjs`. Rendered in headless Chromium against a fake puck (2026-10-10); not yet tried on a real puck (needs a v30 CI build flashed).
5. Lizard profiles.
   **Done**: one file per profile (`lizard_map.bin` = profile 1, `lizard_map2.bin` / `lizard_map3.bin` seeded at
   boot as copies), RAM unchanged (only the active map is live; others are read on a switch). Active index in
   `btnmap.bin` version 3; type 4 in ops `0x2C`/`0x2F`/`0x30`/`0x32`, op `0x34` picks the profile the lizard ops
   edit (default: the active one), `0xAE` payload byte 47 reports the active one. Gesture works in MODE_LIZARD;
   `lizardButtons()` masks the two switch buttons. Panel strip on the Lizard tab, backup carries all three maps.
   A switch in Lizard mode reads the profile's file on the RF path (a LittleFS read, no write).
6. On-controller learn mode (decision 9); needs the remap layer, the gesture masking and the forced feedback
   path from phases 2-3, and the panel from phase 4 to show the result.
7. Optional: analog sources (trigger->button, stick/trigger swap), profile names, per-slot profiles.

## Macros (later, not built)

Planned for later (2026-10-10): a source, or a combination of sources, can be bound to a macro. Nothing is
built; the design keeps room for it:
- A target byte is a button code below 128 and a macro slot from 128 (`REMAP_CODE_MACRO_BASE`), so a source
  can already be stored as bound to one. A code a mode does not know acts as none and is kept when stored.
- A combination is a second table, read before the per-source one, that consumes its member sources; it is a
  new, length-prefixed section of the stored profile and of the WebUSB profile frame, so older firmware and
  panels skip it.
- Macros themselves (a table of timed steps) are a separate store and a loop-context player; the RF path only
  sets a request flag, as with the profile gesture.

## Constraints

- AGENTS.md: kernel-style clang-format 18, 80 cols, "why" comments only; `make check` is the CI gate.
- Planned without hardware access: firmware changes can only be host-tested until flashed. `arduino-cli` is not in
  the lbx-claude box, so `make build` only runs in CI (`pr-check.yml`).
- `TB_VIEW` / `TB_MENU` are named backwards from the physical buttons (triton.h); keep source names and panel
  glyphs ("view" = Back/Minus/Create) consistent when building the source table.
- cfg.bin changes tail-append only; flash writes loop-context only.

## Still open

1. Phases 0-1 start on this branch (`feat/button-mapping`).
2. Phase 6 details to settle with hardware: the hold threshold (about 1 s), the 30 s timeout, and the rumble
   patterns.
