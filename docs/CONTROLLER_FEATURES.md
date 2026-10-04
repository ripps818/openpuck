# Switch Pro trackpad D-pad, shortcuts and HD rumble

## Trackpads

Switch Pro trackpad mapping includes D-pad on touch and D-pad while clicked, including diagonals. Trackpad D-pad click feedback has a separate enable control. These and the other Switch Pro-only settings (Quick Access + Minus target, gyro mapping) are on the Switch tab of Button mapping in the configurator.

The Switch Pro back-button profiles from the upstream PR were removed from this fork; the back paddles use the Switch tab's normal mapping.

## Rumble

Rumble follows the mode: Switch Pro mode plays HD rumble, every other emulated mode plays normal rumble, and Steam mode relays Steam's own haptics. There is no style to choose. Each mode's tab in Button mapping has its rumble on/off switch and grip rumble strength; HD trackpad strength is on the Switch tab. A config from before per-mode strength gives every mode the previous global strength.

HD rumble plays the game's HD rumble as tones at the game's frequencies: each side's low band on that side's grip actuator, where a Pro Controller has its actuators, and its high band on that side's trackpad. Both bands play at once, with no motor-style rumble. Grip rumble strength scales the grip tones and HD trackpad strength the pad tones, independently.

Tones last 120 ms. A tone is re-sent at once on a hit (+6 dB), on a retune or a 2 dB step at most every 32 ms, and otherwise every 50 ms, so small amplitude jitter doesn't restart it. An actuator whose band goes quiet is cut within about 25-50 ms. A stale report, silence, suspend or disabled rumble stops output, and the finite duration bounds output even if an RF stop is lost.

The trackpad command ceiling is −15 dB from 250–300 Hz, returning gradually to −3 dB over 230–250 and 300–320 Hz. This frequency-dependent ceiling came from controller calibration and gameplay testing; it is not a measured acoustic limit or a guarantee for every controller. Effects already quieter than the ceiling keep their level. Grip tones have no ceiling. Packed rumble timing is approximated. Trackpad strength 0 disables HD pad output; native pad feedback remains separate.

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

## Upgrade and legacy behavior

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
npm install --prefix /tmp/openpuck-ui-tests jsdom@26
NODE_PATH=/tmp/openpuck-ui-tests/node_modules node tests/switch_pro_shortcuts/configurator.cjs
make check
make build
```

The C++ helper tests require g++ and use AddressSanitizer/UndefinedBehaviorSanitizer. Configurator tests use jsdom. Host checks cannot validate actuator feel or console pairing; test those on physical hardware.
