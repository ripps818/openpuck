# OpenPuck Controller Protocol

This document describes the complete controller-to-puck protocol implemented by `OpenPuck.ino`.

## 1. Scope

OpenPuck emulates the Valve Steam Controller 2 "puck" dongle. There are two separate protocols:

1. USB host-facing protocol between the puck and the computer.
2. 2.4 GHz radio protocol between the puck and the controller.

Both are required for a fully compatible implementation.

## 2. Bond record

A bond slot is 24 bytes:

```text
offset  size  meaning
0x00    4     proteus_uuid / token, little-endian
0x04    4     ibex_uuid, little-endian
0x08    16    controller serial, ASCII, not null-terminated if fully filled
```

The puck stores four independent bond slots. Slot `N` is exposed as USB HID interface `N`.

An empty slot is all zeroes.

## 3. USB protocol

### 3.1 Steam-mode USB layout

Steam mode enumerates as Valve `28DE:1142` and exposes four HID interfaces with the same report descriptor as the real puck. Each interface owns one bond slot. The firmware uses the classic Steam Controller dongle PID because SDL's Steam HIDAPI driver reliably treats `0x1142` as the four-slot wireless receiver; newer puck PIDs may work in Steam but are not consistently surfaced as Steam Controllers to SDL apps. SDL also expects the Steam slot HIDs on USB interface numbers 1..4, so WebUSB is registered before the slot HIDs in puck mode to reserve interface 0.

Relevant report IDs:

- Input: `0x40`, `0x41`, `0x42`, `0x43`, `0x44`, `0x45`, `0x79`, `0x7B`
- Output: `0x80` to `0x89`
- Feature: `0x01`, `0x02`

### 3.2 Feature commands

Feature payload framing is:

```text
[cmd][len][payload...]
```


Implemented commands:

- `0x83`: `GET_ATTRIBUTES_VALUES`
- `0xAE`: `GET_STRING_ATTRIBUTE`
- `0xB4`: `DONGLE_GET_WIRELESS_STATE` (connection state for the interface's slot)
- `0xAD`: `ENABLE_PAIRING` (pairing mode enable/disable)
- `0xA2`: `TRITON_A2_OBSERVED_PAIRING_RECORD` (write or clear the interface's 24-byte bond slot)
- `0xA3`: `TRITON_A3_BOND_EVENT_OR_STATUS` (read the interface's 24-byte bond slot)

For a full list of commands the controller supports, check steam_commands.h

#### `0xB4` response

```text
[0xB4][0x01][state]
```

- `0x02`: controller connected on this slot
- `0x01`: not connected

#### `0xA2` write

`len` must be at least `24`. A zero-filled 24-byte payload clears the slot. Any non-zero valid payload writes the bond verbatim.

#### `0xA3` read

Returns:

```text
[0xA3][0x18][24-byte bond]
```

### 3.3 Host-to-controller relay

When Steam writes feature report `0x01`, OpenPuck forwards it over RF to the controller as an `E3` frame
containing a sub-TLV. There are two on-air forms:

```text
haptic   [E3][1+len][0x05][report_id][data...]             (type 05, no inner-len)
normal  [E3][2+len][0x01][report_id][innerlen][data...]    (type 01, KEEPS inner-len)
```


```text
haptic on    E3 04 05 82 01 01 F7              (report 0x82, legacy)
brightness   E3 05 01 87 03 2D <val> 00        (report 0x87 reg 0x2D, LANDING)
power-off    E3 06 01 9F 04 6F 66 66 21        (report 0x9F "off!", LANDING)
```

The relay carries the command's declared length, up to 60 bytes for type 01 commands and 63 for type 05 haptic
reports (a full OUTPUT `0x87`/`0x88` sample frame). Relays are staged in a small ring (not a single buffer): the
USB SET callbacks run in ISR context and Steam sends settings/calibration as back-to-back bursts, so a single
pending slot both drops reports and can be torn mid-flush. One queued relay is emitted per poll cycle, plus a
second in the same cycle while the ring still holds a backlog (PCM sample streams need ~258 frames/s).

### 3.4 Connection presentation (input reports `0x79` / `0x7B`)

- `0x79` (1 byte): connection state, `0x02` = connected, `0x01` = disconnected. **Edge-triggered**, like the
  real puck. OpenPuck additionally re-sends it every 750 ms after a connect edge *until Steam reacts* (its
  first OUTPUT/settings write after the edge), covering a missed edge. It must not be re-sent unconditionally:
  each `0x79=02` can re-trigger Steam's connect handling (connect chime) and loop the haptic before Steam
  starts consuming `0x45`.
- `0x7B` (12 bytes): periodic status, sent every 2 s while connected. Byte 8 is the controller→puck signal
  strength as **signed dBm** (live-captured example `0xDD` = −35 dBm). OpenPuck fills it with the smoothed
  radio RSSI sampled on each CRC-good controller reply (`RSSISAMPLE`, started by an `ADDRESS→RSSISTART`
  short during the poll RX window). The other bytes are replayed from the live capture
  (`F7 01 89 00 00 00 03 00 __ 00 3A 02`); their semantics are unconfirmed.

## 4. Radio physical layer

OpenPuck uses Nordic raw radio mode configured to match the puck firmware:

- PHY: `Ble_2Mbit`
- Dynamic-length packet format
- `PCNF0 = 0x00030008`
- `PCNF1 = 0x01040040`
- 5-byte address (`BALEN=4`)
- Big-endian
- Whitening disabled
- CRC16, address included
- Polynomial `0x11021`
- Init `0xFFFF`

CRC is standard CRC-16-CCITT over address plus payload, MSB-first.

### 4.1 Address transform

Stored address bytes are converted to on-air address bytes by bit-reversing each byte.

For the nRF `BASE0` register, the bit-reversed base bytes are then packed big-endian:

```text
BASE0 = bitrev8(base[0]) << 24 |
        bitrev8(base[1]) << 16 |
        bitrev8(base[2]) <<  8 |
        bitrev8(base[3])

PREFIX0 = bitrev8(prefix)
```

## 5. Discovery / reconnect

Discovery uses a fixed address and fixed channel:

- Base bytes: ASCII `"ibex"` = `69 62 65 78`
- Prefix: `0x10`
- Channel: `2`

The puck transmits a host frame on that address until the controller connects.

## 6. Host frame (`E1`)

OpenPuck's discovery host frame is a dynamic-length ESB payload:

```text
RAM buffer:
[0]  = 0x12                     ; payload length
[1]  = S1 byte                  ; PID in bits 1..2, no-ack bit clear
[2]  = 0xE1                     ; host-frame opcode
[3..6]   = proteus_uuid         ; 4 bytes, little-endian
[7..10]  = ibex_uuid            ; 4 bytes, little-endian
[11]     = session channel
[12..14] = 0x00 0x00 0x00
[15..18] = session base         ; 4 bytes, stored form
[19]     = session prefix
```

Semantics:

- `proteus_uuid` is the first 4 bytes of the bond record.
- `ibex_uuid` is the next 4 bytes of the bond record.
- The host chooses the connected-session channel and address and advertises them here.
- The session base/prefix are PER-BOND (one address per controller, derived from the bond UUID + the
  puck's FICR DEVICEID so two pucks that bond the same controller still isolate). The real puck
  supports up to four simultaneous controllers on the same channel; OpenPuck mirrors that.

## 7. Connected session

After discovery, the puck becomes the poll master.

### 7.1 Protocol-version handshake (`E7`)

```text
E7 [a][b]      puck -> controller   (the real puck always sends E7 00 01)
F3 [ver]       controller -> puck
```

The controller accepts `a <= 1` and treats `b != 0` as protocol v1 (`E7 00 00` selects v0). It answers
`F3 [ver]`; `(1,0)` or `a >= 2` gets `F2` (disconnect). The puck stores `ver` (0 or 1) as the slot's
protocol version; anything above 1 is rejected. OpenPuck skips the handshake by default because the
controller streams `F1` to a bare `E3` regardless.

### 7.2 Input poll (`E3`)

OpenPuck polls for report `0x45` using:

```text
E3 [len] 0x01 0x45 [param]
```

- `0x01`: GET subtype
- `0x45`: controller input report
- `param`: implementation tunable, usually `0x00` or `0x2D`

The controller replies in the ACK window.

### 7.3 Controller replies

Observed reply opcodes:

- `0xF1`: full TLV container carrying input data
- `0xF2`: disconnect / shutdown
- `0xF3`: protocol version (reply to `E7`, §7.1)
- `0xF4`: pairing reply on the private channel. A connected puck logs one as invalid.
- `0xF5`: identity push, sent once per session by controller firmware `6ABC4999`+.
  Payload: `[product u32][fw build u32][boot build u32][board rev u32][unit serial 14][board serial 14][git SHA 13]`.
  Puck firmware `6ABC4988`+ caches it and answers Steam's `0x83`/`0xAE` for that slot locally. See
  `FIRMWARE_CHANGES.md`.

#### `0xF1` container

The TLV scan starts at byte 6. Each record is:

```text
[len][tag][value...]
```

Known tags:

- `0x02`: 4-byte result of a relayed feature SET (s32, 0 = OK)
- `0x04`: feature GET response (up to 63 bytes)
- `0x06`: embedded HID report

For controller input, the embedded report is `0x42` (current firmware) or `0x45`.

### 7.4 Channel list (`E4`)

```text
E4 [ch0][ch1][ch2][ch3]     up to four channels; omitted entries read as 0xFF
```

The controller listens on `ch0` and cycles through the other entries while the puck is silent. Protocol-v1
pucks send `[new ch][2][80]`; v0 sends `[new ch]` only.

## 8. Report `0x45` / `0x42` layout

Report `0x45` is 46 bytes. Report `0x42` is 54 bytes: the same layout for bytes `0x00`–`0x2D`, followed by
the orientation quaternion.

```text
offset  size  meaning
0x00    1     report id = 0x45
0x01    1     sequence
0x02    4     buttons, little-endian u32
0x06    2     left trigger, u16
0x08    2     right trigger, u16
0x0A    2     left stick X, s16
0x0C    2     left stick Y, s16
0x0E    2     right stick X, s16
0x10    2     right stick Y, s16
0x12    2     left pad X, s16
0x14    2     left pad Y, s16
0x16    2     left pad press, s16
0x18    2     right pad X, s16
0x1A    2     right pad Y, s16
0x1C    2     right pad press, s16
0x1E    4     IMU timestamp, u32
0x22    2     accel X, s16
0x24    2     accel Y, s16
0x26    2     accel Z, s16
0x28    2     gyro X, s16
0x2A    2     gyro Y, s16
0x2C    2     gyro Z, s16
0x2E    8     (0x42 only) orientation quaternion w, x, y, z, s16 Q15 (0x7FFF = 1.0)
```

### 8.1 Button bitfield

```text
0x00000001 A
0x00000002 B
0x00000004 X
0x00000008 Y
0x00000010 QAM
0x00000020 R3
0x00000040 View
0x00000080 R4
0x00000100 R5
0x00000200 RB
0x00000400 D-pad down
0x00000800 D-pad right
0x00001000 D-pad left
0x00002000 D-pad up
0x00004000 Menu
0x00008000 L3
0x00010000 Steam
0x00020000 L4
0x00040000 L5
0x00080000 LB
0x00100000 right stick touch
0x00200000 right pad touch
0x00400000 right pad click
0x00800000 right trigger click
0x01000000 left stick touch
0x02000000 left pad touch
0x04000000 left pad click
0x08000000 left trigger click
0x10000000 right grip touch
0x20000000 left grip touch
```

## 9. USB presentation modes

The RF side stays the same across modes. Only USB enumeration changes.

Modes (`MODE_*` in `config.h`):

| # | Mode | VID:PID | Extra interfaces |
|---|---|---|---|
| 0 | Steam | `28DE:1304` (`28DE:1305` as a Steam Machine internal receiver) | WebUSB + wake mouse |
| 1 | Xbox 360 | `045E:028E` | WebUSB + wake mouse |
| 2 | Switch HORIPAD | `0F0D:0092` | WebUSB + wake mouse |
| 3 | Lizard | as Steam | as Steam |
| 4 | Switch Pro | `057E:2009` | WebUSB + wake mouse |
| 5 | PS5 DualSense | `054C:0CE6` | WebUSB + UAC1 audio function |
| 6 | PS4 DualShock | `054C:05C4` | WebUSB |
| 7 | PS5 DualSense (single HID) | `054C:0CE6` | UAC1 audio function only |
| 8 | PS4 DualShock (single HID) | `054C:05C4` | none |
| 9 | PS3 DualShock | `054C:0268` | none |
| 10 | Original Xbox | `045E:0289` | WebUSB + wake mouse |
| 11 | DirectInput | `1209:4F50` | WebUSB + wake mouse |
| 12 | SInput | `2E8A:10C6` | WebUSB + wake mouse |

The CDC serial console is present only in the puck modes, and only for one boot after the debug-CDC arm
(it replaces the wake mouse). The PlayStation modes drop the wake mouse; the single-HID modes and PS3 also
drop WebUSB so games and the PS3 console see a single-HID Sony pad. Every boot/mode switch does a
`detach -> rebuild -> attach` so the host re-reads the descriptor cleanly. Emulated modes other than PS3 and
Original Xbox mount only the controllers that are connected and re-enumerate, without a reboot, when that
set changes (`usb_mount.cpp`).

### 9.1 Steam mode

- VID:PID `28DE:1304`, or `28DE:1305` when emulating a Steam Machine's internal receiver (WebUSB field `29`)
- Four puck HID interfaces + WebUSB + wake mouse (CDC instead of the wake mouse for one boot after the debug arm)
- `0x45` reports are forwarded to the connected slot's HID interface
- **Seamless lizard**: when Steam is driving the device, `0x45` is forwarded; when it isn't
  (Steam closed, 7 s watchdog) the same `0x45` is translated into mouse (`0x40`) + keyboard (`0x41`)
  reports on the **same** puck interface, so the device is a driverless desktop keyboard+mouse with no
  mode switch. This is purely USB-side; the RF poll and relay are unchanged. Lizard mode (3) is the
  same presentation pinned to keyboard+mouse even while Steam is running.
- **"Steam is driving" signal**: *any* Steam OUTPUT/settings report (`0x80`–`0x89`, e.g. the `0x87`
  lizard-off heartbeat, LED, or a `0x82` haptic) refreshes the watchdog — not just `0x87`. This makes
  the puck leave lizard for gamepad on Steam's **first** contact, even if that first packet is a haptic
  that arrives before the heartbeat.
- **Haptics are gated on this decision**: haptic reports are **never** relayed to the controller while
  the puck is presenting lizard. Relaying haptics while Steam isn't reading `0x45` back made Steam loop
  the same command, leaving the controller buzzing; suppressing them keeps the lizard state clean. The
  same gate applies during the post-resume input mute (`POST_RESUME_MUTE_MS`): Steam can't read `0x45`
  back in that window either, so a wake-time haptic would loop identically.
- **Which OUTPUT reports are relayed**: all haptic/actuator reports `0x80`–`0x89` are forwarded to the
  **connected slot only** (the slot gate is what stops a haptic aimed at another of the four exposed
  slots from buzzing the single controller). The 63-byte `0x87`/`0x88`/`0x89` are raw haptic sample
  streams (table below), used by audio-to-haptics apps. The real puck forwards every OUTPUT report
  unfiltered. Separately, the feature-`0x01` command `0x87` (`SET_SETTINGS_VALUES`, the lizard-off
  heartbeat) is a sequence of `[setting][value u16 LE]` tuples; OpenPuck removes setting `0x30`
  (`IMU_MODE`) and any incomplete trailing tuple before relaying it.
  Steam writes IMU mode for its native puck path, but landing that write disables the controller's RF
  motion stream, which every gyro-capable emulated mode still needs. Additionally, Switch Pro mode
  writes raw accelerometer + gyroscope (`0x18`) when the RF link comes up to clear any retained
  IMU-off state. Restricting haptics to `0x82` alone silently dropped the ping/grip/test haptics,
  which use other report IDs.

#### ⚠️ Two different `0x8x` id spaces — never share a rule between them

Steam drives the actuators through the Triton **OUTPUT report** space, which is a *different* id space
from the feature-`0x01` **command** space even though the numbers overlap. Ground truth: SDL
`src/joystick/hidapi/steam/controller_structs.h` (`ValveTritonOutReportMessageIDs`) and
`controller_constants.h`. The payload sizes match this firmware's report descriptor exactly:

| id | OUTPUT report (haptics/actuators) | payload | feature `0x01` command |
|----|-----------------------------------|---------|------------------------|
| `0x80` | `HAPTIC_RUMBLE` `[type][intensity u16][{speed u16,gain}L][{…}R]` | 9 | `SET_DIGITAL_MAPPINGS` |
| `0x81` | `HAPTIC_PULSE` `[side][on_us u16][off_us u16][repeat u16]` | 7 | `CLEAR_DIGITAL_MAPPINGS` |
| `0x82` | `HAPTIC_COMMAND` `[side][command][gain_db]` | 3 | `GET_DIGITAL_MAPPINGS` |
| `0x83` | `HAPTIC_LFO_TONE` `[side][gain_db][freq u16][dur u16][lfo_freq u16][lfo_depth]` | 9 | `GET_ATTRIBUTES_VALUES` |
| `0x84` | `HAPTIC_LOG_SWEEP` `[side][gain_db][dur u16][start u16][end u16]` | 8 | `GET_ATTRIBUTE_LABEL` |
| `0x85` | `HAPTIC_SCRIPT` `[side][script_id][gain_db]` | 3 | `SET_DEFAULT_DIGITAL_MAPPINGS` |
| `0x86` | PCM mode `[op][channel][format]`: op 2 enables with format (0-3 16-bit, 4-7 8-bit, 8-11 u-law, each 8/4/2/1 kHz), op 1 sends the stream a stop message; channel 1 right grip, 2 both grips, 3 left touchpad, 4 right touchpad, 5 both touchpads | 3 | `FACTORY_RESET` |
| `0x87` | mono sample stream `[target][samples]`: target 0 left grip, 2 or `0x80` both grips, 3 left touchpad, 4 right grip, 5 both touchpads (1 and the right touchpad alone are not addressable) | 63 | `SET_SETTINGS_VALUES` |
| `0x88` | stereo **grip** stream `[n<=31][31 samples left grip][31 samples right grip]` in the `0x86` format | 63 | `CLEAR_SETTINGS_VALUES` |
| `0x89` | length-prefixed `0x87`: `[len][0x87 payload]` | 63 | `GET_SETTINGS_VALUES` |

PCM streaming, measured with the controller's IMU over USB (2026-10-03):
- `0x86` sets the sample format, and the format persists. Op 1 does not stop playback, and channel 5 measured the
  same as channel 2. OpenPuck sends `{2, 2, 9}` (4 kHz u-law) once at the start of each stream. Re-sending it
  mid-stream made the grips stutter about once a second (2026-10-12). A controller whose link drops comes back
  without the format, so OpenPuck restarts that controller's stream, with a fresh `0x86`, once it returns.
- The controller has four LRAs in two groups: one under each trackpad, and a higher-output one in each grip.
  Routing, as the controller firmware (`6ABC4999`) handles each report:
  - `0x80` rumble plays on **both grips**.
  - `0x82` / `0x83` side (bit 7 ignored): 0 left touchpad, 1 right touchpad, 2 both touchpads, 3 left grip,
    4 right grip, 5 both grips. `0x81` is the same except 0 = right touchpad and 1 = left touchpad.
  - The `0x82` command byte is a haptic script ID, 1..17 (a table of waveform step lists). Steam plays its
    movement ticks as script 1 and its click as script 2, which opens with the same four steps and adds a longer
    tail. Steam applies its 0-12 dB strength slider host-side as the gain byte (click: slider - 17 dB), not as a
    controller setting. Controller setting 76 is `haptic_master_gain_db` (-3, -24..6) and 75 the amplifier mode;
    Steam also writes `user/haptic_boot_level` (op `0xDC` `01 <level>`, level 2) on every connect.
  - `0x88` PCM plays on the **grips** (first half left, second half right); `0x87` / `0x89` as in the table.
  So OpenPuck's DualSense wave style streams to the grips, where a real DualSense has its actuators too.
- The controller pre-buffers about 40 ms (onset ~43 ms against ~16 ms for a `0x83` tone). It rides out 124 ms bursts
  and 0-20 ms jitter without a dip, and falls silent by itself 60-85 ms later than a tone once frames stop
  (op 1 at the stop trims that to about 50 ms).
  The playback clock does not drift against 4 kHz pacing. `0x82` does not cut a stream.
- Start and underrun, read from the controller firmware: each channel plays in 8 ms blocks (grips at 8 kHz, touchpads
  at 4 kHz), and a stream starts on the first frame to arrive once more than two blocks (16 ms) of samples are
  queued, at any format. That fill then stays queued for the whole stream. Running dry stops the stream, and the
  next frames wait for 16 ms again. With 31-sample 4 kHz frames, playback starts at 124 samples (31 ms). OpenPuck
  makes the third frame of each stream 3 samples (`n` = 3, same 63-byte layout) so it starts at 96 (24 ms).
  Measured through OpenPuck in Steam mode (20 runs each, 2026-10-04): IMU onset median 61 ms with full frames,
  54 ms with the short third frame.
- The controller reports stream events as input report `0x44 [channel][event]` (channel 0 left, 1 right grip).
  Event `0x02` = the stream ran dry and stopped; it arrives ~30-45 ms after the last frame. The firmware also
  defines events for format accepted, bad format, already playing, buffer low, buffer high and overflow. Six 3 s
  streams over RF, with either start, showed no mid-stream `0x02`.
- Level: a u-law sample amplitude of about 0.4 (0.31 at 100 Hz, 0.49 at 320 Hz) matches a -3 dB `0x83` tone.
- Grip linearity, measured with the controller resting on a table (2026-10-12): vibration rises in proportion to
  the sample amplitude up to about 0.7 of full scale, eases off toward full scale, and clips past it. Driving
  about twice full scale (two full bands at 200% grip strength) makes the grips audibly grind. OpenPuck therefore
  caps the Switch wave style at 100% grip strength and the DualSense wave style at 250% haptic gain. A soft-limit
  knee of 85 costs no measurable strength, while 70 costs 3-5% near the top; two blind A/B tests (steady and
  swept) found no audible difference, with 85 preferred. On the DualSense at 250% gain, a blind swept A/B with no
  dropped packets or underruns felt 85 and 100 alike and 70 weaker; 85 stays the default as headroom for peaks.
- An 8 kHz stereo stream is 258 frames/s, above one relay per 4 ms poll. OpenPuck flushes a second queued relay in
  the same cycle when the ring holds a backlog, and resends an unanswered `0x86`-`0x89` frame once with the same PID.
  A frame still unanswered goes back to the front of the ring for up to two later cycles: a lost frame would take its
  samples out of the stream's fill for good, and two or three losses run it dry. A retry on a later cycle carries
  a new PID, so if the first copy did land, the controller plays the frame twice.
- **Replies to PCM frames** (measured with the `0x35` counters, 2026-10-12). The controller answers every packet in
  its ESB ACK. The ACK is empty when the controller has nothing queued and ends within ~200 us; otherwise it carries
  an `F1` packed with queued reports (its `0x44` stream events among them) up to 127 bytes, ending ~800-1000 us after
  the frame. Either kind, with a good CRC, means the frame arrived. OpenPuck waits up to 1200 us after a PCM frame
  and counts an empty ACK as delivered. With the old 400 us window and only replies with data counted, about 80% of
  frames were resent and many played twice; the controller then sent `0x44` events `0x08` and `0x01` by the
  thousand. Both vanish once nothing is duplicated, so they are probably "buffer high" and "frame dropped" (not
  confirmed in its firmware). `0x00` arrives once per grip at each stream start (format accepted).
- **TX to RX turnaround in hardware.** The controller's ACK follows ~130 us after a frame. In DualSense mode the
  USB audio processing runs in the TinyUSB task, above the main loop, and when it preempted the loop between the end
  of TX and a software RXEN, 83% of PCM frames got no reply. The radio now switches to RX by itself
  (`DISABLED` -> `RXEN` shortcut), the RX buffer goes in once TX has started (`PACKETPTR` is read at `START`), and a
  reply is detected by `CRCOK`/`CRCERROR`, which only a received packet raises. Afterwards: 1% unanswered, 250
  polls/s (207 before).
- **Send timing.** The controller's fill covers ~15.5 ms of lateness. A frame later than that, measured against a
  steady sample clock from the stream's first frame, runs the stream dry mid-play. Two causes found in DualSense
  mode (2026-10-12):
  - A PCM frame's ACK often carries the controller's input, so the poll right after it gets an empty ACK. The poll
    loop counted that as a missed poll and skipped the next relay turn (~90 times/s), holding frames a cycle: send
    times spread ~14 ms and streams ran dry. An empty ACK with a good CRC now counts as a reply: no skips, spread
    ~9-12 ms, no mid-stream underruns.
  - The nRF5x USB driver drops an ISO OUT packet without an error when no transfer is armed at its SOF. The audio
    callback re-armed only after its DSP, so a slow packet lost the next one: 1 ms cut from the wave, felt as a
    tick. The callback now arms a second buffer first; every packet arrives.
  - A flash write (a settings save) while the stream plays can wedge the ISO OUT endpoint: the driver keeps a
    transfer pending, refuses every re-arm, and drops every packet until a bus reset. A game then loses the Wave
    style for good (style switches in the panel did this). Settings changed while the audio interface is at alt 1
    apply at once and are saved once it leaves alt 1 (or before a reboot). A watchdog also re-arms the endpoint
    when alt 1 has gone 50 ms without a packet.
- A stream that has gone silent is left to run dry. A `0x86` op 1 or a `-128 dB` `0x83` cut sent to an idle actuator
  plays as a click, so OpenPuck sends them only while something may still be playing.


### 9.2 Xbox mode

- VID:PID `045E:028E`
- Right-pad HID boot mouse, then one custom XInput-compatible vendor interface per connected controller;
  the wake mouse and WebUSB are added around them
- `0x45` is converted into a 20-byte XInput report

### 9.3 Switch mode

- VID:PID `0F0D:0092` (HORI Pokkén Tournament Pro Pad), plus WebUSB and the wake mouse
- One HID interface per controller with the canonical HORIPAD descriptor (interrupt IN + OUT endpoints), accepted by
  a real Switch console with no handshake; an 8-byte report is streamed at ~250 Hz

### 9.4 Original Xbox mode

- VID:PID `045E:0289` (Microsoft Controller S). Composite: the XID interface plus the wake mouse and
  the WebUSB panel, so the config panel stays reachable on a PC
- Proprietary XID interface (class `0x58`, subclass `0x42`, protocol `0x00`) with interrupt IN +
  OUT endpoints; 20-byte input reports, rumble applied from the OUT endpoint
- The console refuses the controller until three `0xC1` vendor control requests are answered:
  `bRequest 0x06` / `wValue 0x4200` (XID descriptor), and `bRequest 0x01` with `wValue 0x0100` /
  `0x0200` (input and output capabilities)
- Also answers the XID report requests the protocol carries on EP0, in parallel with the interrupt
  endpoints: `GET_REPORT` (`0xA1 0x01`, `wValue 0x0100`) and `SET_REPORT` (`0x21 0x09`, `wValue 0x0200`)

## 10. WebUSB control channel

The WebUSB vendor interface is present in every mode except the single-HID PlayStation modes and PS3
(§9). From those, use the mode shortcut (modifier + A) to get back to Steam mode and the panel.

Messages:

- Host to device:
  - `0x01`: get status blob
  - `0x02 <field> <value>`: set one field. Notable fields: `22` host-rumble strength as **percent/2**
    (10–500%, revived in blob version 21; from version 25 the active type's), `39` was the host-rumble style
    and is ignored: the style follows the mode (HD in Switch Pro mode, normal elsewhere; status blob `p[195]`
    reports it), `38` Switch Pro gyro mapping,
    `32` primary LED behavior mode (0 connection status, 1 heartbeat, 2 wake only, 3 off/stealth, 4 on),
    `33` primary LED pin A, `90` secondary LED pin B, `91` primary LED polarity (1 active high, 0 active low),
    `92` LED test flash (temporary 2-second pulse), `93` secondary LED behavior mode (0..4),
    `94` secondary LED polarity (1 active high, 0 active low).
    `29` Steam-mode identity: nonzero emulates a Steam Machine's internal receiver (`28DE:1305`) instead of the
    puck (`28DE:1304`); takes effect on the next enumeration.
    DualSense audio haptics: `31` on/off, `30` gain as percent/2 (10-500%, 0 = automatic), `88` style
    (0 rumble, 1 tone, 2 split, 3 wave; default 3). See DUALSENSE_HAPTICS.md.
    RF recovery (reply is an `0xAD` frame, not a status blob; nothing is saved except by `100`): `97 <page+1>`
    request RF status (the value picks the `0xAD` v2 row page; older firmware ignores it), `98` run an ambient
    channel survey, `99 <ch>` hop to an enabled channel, `100 <ch>` save an enabled channel as the startup
    channel, `101` start (1) / cancel (0) the journal builder, `113` clear the RF journal (applied once no
    controller is live). The fields other than `97` answer with the first page.
    Switch Pro / HD rumble / shortcuts (blob version ≥ 23): `190`-`229` were the removed Switch Pro
    back-button profiles and are ignored (still answered with a status blob), `230` trackpad D-pad click
    feedback, `231` HD trackpad strength as percent/2, `239` Quick Access + Select target, `240` shortcut
    flags (bit0 QAM modifier, bits 1-2 unused (were profiles / D-pad haptic shortcuts; cleared), bit3
    confirmation pulses, bit4 QAM + Select, bit5 enabled). `241`-`252` were the removed D-pad haptic
    shortcut presets / strength steps / slots and are ignored.
    Per-type grip strength (blob version >= 25): `108`-`111` as percent/2 for emulated types 0-3 (Xbox,
    Switch, DS4, DS5); `104`-`107` (a per-type rumble style during development) are ignored. Status blob
    `p[212..215]` (payload bytes 210..213) report all four. `p[210]` (Create as touchpad click, v29) and `p[211]`
    (active mapping profiles, v30) are zero on older firmware, as `p[209]` is before v27. With profiles, field
    `116` (Create as touchpad click) sets or clears target `16` on the Create entry (source `8`) of the active
    DualSense profile, and `p[210]` reports whether that entry is `16`; the panel's **Create = touchpad click**
    button writes that entry directly.
    Controller speaker (blob version >= 26): `114` DualSense speaker volume as percent/2, 0 = off (default),
    up to 200%. Status blob `p[208]` (payload byte 206). See DUALSENSE_HAPTICS.md §7.
    Grip limiter (blob version >= 27): `115` soft-limit knee of the grip PCM stream, percent of full scale,
    50..100 (70 default, 100 = off: hard clip only); other values are ignored. It started as one setting for
    DualSense audio haptics and speaker and Switch HD rumble grips; from version 30 each type has its own (below),
    field 115 still sets both the Switch's and the DualSense's, and status blob `p[209]` (payload byte 207) reports
    the active type's.
    Per-type haptic settings (blob version >= 30): one grid of six settings by four types (Xbox, Switch, DS4, DS5).
    Setting `k` of type `t` is field `120 + 4k + t` and status blob `p[216 + 4k + t]` (payload byte `214 + 4k + t`),
    and the config file keeps the same grid in its tail. A write that is out of range, or for a type without the
    setting, is ignored. A config from the v29 release has no grid: the limiter and the DualSense style start from
    the shared values it kept (`115`, `88`), the rest from the defaults.

    | k | setting | types | values | default |
    |---|---|---|---|---|
    | 0 | grip limiter knee, % of full scale | Switch, DS5 | 50-100 (100 = off) | 85 |
    | 1 | haptic style | Switch, DS5 | `0` rumble, `1` tone, `2` split, `3` wave | wave |
    | 2 | trackpad click gain step | all | 0-31 = -20 to -1 dB, then +1 to +12 dB (0 dB is skipped: gain byte 0 is the legacy haptic stop) | 26 (+7 dB) |
    | 3 | movement-tick spacing | all | 0 = the controller plays its own ticks, 1-4 = the puck plays them, 11000 / 5500 / 2500 / 1500 units of pad travel apart | 0 |
    | 4 | movement-tick gain step | all | as setting 2 | 11 (-9 dB) |
    | 5 | soft boost of the grip wave stream | Switch, DS5 | `0` off, `1`-`3` raise quiet passages by up to 2× / 3× / 4× | 1 |

    Soft boost is an upward compressor on the PCM stream to the grips (Wave style). It follows the louder grip's
    peak level (instant rise, ~80 ms fall) and, below 20% of full scale, raises it 2:1 toward that level, capped
    by the setting; louder passages pass unchanged to the limiter. Below 0.3% of full scale the boost fades out, so
    noise in a quiet track stays quiet. The grips play down to ~0.5% of full scale in proportion (IMU), but a
    hand barely feels a few percent. Firmware before it sends a shorter status blob (no `p[236..239]`).

    Ticks and clicks apply with Trackpad haptics On; Clicks only has no ticks. With a tick spacing set, the puck
    plays both as `0x82` pulses at the gains above and sets the controller's tick spacing (controller setting 14)
    to its maximum and its trackpad click pressures (settings 52 and 53) to -1, which turns off its own tick and
    click pulse; going back to 0 writes 5500 and 40, and so does the first pass after a connect (also in the puck modes), because the controller keeps its settings while powered and an earlier take-over would linger. Ticks pause while a pad is clicked and for 150 ms after.
    The controller's firmware table (`6ABC4999`) gives setting 14 a default of 5500 and a range of 0-32767, and
    a click pressure of -1 means no click pulse; the tick event carries no gain, which is why the strength is the
    puck's to set. The spacing units are the trackpad's own int16 coordinates.

    The haptic style of the DualSense is the audio haptics style that `88` set (`88` still sets it; `p[205]` reports
    it). On the Switch it sets how the grips play HD rumble: wave streams both bands as PCM, tone plays each side's
    stronger band as a `0x83` grip tone, split plays the low band as `0x80` rumble and the high band as a grip tone,
    rumble plays each side's stronger band as `0x80` rumble; the pads always play the high band as tones.
    Triggers (blob version >= 24): `102` deadzone % and `103` full-press % for the emulated modes. Travel at or
    below the deadzone reads 0, travel at or past the full-press point reads 255, linear between; 0/100 is
    raw. An edit that would put the deadzone at or above the full-press point is refused. Status blob
    `p[206]`/`p[207]` (payload bytes 204/205).
  - `0x03 <mode>`: switch mode and reboot
  - `0x07`: re-init haptics (clear a stuck buzz)
  - `0x08`: send controller power-off
  - `0x16`: test rumble — buzz every linked controller at the current mode's strength for 500 ms,
    auto-stopped by the firmware. **Requires status-blob version ≥ 21**; older firmware drops it silently
    (the parser only accepts `0x01`–`0x15` and `0x20`–`0x25`).
  - `0x09`: export all bond slots (reply: `0xA7` frame) — see §10.1
  - `0x27`: get the Switch Pro / HD rumble / shortcut settings (reply: `0xAE` frame).
    **Requires status-blob version ≥ 23.**
  - `0x28`: save the live settings to `cfg.bin` and reply with a status blob
  - `0x0A 0x45 0x52 0x53`: factory erase (`"ERS"` magic), then reboot
  - `0x0B` / `0x0C`: reboot into serial DFU / UF2 bootloader
  - `0x0D <slot> <used> <24-byte rec>`: write one bond slot into RAM — see §10.1
  - `0x0E <mode>`: commit imported bonds (+ apply mode, `0xFF` = unchanged), then reboot
  - `0x11`: get the lizard binding map (device replies `0xAA`). **Requires status-blob version ≥ 16** —
    older firmware drops the unknown op silently and never replies, so a host that issues a blocking read
    for the `0xAA` frame would hang the shared endpoint. The panel gates all `0x11`–`0x15` sends on the
    version byte (`0xA5` payload byte 0) reaching 16 first.
  - `0x13 <count>`: begin a lizard-map edit — set the binding count
  - `0x12 <idx> <16-byte binding>`: set one lizard binding (see below)
  - `0x14`: commit the edited lizard map to flash (device echoes `0xAA`)
  - `0x15`: reset the lizard map to built-in defaults (device echoes `0xAA`)
  - `0x17`-`0x1A` (status-blob version ≥ 21): the same lizard-map operations with the native **24-byte**
    binding (64-bit masks, see below), replying with a 24-byte-record `0xAA` frame: `0x17` dump,
    `0x18 <idx> <24-byte binding>` set one, `0x19` commit to flash, `0x1A` reset to defaults. The 16-byte
    ops above use the legacy 32-bit masks, where bits 28-31 are the left-stick directions; the firmware
    translates them to and from the 64-bit form, so the right-stick triggers are reachable only through v2.
  - Which map the lizard ops edit: from status-blob version 28, always the **saved** map. In Lizard
    mode that is the live map. Every other mode runs the built-in defaults (Steam-mode seamless lizard), so
    the ops work on a separate copy loaded from flash, and committing it leaves the running defaults alone.
    Before version 28 the ops edited the running map in every mode, so outside Lizard mode a dump returned
    the defaults and a commit saved them over the user's map. From version 30 there are three Lizard profiles
    (type `4` below): the ops edit the one chosen with `0x34`, and until then (and on a host that never sends
    it) the active one. The puck keeps the choice until it reboots.
  - `0x29` (status-blob version ≥ 28): turn on IMU streaming (`SETTING_IMU_MODE` = `0x07`) on every linked
    controller, sent three times because the RF relay is no-ack. The emulated modes do this at connect; Steam
    and Lizard modes never do, so there the panel's raw motion readout stays zero until this is sent. No reply.
  - `0x2A <slot>` (status-blob version ≥ 28): one controller's live motion sample, replying with an `0xAF`
    frame: `[ver=1][slot][linkUp]` then `ax ay az gx gy gz` and the report-`0x42` orientation quaternion
    `qw qx qy qz` (Q15), all s16 LE. The quaternion reads all zero until the controller sends `0x42`; older
    controller firmware sends identity. The panel polls it at about 25 Hz for its 3D motion view.
  - `0x2B <mask: 5 bytes LE>` (status-blob version ≥ 29): set the enabled RF recovery channels, bit `i` =
    channel `4 + 2i` (every even channel 4..80, 39 bits). Automatic recovery, the journal builder and the
    `99` / `100` RF fields use only enabled channels; the ambient survey and the journal cover all 39. An
    empty mask, a bit past 38, or a write while the journal builder runs is refused. Saved in `cfg.bin`
    (default: the original 14-channel pool 18, 20, 22, 34, 42, 46, 52, 56, 68, 70, 72, 74, 76, 80). Replies
    with an `0xAD` frame, which carries the mask in force. Firmware that predates it answers `0xAD` version 1;
    send it only once an `0xAD` version 2 frame has been seen.
  - `0x2C`–`0x34` (status-blob version ≥ 30): button-mapping profiles. Each emulated type (`0` Xbox, `1`
    Switch, `2` DS4, `3` DS5, the same order as the per-type block of the status blob) keeps three profiles,
    numbered `0`-`2`, and one of them is active. Type `4` is Lizard mode's three binding maps (below). A profile is a map of one **target code** per **source** plus
    the two trackpad -> stick settings. Every op below is answered with that type's `0xB0` frame, so an
    argument out of range changes nothing and shows as unchanged.
    - `0x2C <type>`: send the type's profiles.
    - `0x2D <type> <profile> <source> <target>`: set one map entry.
    - `0x2E <type> <profile>`: toggle the Nintendo layout, i.e. overwrite the four face-button entries (A, B,
      X, Y) with the pairs exchanged, or, when they already are, with each button as itself. Nothing else in
      the profile changes. A panel reads which of the two it will do from the profile it holds.
    - `0x2F <type> <profile>`: reset the profile to the type's defaults (the Switch type starts with the
      Nintendo layout and QAM on Capture).
    - `0x30 <type> <profile>`: make it the active profile.
    - `0x31 <type> <profile> <pad> <value>`: trackpad -> stick for `pad` 0 (left) / 1 (right); the values are
      those of fields 80-87.
    - `0x32 <type> <from> <to>`: copy a profile over another.
    - `0x33 <type> <enabled> <prev> <next>`: the profile-switch gesture. With the shortcut modifier held (all
      four back buttons, or Quick Access, as set in the Mode shortcuts card), the `prev` / `next` source steps
      the running type's active profile, wrapping, and the controller buzzes the new profile's number (1-3)
      even when shortcut feedback is off. The two buttons are hidden from the host while the modifier is held.
      It is a puck-wide setting (`type` only addresses the reply), works whether or not the Mode shortcuts are
      on. In Lizard mode it steps the Lizard profile; in Steam, DirectInput and SInput mode it does nothing.
      `enabled` is 0 or 1 (default 1);
      `prev` / `next` must differ and be LB (`4`), RB (`5`), L3 (`6`), R3 (`7`), Select-side (`8`) or Start-side
      (`9`), which no shortcut uses (default LB / RB). A refused value changes nothing.

    Sources (index in the map, in order): `0` A, `1` B, `2` X, `3` Y, `4` LB, `5` RB, `6` L3, `7` R3,
    `8` Select-side button (Xbox Back, Switch Minus, PlayStation Create), `9` Start-side button, `10` Steam,
    `11`-`14` D-pad up / down / left / right, `15`-`18` L4 / R4 / L5 / R5, `19` QAM, `20` / `21` left / right
    trackpad click, `22` / `23` the left / right trigger's digital full-pull click.

    Target codes: `0` none, `1`-`4` A / B / X / Y, `5`-`8` LB / RB / L3 / R3, `9` Select-side, `10` Start-side,
    `11` Steam, `12`-`15` D-pad up / down / left / right, `16` PlayStation touchpad click, `17` PlayStation
    mute, `18` Switch Capture, `19` / `20` LT / RT, `21` / `22` left / right trackpad click. `23`-`127` are
    reserved and `128`-`255` are reserved for macro slots; a code the running mode cannot express acts as none,
    and is kept as stored. Targets are the buttons a source *acts as*: with the Nintendo layout, source A holds
    target `2`. The trackpad-click targets do something only where the mode has a pointer: the PlayStation modes
    press the touchpad on that half (`16` presses it with no position), Xbox 360 mode clicks its mouse (`22` the
    left button, `21` the right; the mouse reads the mapped buttons, so any source can click) and every other
    mode ignores them. A panel offers them on those types only.

    The older per-type fields (`4`-`8`, `21`, `40`-`75`) keep working and edit the **active** profile: paddle
    and QAM codes are read and written as the user chose them, and the swap field sets or clears the Nintendo
    layout and re-reads the paddle / QAM codes through it, as it always did. The status blob's per-type bytes
    report the same view of the active profile, and its swap byte is set while the four face entries are
    exchanged. Blob byte `211` (firmware index; `209` in the payload the panel reads) holds the active profile
    of each type, two bits each with the Xbox type in the lowest, so a profile switched on the controller
    shows without asking. A profile edited another way (a face button or paddle with a target the older fields cannot
    express) keeps that entry when an older field changes a different one.

    Lizard profiles (type `4`): each is a whole lizard binding map, edited through the lizard ops above, so
    of the ops here only `0x2C` (dump), `0x2F` (reset to the built-in default map), `0x30` (select) and `0x32`
    (copy) apply; the others are refused. `0x34 <profile>` chooses the profile the lizard ops edit and is
    answered with the type-4 `0xB0` frame. Profile `0` is stored in `/lizard_map.bin`, the file older firmware
    reads, and profiles `1` and `2` in files of their own, first written as copies of profile `0`. In Lizard
    mode the active one is the live map; selecting another loads it at once. The active Lizard profile is byte
    47 of the `0xAE` payload, so a switch made on the controller shows on the next poll.
  - `0x35`: grip PCM stream counters since boot, replying with an `0xB1` frame (debug; read by
    `tools/switch_hd_test.py --diag`). No status-blob version gates it: older firmware ignores the op.
  - `0x36`: grip pan test. A 160 + 320 Hz tone panned left-right-left on a 2 s cycle for 4 s. In Switch Pro
    mode with HD rumble it goes through the HD path and the Switch haptic style; in any other mode the puck streams
    it to the grips as PCM (`0x86`/`0x88`), skipping a controller the DualSense audio stream already feeds.
    Firmware before this change does nothing outside Switch Pro HD mode, and older firmware ignores the op. No
    reply.
  - `0x20`–`0x24`: staged firmware update (begin/data/end/reboot/abort), acked with `0xAB` frames
  - `0x25 0x57 0x49 0x50 0x45`: **full board wipe** (`"WIPE"` magic, debug panel only). Erases the app
    region + LittleFS (settings + bonds) + bootloader-settings page and reboots app-less, so the board mounts
    as the UF2 bootloader drive on **every** boot until firmware is flashed again. Unlike `0x0A` (factory
    reset, which keeps the firmware), this leaves no trace of OpenPuck. Irreversible without re-flashing.
- Device to host:
  - `0xA5 <len> <payload>`: status blob
  - `0xA7 <len> <payload>`: bond export (§10.1)
  - `0xA8 ...`: flight-recorder stream
  - `0xA9 ...`: live wedge report
  - `0xAA <count> <count×16-byte bindings>`: lizard binding map
  - `0xAB 5 <status> <nextOff u32 LE>`: firmware-update ack
  - `0xAD <len> <payload>`: RF recovery status (current/target/startup channel, per-channel survey rows,
    handoff and journal-builder progress); layout in `webusbSendRfStatus()` (`webusb_config.cpp`).
    Version 1 (`payload[0]` = 1) lists the fixed 14-channel pool in one frame. Version 2 (status-blob
    version ≥ 29) covers all 39 even channels 4..80 and pages them, 13 rows per frame:
    `[2][flags][cur][target][startup][channelCount][journalWrites][ambientGen u16][journalSeq u32]`
    `[rowStart][rowCount][rowCount × 9-byte rows][the 29 v1 trailer bytes][enabled mask: 5 B LE]`
    `[default mask: 5 B LE]`. In v2 the journal-builder index is a candidate index (channel `4 + 2i`), and
    the startup channel is the one the next boot uses (a saved channel that is no longer enabled is skipped).
  - `0xB1 200 <payload>`: grip PCM stream counters, answering `0x35`: `[ver=1]`, then `made sent acked requeued
    lost evicted` (u32 LE): `0x88` frames built, transmissions (an immediate resend counts again), frames
    answered, put back for a later cycle, unanswered after every retry, and pushed out of a full relay ring
    unsent. Then the controller's `0x44` stream events by id `0..15` (u16 LE; `0x02` = ran dry), polls/s and
    relays/s (u16 LE), the Switch HD wave rate in kHz (4, or 8 in an `OPK_HD_PCM_8K` build), the replies to
    `0x88` frames bucketed by delay after the frame, 200 us per bucket with bucket 15 for 3 ms and later (16 ×
    u16 LE), the count of replies that arrived with a bad CRC (u16 LE), and the replies by attempt (first send,
    same-cycle resend, later-cycle retry) and kind (none, empty within 400 us, empty later, with data within
    400 us, with data later), 3 × 5 u16 LE. Then DualSense audio: USB audio packets received (u32 LE), the
    streaming interface's alt setting, the slots the grip stream sends to (bit per slot), and the left haptic
    channel's level after the gate (u16 LE). Then two histograms in ms buckets 0-2, 2-4, 4-8, 8-12, 12-16,
    16-24, 24-32, 32+ (8 × u16 LE each): each `0x88` frame's wait in the relay ring before its first send, and the
    gap between frames made for one controller within a stream. Last, the controller's "ran dry" events (u16 LE
    each): after the last frame, mid-stream, and the mid-stream ones within 500 ms of the stream start. Then the
    current stream's send timing (i32 LE, us): each frame's first send against a steady sample clock from the first
    one, as the earliest, latest and last value, and the last value minus the earliest at the last mid-stream "ran
    dry". Then relay entries other than `0x88` sent while a stream ran, and relay turns skipped because the previous
    poll got no reply while the ring held an entry (u32 LE each), the poll count (u16 LE, wraps), and the times
    the DualSense audio endpoint was found wedged and re-armed (u16 LE).
  - `0xB0 <len> <payload>` (status-blob version ≥ 30): one type's mapping profiles, answering ops
    `0x2C`-`0x34`: `[1][type][active][profiles][sources]`, then for each profile its `sources` target codes
    and the two trackpad -> stick bytes (`profiles × (sources + 2)` bytes), then the gesture
    `[enabled][prev][next]`. Type `4` (Lizard) has no sources, so it is the header and the gesture. Read the counts from the frame rather than assuming three profiles and 24
    sources. A later version may append further sections after
    those bytes (button combinations, macros); skip what the length covers beyond what you know.
  - `0xAE 55 <payload>`: Switch Pro / HD rumble / shortcut settings: `[ver=1][37 zero bytes]`
    `[swDpadHaptics][storageState][hdPadScale/2][4 zero bytes][swQamSelect][shortcutFlags][lizardProfile]`
    `[7 zero bytes]`, where `lizardProfile` (version ≥ 30, zero before) is the active Lizard profile.
    The zero bytes held removed settings (Switch Pro profiles, rumble presets and slot, strength steps and
    slots) and keep the layout stable; storageState 0 unavailable, 1 mounted, 2 initialized blank flash, 3 save failed.

Lizard binding wire format (16 bytes), matching `LizardBinding` in `lizard_map.h`:

```text
[0]     outType   (0 none, 1 keyboard chord, 2 mouse btn, 3 mouse axis, 4 scroll, 5 consumer)
[1..7]  outData[0..6]  (type-specific payload; mouse axis: [0] source, 0 right trackpad, 1 left stick,
                        2 gyro (not driven yet), 3 right stick; scroll: [0] source, 0 left trackpad,
                        1 left stick, 3 right stick)
[8..11] trigMask  u32 LE  (button bits: any-of)
[12..15] holdMask u32 LE  (button bits: all-of guard)
```

The v2 binding (ops `0x17`-`0x1A`) is `[0] outType`, `[1..7] outData`, `[8..15] trigMask u64 LE`,
`[16..23] holdMask u64 LE`. Mask bits 0-31 are the native Triton button word; bits 32-39 are virtual
stick-direction triggers (`LZ_BTN_LSTICK_*` / `LZ_BTN_RSTICK_*` in `lizard_map.h`).

> Lizard-map commands and the `0xAA` reply were renumbered from `0x0D–0x11`/`0xA7` on the merges with
> `main`, which had independently claimed `0x0D–0x10`, `0xA7` (bond export) and `0xA8` (flight
> recorder).

Status blob payload:

```text
[0]  version
[1]  usb mode
[2]  xbox mouse sensitivity divisor
[3]  xbox mouse friction
[4]  steam pad smoothing
[5]  A/B + X/Y swap
[6]  back mapping 0
[7]  back mapping 1
[8]  back mapping 2
[9]  back mapping 3
[10] connected slot or 0xFF
[11] link up flag
[12] delivered reports/s low
[13] delivered reports/s high
[14] poll interval / 100
[15] new reports/s low
[16] new reports/s high
[17] E7 mode byte
[18] relay opcode
[19] relay subtype
[20] forward-new-only flag
[21] QoS auto-hop flag
[22] persist-mode flag
```

Later fields are appended (the version byte says how far the payload goes). From version 20 the tail carries
the per-emulated-type trackpad-to-stick mapping at payload bytes 187..194 — two bytes per type
(`{left pad, right pad}`), each `0` off / `1` left stick / `2` right stick (`3` / `4` the Switch Pro D-pad on
touch / on click, from version 23; `5` disabled, from version 30). Set with
`0x02 <80 + type*2 + pad> <value>`. Fields 40..75 are the per-type config block, so the mapping starts at 80.
A mapped pad **blends** with its stick: while the pad is touched each axis reports whichever of the two
sources is deflected further from center (signed); an untouched pad contributes nothing and the physical
stick passes straight through. A mapped pad also stops reporting as a touchpad contact / mouse. A disabled pad
(`5`) drives nothing and reports no touchpad contact or mouse motion; its click is still the pad-click entry of
the profile's map, which is a separate setting.

From version 22, the status blob payload includes status LED configuration at payload bytes 194..199
(`p[196..201]`): `[194]` primary LED mode (`0` connection status, `1` heartbeat, `2` wake only, `3` off/stealth,
`4` on), `[195]` primary pin A, `[196]` secondary pin B, `[197]` primary polarity (`1` active high, `0` active low),
`[198]` secondary LED mode (`0..4`), and `[199]` secondary polarity (`1` active high, `0` active low).


### 10.1 Backup / clone (bond export & import)

A puck's whole portable identity is its four 24-byte bond records (`[proteus_uuid 4][ibex_uuid 4][serial 16]`,
§2). The per-bond on-air *session address* is **not** stored or transferred: each puck re-derives it from the
bond UUID mixed with its own FICR `DEVICEID`, and the bonded controller relearns it from the `E1` host beacon on
every reconnect. So copying the bond records onto a second puck is sufficient for any controller paired to the
first to connect to the second **with no re-pairing** — the two pucks just derive different (non-colliding)
session addresses for the same controller.

This makes a puck cloneable. The WebUSB panel exposes it as **Export to file** / **Import from file**.

**Export — `0x09` → `0xA7` frame:**

```text
[0]    format version (1)
[1]    used mask (bit s = slot s bonded)
[2..]  slot 0..3 records, 24 bytes each (96 bytes)        (len = 2 + 4*24 = 98)
```

**Import — `0x0D` (per slot) then `0x0E` (commit):**

```text
0x0D  <slot 0..3>  <used 0|1>  <24-byte record>      writes one slot into RAM (used=0 clears it)
0x0E  <mode>                                         persist all slots, apply mode (0xFF=unchanged), reboot
```

Bonds are written one slot at a time so no command exceeds a single USB-FS packet, and each `0x0D`/`0x02` is
acked with a status blob so the host's read-after-write keeps the OUT pipe flowing. The panel sends all four
`0x0D` slot writes plus every config field via `0x02`, then a single `0x0E` to persist and reboot — so the
reboot regenerates the session addresses from the new UUIDs and the restored puck reproduces both the pairings
and all settings. Other settings (mouse, chords, per-type button maps, Switch Pro gyro mapping) ride in the
backup file as plain `0x02` field values, not in the bond commands.

## 11. Timing notes

- Default poll interval: `4000` microseconds (250 Hz, matches SC2 report rate)
- Default RX window: `1200` microseconds
- Discovery beacon continues on channel 2 even after a connected session exists
- Connected session can be moved to a cleaner channel such as 18 or 52

## 12. Reimplementation checklist

To build a compatible puck from scratch:

1. Expose four independent bond slots over USB.
2. Implement `0x83`, `0xAE`, `0xB4`, `0xAD`, `0xA2`, `0xA3`.
3. Persist 24-byte bond records exactly.
4. Configure the radio exactly as described above.
5. Beacon `E1` host frames on `"ibex"` / prefix `0x10` / channel 2.
6. Poll with `E7` then `E3 GET 0x45`.
7. Parse `F1` and unpack report `0x45`.
8. Relay host feature writes to the controller as `E3` SET sub-TLVs.
9. Re-enumerate USB cleanly when switching Steam/Xbox/Switch modes (Xbox/Switch as clean non-composite devices).

If those pieces match, the controller-to-puck protocol is fully reimplemented.
