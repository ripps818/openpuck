# Switch Pro trackpad D-pad, shortcuts, HD rumble and mapping profiles

## Trackpads

Switch Pro trackpad mapping includes D-pad on touch and D-pad while clicked, including diagonals. Trackpad D-pad click feedback has a separate enable control. These and the other Switch Pro-only settings (Quick Access + Minus target, gyro mapping) are on the Switch tab of Button mapping in the configurator.

The Switch Pro back-button profiles from the upstream PR were removed from this fork. Every emulated type now has mapping profiles of its own (below).

## Rumble

Rumble follows the mode: Switch Pro mode plays HD rumble, every other emulated mode plays normal rumble, and Steam mode relays Steam's own haptics. There is no style to choose. Each mode's tab in Button mapping has its rumble on/off switch and grip rumble strength; HD trackpad strength is on the Switch tab, and Grip limiter on the Switch and DS5 tabs (one shared setting, below). A config from before per-mode strength gives every mode the previous global strength.

HD rumble plays the game's HD rumble at the game's frequencies. Each grip actuator, where a Pro Controller has its actuators, plays its side's low and high bands summed into one waveform, streamed as 4 kHz PCM. Each trackpad plays its side's high band as a tone. There is no motor-style rumble. Grip rumble strength scales the grip waveform and HD trackpad strength the pad tones, independently.

Amplitude follows Nintendo's scale: amplitude code 100 (`0xC8`, what SDL and the public amplitude table use for full strength) is 1.0, and codes above it play at full scale. Until 2026-10-05 the firmware put 1.0 at code 127, so every effect played at 0.56× of its intended level. Where the two bands sum past the Grip limiter level (default 70% of full scale, on the Switch and DS5 tabs and shared with DualSense audio haptics), the waveform is rounded off toward full scale instead of clipping, which played as pops. In a 205 s Super Mario Odyssey capture at the default 200% grip strength the band sum reached the knee in 0.8% of updates and passed full scale in 0.2%; the median was 5% of full scale.

**Emulators:** Eden through SDL sends only plain two-motor rumble in HD format (fixed ~150 Hz frequencies, a report every ~50 ms). For the game's real HD rumble (changing frequencies, a report every ~3-4 ms), enable "Direct Pro Controller driver" in Eden's controller settings, then reselect the puck as player 1's input device ("Pro Controller 1"): the old SDL bindings stop working once the direct driver owns the pad. The driver reads the device-type byte at SPI `0x6012` and gets no input unless it reads 3 (Pro Controller), which the firmware returns since 2026-10-05.

The grip stream starts about 35 ms after the first rumble (estimated; the controller holds 24 ms of it in its PCM buffer) and stays up through gaps of up to 500 ms, so later effects in a scene start without that delay. It stops 500 ms after the game goes silent. In gameplay it made each effect's intent easier to tell apart than grip tones did, which is why it replaced them.

Pad tones last 120 ms. A tone is re-sent at once on a hit (+6 dB), on a retune or a 2 dB step at most every 32 ms, and otherwise every 50 ms, so small amplitude jitter doesn't restart it. An actuator whose band goes quiet is cut within about 25-50 ms. A stale report, silence, suspend or disabled rumble stops output, and the finite duration bounds output even if an RF stop is lost.

The trackpad command ceiling is −15 dB from 250–300 Hz, returning gradually to −3 dB over 230–250 and 300–320 Hz. This frequency-dependent ceiling came from controller calibration and gameplay testing; it is not a measured acoustic limit or a guarantee for every controller. Effects already quieter than the ceiling keep their level. The grip waveform has no ceiling. Packed rumble timing is approximated. Trackpad strength 0 disables HD pad output; native pad feedback remains separate.

The other shaping styles (Mono, Heavy, Light, Swapped, Punchy, Soft) remain in the firmware only as a diagnostic: the serial console's `RY<n>` applies one until the next settings change.

## Shortcuts

Hold the modifier (Quick Access or all four back buttons) plus a button to switch mode; the toggles are in the configurator's Mode shortcuts card. Shortcuts, confirmation pulses and the Quick Access + Select action can be disabled separately. Defaults keep the original arrangement: all four back buttons, with confirmation pulses and Quick Access + Select off. Modifier + trackpad click toggles the touchpad with either modifier.

| Modifier + button | Action |
| --- | --- |
| B / X / Y | Assigned mode |
| D-pad Left / Up / Right / Down | Assigned mode |
| A | Return to Steam |

Quick Access + Minus/Select/Menu has an independent Switch Pro mapping, defaulting to Take screenshot. It works with either modifier setting. Minus is suppressed until release, including if Quick Access is released first. Holding Capture retains the console's normal capture hold behavior.

Quick Access retains its normal per-type mapping when it is not reserved as the enabled modifier. Selecting the four-back modifier suppresses the four paddles while held together; otherwise normal paddle mappings apply.

The upstream PR's D-pad haptic shortcuts (cycling rumble styles and strength steps) were removed from this fork, along with its rumble presets and strength steps.

## Mapping profiles

Each emulated controller type (Xbox, Switch, DS4, DS5) has three mapping profiles, and one of them is in use. A profile sets what each of 24 buttons acts as: the face buttons, bumpers, stick clicks, the Select- and Start-side buttons, Steam, the D-pad, the four back buttons, Quick Access, both trackpad clicks and each trigger's full-pull click. It also holds the two trackpad-to-stick settings. A button can act as nothing, as any button the emulated controller has, or as a trackpad click. The PlayStation tabs name the face buttons Cross, Circle, Square and Triangle.

In the configurator, each type's Button mapping tab edits one profile at a time: choose it in the profile strip, change its buttons, then **Use this profile** to put it in use. A dot marks the profile in use. **Copy over this profile** replaces the profile being edited with another one, and **Reset this profile** returns it to the factory mapping. **Reset to defaults** in the header resets all three profiles and puts profile 1 in use.

**Apply Nintendo layout** exchanges what the four face buttons act as in the profile being edited: A and B, and X and Y (on the PlayStation tabs, Cross and Circle, and Square and Triangle, which the button's tooltip spells out). It changes only those four entries, and applying it again swaps them back. It replaces the old A/B + X/Y swap switch.

To switch profiles on the controller, hold the shortcut modifier (Quick Access or all four back buttons, as set in Mode shortcuts) and press the previous or next profile button, LB and RB by default. The controller buzzes the new profile's number, even when shortcut confirmation pulses are off. While the modifier is held, those two buttons do not reach the game. This works whether or not mode shortcuts are on. The **Switch profiles from the controller** card turns it off or picks other buttons (LB, RB, L3, R3, Select or Start); it is one setting for every type. The new profile is saved 3 seconds after the last switch, so stepping through several writes flash once.

Lizard mode has three profiles of its own, each a whole set of keyboard and mouse bindings. The Lizard tab of Button mapping shows a profile strip above the bindings editor: choose the profile to edit, **Use this profile** to make Lizard mode use it, or copy another over it. **Reset to defaults** in the editor resets the profile on screen. The same controller shortcut steps through them while the puck is in Lizard mode. Profile 1 is the map older firmware reads, so a downgrade keeps it; profiles 2 and 3 start as copies of it. Steam mode's seamless lizard (Steam closed) keeps the built-in bindings and has no profiles.

The profiles build on Froggerdog's Switch Pro back-button profiles ([pull request #303](https://github.com/safijari/openpuck/pull/303)) and cadenabelcannon-ctrl's on-controller paddle profiles and profile-switch gesture ([pull request #309](https://github.com/safijari/openpuck/pull/309)).

## Upgrade and legacy behavior

The first boot with profiles builds `btnmap.bin` from the existing settings: all three profiles of a type start as copies of its back-button, Quick Access, swap and trackpad-to-stick settings. An A/B swap that was on carries over as swapped face-button entries. Older configurators, backups and the serial console keep working through those older settings, which now read and edit the profile in use. Backups from this configurator carry every profile, the three Lizard binding maps and the profile-switch buttons (backup version 3). Restoring one sends only the entries that differ, and firmware without profiles restores its single mapping from the older settings.


Configuration fields are appended after the fork's extension bytes, so an existing cfg.bin keeps every setting and the new fields start at their defaults. Bytes of removed settings (profiles, rumble presets, strength steps, per-type rumble style) stay in the layout as reserved space.

Settings, bonds and lizard maps use verified temporary-file writes before replacement. Nonblank storage is not automatically formatted after a failed mount. The configurator reports unavailable storage and failed saves.

These settings ride a separate `0xAE` frame requested with op `0x27`, and their WebUSB fields are 230-240 (the upstream PR's numbers plus 90, because the fork already uses 97-101). Fields of removed settings (190-229 profiles, 241-252 shortcut presets and steps, 39 and 104-107 rumble style) are ignored but still answered. See PROTOCOL.md section 10. Backups no longer include those settings, and an older backup's copies are skipped on import. A backup carrying shortcut settings is rejected on firmware without the `0xAE` frame before any write.

## Host verification

```sh
python3 tests/hd_rumble/run.py
python3 tests/switch_pro_shortcuts/run.py
python3 tests/final_webusb/run.py
python3 tests/shortcut_modes/run.py
python3 tests/storage/run.py
python3 tests/lizard_map/run.py
python3 tests/button_map/run.py
python3 tests/button_profiles/run.py
npm install --prefix /tmp/openpuck-ui-tests jsdom@26
NODE_PATH=/tmp/openpuck-ui-tests/node_modules node tests/switch_pro_shortcuts/configurator.cjs
NODE_PATH=/tmp/openpuck-ui-tests/node_modules node tests/button_profiles/panel.cjs
make check
make build
```

The C++ helper tests require g++ and use AddressSanitizer/UndefinedBehaviorSanitizer. Configurator tests use jsdom. Host checks cannot validate actuator feel or console pairing; test those on physical hardware.
