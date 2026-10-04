# Valve firmware changes

What changed in Valve's Steam Controller ("Ibex"/Triton) and Puck ("Proteus") firmware, and what it
means for OpenPuck and ReversePuck. Newest release first.

Images come from the [IbexFirmware archive](https://github.com/OpenSteamController/IbexFirmware),
which extracts them from the Steam client's `bins_hardware_all` zip. `tools/fw_inspect.py` dumps the
identity, USB and protocol fingerprints of an image and diffs two releases; run it on each new drop.

## Image layout (all releases)

- 32-byte container header: `[0x00]` build identifier, `[0x04]` payload size, `[0x08]` CRC32 of the
  payload, zero padding. The payload starts at file offset `0x20`.
- The payload is a Zephyr image linked at **`0x8000`**; the vector table is at `0x8000`.
- Image info block at `0x8100`: 8-byte magic, `0x810C` 12-char git SHA (`0xAE` tag 3), `0x8120`
  build time (u32, `0x83` tag `0x04`). Puck and controller built together share the SHA.

## Release timeline

| Channel    | First seen | Controller (`IBEX_FW_`) | Puck (`PROTEUS_FW_`) | Git SHA        |
|------------|------------|-------------------------|----------------------|----------------|
| publicbeta | 2026-10-02 | `6ABC4999`              | `6ABC4988`           | `3a5c18c37841` |
| publicbeta | 2026-09-17 | `6AA43B55`              | (`6A628359`)         | `39810c8f9d80` |
| stable     | 2026-09-02 | `6A628345`              | `6A628359`           | `fec01234c8af` |
| stable     | 2026-07-21 | `6A4D85E3`              | (`6A4423DE`)         | `26e1f7ef1955` |
| stable     | 2026-06-02 | `6A18D057`              | `6A18D053`           | `7054257d2da7` |

A parenthesised puck build is the one still current on that channel. Before this update OpenPuck
reported puck build `6A628359` (current stable). ReversePuck reported controller build `6A18D057`
(May).

## `6ABC4999` / `6ABC4988` (publicbeta, 2026-10-02)

Diffed against stable `6A628345`/`6A628359` and the intermediate controller beta `6AA43B55`. The
2026-10-04 RF capture was taken on this release.

### Controller pushes its identity over RF: `F5` (new)

At the start of every session the controller queues one `F5` reply (58-byte payload):

```text
[F5]
[0..3]   product id u32        (0x1302)
[4..7]   firmware build u32    (0x83 tag 0x04)
[8..11]  bootloader build u32  (0x83 tag 0x0A)
[12..15] board rev u32         (0x83 tag 0x09, from UICR)
[16..29] unit serial, NUL-padded   (0xAE tag 1)
[30..43] board serial, NUL-padded  (0xAE tag 0)
[44..56] git SHA + NUL             (0xAE tag 3)
```

The new puck's reply dispatcher now handles `F1`–`F5` (older pucks handled only `F1`–`F3` and silently
dropped anything else):

- `F5` is cached per slot ("Slot %u : Controller attributes").
- At connect the puck waits for the cache to fill. After roughly one second (a `0x8000`-tick timer) it
  gives up and carries on, so older controllers still work.
- With the cache filled, Steam's `0x83` and `0xAE` GETs for that slot are **answered by the puck
  locally**. The puck still relays Steam's SET to the controller, which acks it with an `F1` tag-2
  status TLV, but it no longer sends the RF GET. That matches the capture: `E3 02 01 83 00` and
  `E3 03 01 AE 01 01` are each acked with `04 02 00 00 00 00`, and no type-3 GET follows. The local
  `0x83` answer is the 30-byte form, with tag `0x0B` fixed at 4000 µs.
- `F4` from a controller is logged as "Invalid payload from controller" and ignored.

Impact:

- **OpenPuck** sees one `F5` reply per session. `rtype >= 0xF0` marks the link alive, and the frame is
  not decoded as input, so nothing breaks. Optional: cache it and answer `0x83`/`0xAE` locally like the
  real puck.
- **ReversePuck** now sends `F5` once per session (on adoption and after each `E7`), so a new puck
  enumerates it without the one-second wait or the RF GET round trips.

### IMU rewrite fills the report `0x42` quaternion

Report `0x42` bytes `[46..53]` have always been copied straight from the IMU sample (the old firmware
does the same copy). They hold the orientation quaternion **w, x, y, z as s16 Q15**. Older captures
showed identity (`7FFF 0000 0000 0000`). The new controller replaces the LSM6DSV16X sensor-fusion
driver with a Zephyr RTIO streaming pipeline ("imu_streaming_thread", "No quat data in IMU sample",
accel/gyro high-accuracy mode), and the field now carries real data. The capture holds
`D37A A5E7 1DF7 FB18`, whose norm is 32766. It freezes together with the timestamp and accel/gyro while
the IMU stream is off. The report layout and size (54 bytes) are unchanged.

### `0x80` HAPTIC_RUMBLE handler rewritten (since `6AA43B55`)

The set of OUTPUT reports (`0x80`–`0x8A`) is unchanged, but the rumble mapping changed. `type` is
ignored by every version.

| field                 | ≤ `6A628345`                                                       | `6AA43B55` / `6ABC4999` |
|-----------------------|--------------------------------------------------------------------|-------------------------|
| `intensity` u16       | global attenuation `-40 + 32*(0x8000-i)/0x8000` dB: 0 → −8 dB, `0x8000` → −40 dB, `0xFFFF` → −72 dB | exact-value lookup: 16 → +16, 60 → +12, 100 → +8, 200 → +4, 1000 → −4, 8000 → −8, 16000 → −12 dB, anything else 0 dB |
| `speed` u16 (L/R)     | mostly the vibration frequency (amplitude came from `intensity` + gain) | drives the amplitude (dB rises with speed); `6ABC4999` adds a −6 dB step below speed 1000 |
| `gain` s8 (L/R)       | added to that motor's dB                                           | not read                |

Upstream SDL (`SDL_hidapi_steam_triton.c`, 2026-10-03) sends `type=0, intensity=0`, puts the low/high
motors in `left.speed`/`right.speed`, sets the gains to 0, and resends every 40 ms (hardware safety
timeout ≈ 50 ms). OpenPuck's `hapticUpdateRumble()` sends `intensity = max(low, high)`:

- On the new firmware that is 0 dB except when it lands exactly on a table value (for example
  `max == 16` gives +16 dB).
- On older firmware it attenuates harder as the request gets stronger.

**Not changed here:** switching to `intensity = 0` matches Valve's own host code, but it also changes
feel on stable firmware, so it needs an A/B on hardware first.

### USB `bcdDevice` `0x0307` → `0x0404` (both devices)

Zephyr's default `bcdDevice` is the kernel version, so this marks the move from Zephyr 3.7 to 4.4
(next-gen USB device stack, RTIO, PSA crypto, new ESB glue). The rebase is most of the string churn,
and it shrank the puck image from 198008 to 172956 bytes. OpenPuck reports `0x0002` in puck mode.
Nothing in Steam or SDL is known to read this field.

### Puck: Steam Machine EC input tap (new descriptor)

A new 38-byte vendor HID descriptor (`IN 0x78` 5 bytes, `IN 0x7A` 2 bytes) is registered as the
"ec-input-tap" HID-over-I2C device. It feeds the Steam Machine's embedded controller:

- `0x78 [slot][buttons u32]` on every button change in `0x42`/`0x45`.
- `0x7A [slot][state]` mirroring `0x79`.

It is not one of the four USB slot interfaces; their descriptor is byte-identical to the previous
release.

### Controller-only (no RF or USB protocol impact)

- Two BLE bond slots and new `ST_*_KEYCHORD_BT_ALT` states (`6AA43B55`).
- New log line for trigger step calibration; the `0xC0` command itself existed already.

## Verified unchanged in this release

- Puck USB device: `28DE:1304`, same interface set. The slot HID descriptor (372 bytes) is
  byte-identical; OpenPuck's adds its private `0x47`.
- Puck `0x83` answer: still 25 bytes (tags `01 02 0A 04 09`), new build `0x6ABC4988`.
- `0xAE` replies are `[AE][14][…]` with 20 copied bytes on both devices.
- Feature command tables: the same 28 controller IDs and 12 puck IDs in `6A628345`, `6AA43B55` and
  `6ABC4999`. The `SET_SETTINGS_VALUES` handler has the same bounds and checks.
- RF framing:
  - The puck builds the same `E0`–`E7` frames.
  - The controller dispatches the same `E2`–`E7` and `E3` TLV types 1 (SET), 3 (GET) and 5 (OUTPUT).
    Its replies are the same apart from the added `F5`.
  - Discovery on `"ibex"`/prefix `0x10`/ch 2 and the `E1` layout are unchanged.
- Puck filtering of controller input, already present before:
  - Keyboard report `0x41` is forwarded only if it holds no modifiers and only Enter/Esc/Tab/arrows.
  - `0x60`/`0x61` are handled specially.
  - Only `0x40`–`0x46` are forwarded to Steam, and only at their descriptor length.

## Earlier change still missing from ReversePuck (`6A4D85E3`, July)

The controller's `0x83` reply grew from 25 to **30 bytes**, adding tag `0x0B`,
ATTRIB_CONNECTION_INTERVAL_IN_US:

| Transport           | Value                |
|---------------------|----------------------|
| none                | 0                    |
| BLE                 | connection interval  |
| ESB and USB         | 4000                 |
| pogo puck-interface | 64000                |

## Corrections to our earlier reading (not firmware changes)

- **`E4` payload is a channel list**, not timing control. The controller copies up to four bytes into
  its RX channel list (unused entries `0xFF`), listens on entry 0, and cycles through the others when
  the puck goes quiet. Protocol-v1 pucks send `[new ch][2][80]`; v0 sends `[new ch]` only.
  ReversePuck's hunt list already starts with 2 and 80 for this reason.
- **`E7 [a][b]` is the protocol-version handshake.**
  - The puck always sends `[00][01]`.
  - The controller accepts `a <= 1`, treats `b != 0` as v1, rejects `(1,0)` and `a >= 2` (it replies
    `F2`), and answers `F3 [ver]`.
  - The puck stores `F3` payload[1] (0 or 1) as the slot's protocol version; that is the byte
    ReversePuck must keep nonzero.
- **Report `0x42` bits 28/29** are the grip-touch bits (set from the pad/grip sensor events), not
  always-on status bits.

## Repo changes for this release

- `OpenPuck/identity.cpp`: puck and Steam Machine receiver `build_timestamp` → `0x6ABC4988`.
- `ReversePuckFirmware/identity.cpp`: controller `0x83` → 30-byte `6ABC4999` form, plus the git SHA
  (`0xAE` tag 3) → `3a5c18c37841`.
- `ReversePuckFirmware/ctrl_link.cpp`: sends the `F5` identity push.
- Comment and doc corrections for `0x42`, `E4`, `F3`/`E7` and `0xAE` length; `docs/PROTOCOL.md`.
- `docs/sniffer.html`: "hide input" also hides 57-byte (`0x42`) `F1` frames.
