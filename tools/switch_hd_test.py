#!/usr/bin/env python3
"""Drive the puck's Switch Pro HD rumble from the host, verbosely.

The puck in Switch Pro mode enumerates as a Nintendo Pro Controller (057E:2009). A console rumbles it with
output report 0x10, [0x10][timer][left x4][right x4], about every 15 ms; this tool sends the same reports to
the puck's hidraw node, so the whole HD path runs: decode, grip PCM stream, trackpad tones.

  tools/switch_hd_test.py pulse    buzz, then silence: listen for a click after it ends (fork issue #14)
  tools/switch_hd_test.py sweep    10..100% in steps: does a click's strength follow the power?
  tools/switch_hd_test.py hold     steady buzz for stutter hunting; reports the host's own send jitter
  tools/switch_hd_test.py --dry-run pulse    print the frames, open nothing

Put the puck in Switch Pro mode first. The device is picked by VID/PID from sysfs and nothing else is opened.
With several controllers up, name one with --device /dev/hidrawN. The kernel's hid-nintendo driver does the
init handshake and may stay bound. The tool always ends on neutral frames so a stopped run can't leave a
buzz latched.
"""
import argparse
import glob
import math
import os
import sys
import time

VID, PID = 0x057E, 0x2009

# What a console sends when idle: amplitude 0 on both bands, both frequencies at their centres
NEUTRAL = bytes([0x00, 0x01, 0x40, 0x40])

# Band centres in Hz; the 7-bit frequency field is 1/32 octave steps around them, 64 = centre
CENTRE = {"low": 160.0, "high": 320.0}


def amp7_units(code):
    """Amplitude of a 7-bit code in 1/32 log2 units (0 = full scale); the curve the firmware decodes."""
    if code < 16:
        return 8 * code - 221
    if code < 32:
        return 2 * code - 131
    return min(code - 100, 0)


def amp7_code(fraction):
    """Nearest 7-bit amplitude code for 0..1 of full scale. Code 100 is 1.0; 0 is silence."""
    if fraction <= 0:
        return 0
    target = 32 * math.log2(min(fraction, 1.0))
    return min(range(1, 101), key=lambda c: abs(amp7_units(c) - target))


def freq7_code(hz, band):
    code = 64 + round(32 * math.log2(hz / CENTRE[band]))
    return max(0, min(127, code))


def freq7_hz(code, band):
    return CENTRE[band] * 2 ** ((code - 64) / 32)


def encode_motor(low_amp, low_hz, high_amp, high_hz):
    """One motor's 4 bytes: a single absolute 7-bit update (mode 1) of both bands. Returns (bytes, text)."""
    lo, hi = amp7_code(low_amp), amp7_code(high_amp)
    lf, hf = freq7_code(low_hz, "low"), freq7_code(high_hz, "high")
    w = (1 << 30) | (lo << 23) | (lf << 16) | (hi << 9) | (hf << 2)
    text = "low %3.0f Hz amp code %3d (%3.0f%%)  high %4.0f Hz amp code %3d (%3.0f%%)" % (
        freq7_hz(lf, "low"), lo, 100 * 2 ** (amp7_units(lo) / 32) if lo else 0,
        freq7_hz(hf, "high"), hi, 100 * 2 ** (amp7_units(hi) / 32) if hi else 0)
    return w.to_bytes(4, "little"), text


class Clock:
    """Wall clock, or a virtual one for --dry-run so a dry run finishes at once."""

    def __init__(self, virtual):
        self.virtual, self.t = virtual, 0.0

    def now(self):
        return self.t if self.virtual else time.perf_counter()

    def sleep_until(self, t):
        if self.virtual:
            self.t = max(self.t, t)
        else:
            d = t - time.perf_counter()
            if d > 0:
                time.sleep(d)


class Rig:
    def __init__(self, args, fd):
        self.args, self.fd = args, fd
        self.clock = Clock(fd is None)
        self.t0 = self.clock.now()
        self.timer = 0
        self.interval = 1.0 / args.rate
        self.sent = []  # actual send times, for the jitter report
        self.last_print = -1.0

    def stamp(self):
        return "[T+%7.3f]" % (self.clock.now() - self.t0)

    def say(self, tag, msg):
        print("%s %s %s" % (self.stamp(), tag, msg), flush=True)

    def motors(self, pct):
        """(left, right) 4-byte words for pct of full strength on the chosen band(s) and side(s)."""
        a = pct / 100.0
        low = a if self.args.band in ("both", "low") else 0.0
        high = a if self.args.band in ("both", "high") else 0.0
        word, text = encode_motor(low, self.args.low_hz, high, self.args.high_hz)
        on = {"left": (word, NEUTRAL), "right": (NEUTRAL, word), "both": (word, word)}[self.args.side]
        return on, text

    def send(self, left, right):
        frame = bytes([0x10, self.timer & 0x0F]) + left + right
        self.timer += 1
        if self.fd is None:
            if self.timer <= 3:
                self.say("[FRAME]", frame.hex(" "))
        else:
            try:
                os.write(self.fd, frame)
            except OSError as e:
                self.say("[ERROR]", "write failed: %s" % e)
                raise SystemExit(1)
        self.sent.append(self.clock.now())

    def run(self, seconds, left, right, note=None):
        """Send frames at --rate for `seconds`; with a note, print it about every 0.25 s."""
        end = self.clock.now() + seconds
        nxt = self.clock.now()
        while nxt < end:
            self.clock.sleep_until(nxt)
            self.send(left, right)
            if note and self.clock.now() - self.last_print >= 0.25:
                self.last_print = self.clock.now()
                self.say("[STATE]", note)
            nxt += self.interval

    def neutral(self, seconds):
        self.run(seconds, NEUTRAL, NEUTRAL)

    def jitter_report(self):
        gaps = [(b - a) * 1000 for a, b in zip(self.sent, self.sent[1:])]
        if not gaps or self.fd is None:
            return
        want = self.interval * 1000
        late = sum(1 for g in gaps if g > want + 5)
        self.say("[STATS]", "%d frames, interval mean %.1f ms (asked %.1f), max %.1f ms, %d late by >5 ms" % (
            len(self.sent), sum(gaps) / len(gaps), want, max(gaps), late))
        if late:
            self.say("[STATS]", "the host paced those late: that gap is not RF loss")


def find_puck(explicit):
    """The hidraw node of a 057E:2009 device, found through sysfs. Nothing else is opened."""
    found = []
    for node in sorted(glob.glob("/sys/class/hidraw/hidraw*")):
        try:
            info = dict(l.split("=", 1) for l in open(node + "/device/uevent").read().splitlines() if "=" in l)
            bus, vid, pid = (int(x, 16) for x in info["HID_ID"].split(":"))
        except (OSError, KeyError, ValueError):
            continue
        if (vid, pid) == (VID, PID):
            found.append(("/dev/" + os.path.basename(node), info.get("HID_NAME", "?")))
    for path, name in found:
        print("[FOUND] %s  %s" % (path, name))
    if explicit:
        if explicit not in [p for p, _ in found]:
            sys.exit("[FATAL] %s is not a %04X:%04X device" % (explicit, VID, PID))
        return explicit
    if not found:
        sys.exit("[FATAL] No %04X:%04X hidraw node. Is the puck in Switch Pro mode, and is the device visible here?" % (VID, PID))
    if len(found) > 1:
        sys.exit("[FATAL] %d controllers up: pick one with --device" % len(found))
    return found[0][0]


def scenario_pulse(rig, args):
    pair, text = rig.motors(args.amp)
    rig.say("[CONFIG]", "pulse %.0f%% for %d ms, then %.1f s of neutral frames, x%d" % (
        args.amp, args.ms, args.tail, args.count))
    rig.say("[CONFIG]", text)
    for i in range(args.count):
        rig.say("[TESTING]", "pulse %d/%d: RUMBLE ON" % (i + 1, args.count))
        rig.run(args.ms / 1000.0, *pair)
        rig.say("[TESTING]", "pulse %d/%d: RUMBLE OFF, listening for a click" % (i + 1, args.count))
        rig.run(args.tail, NEUTRAL, NEUTRAL, "silent")


def scenario_sweep(rig, args):
    rig.say("[CONFIG]", "sweep 10..100%% in steps of 10, %d ms on, %d ms off" % (args.ms, args.gap))
    for pct in range(10, 101, 10):
        pair, text = rig.motors(pct)
        rig.say("[TESTING]", "%3d%%  %s" % (pct, text))
        rig.run(args.ms / 1000.0, *pair)
        rig.run(args.gap / 1000.0, NEUTRAL, NEUTRAL)


def scenario_hold(rig, args):
    pair, text = rig.motors(args.amp)
    rig.say("[CONFIG]", "hold %.0f%% for %.0f s" % (args.amp, args.seconds))
    rig.say("[CONFIG]", text)
    rig.say("[TESTING]", "RUMBLE ON: listen for stutter or dropouts")
    rig.run(args.seconds, *pair, note="holding")
    rig.say("[TESTING]", "RUMBLE OFF")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("scenario", choices=["pulse", "sweep", "hold"])
    ap.add_argument("--device", help="hidraw node, e.g. /dev/hidraw5 (needed when several controllers are up)")
    ap.add_argument("--dry-run", action="store_true", help="print the frames; open no device, take no time")
    ap.add_argument("--rate", type=float, default=66.0, help="reports per second (a console sends ~66)")
    ap.add_argument("--amp", type=float, default=80.0, help="strength, percent of full scale (pulse, hold)")
    ap.add_argument("--low-hz", type=float, default=160.0, help="low band frequency, 40..640")
    ap.add_argument("--high-hz", type=float, default=320.0, help="high band frequency, 80..1280")
    ap.add_argument("--band", choices=["both", "low", "high"], default="both")
    ap.add_argument("--side", choices=["both", "left", "right"], default="both")
    ap.add_argument("--ms", type=int, default=500, help="pulse / sweep step length")
    ap.add_argument("--tail", type=float, default=2.0, help="pulse: seconds of silence after each buzz")
    ap.add_argument("--count", type=int, default=3, help="pulse: repeats")
    ap.add_argument("--gap", type=int, default=800, help="sweep: silence between steps, ms")
    ap.add_argument("--seconds", type=float, default=10.0, help="hold: length")
    args = ap.parse_args()
    if not 0 < args.rate <= 200 or not 0 <= args.amp <= 100:
        sys.exit("[FATAL] --rate is 1..200, --amp is 0..100")
    for name, v, lo, hi in (("--low-hz", args.low_hz, 40, 640), ("--high-hz", args.high_hz, 80, 1280)):
        if not lo <= v <= hi:
            print("[WARN] %s %.0f is outside the %d..%d Hz the field can carry; it is clamped" % (name, v, lo, hi))

    fd = None
    if not args.dry_run:
        path = find_puck(args.device)
        print("[START] Opening %s" % path)
        try:
            fd = os.open(path, os.O_WRONLY)
        except OSError as e:
            sys.exit("[FATAL] Cannot open %s: %s (a udev rule or root may be needed)" % (path, e))
    rig = Rig(args, fd)
    try:
        {"pulse": scenario_pulse, "sweep": scenario_sweep, "hold": scenario_hold}[args.scenario](rig, args)
    except KeyboardInterrupt:
        rig.say("[STATE]", "interrupted")
    finally:
        rig.say("[WAIT]", "Ending on neutral frames...")
        rig.neutral(0.3)
        rig.jitter_report()
        if fd is not None:
            os.close(fd)
    rig.say("[FINISH]", "Done. Anything you felt after RUMBLE OFF is the click.")


if __name__ == "__main__":
    main()
