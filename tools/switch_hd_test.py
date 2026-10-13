#!/usr/bin/env python3
"""Drive the puck's Switch Pro HD rumble from the host, verbosely.

The puck in Switch Pro mode enumerates as a Nintendo Pro Controller (057E:2009). A console rumbles it with
output report 0x10, [0x10][timer][left x4][right x4], about every 15 ms; this tool sends the same reports to
the puck's hidraw node, so the whole HD path runs: decode, grip PCM stream, trackpad tones.

  tools/switch_hd_test.py pulse    buzz, then silence: listen for a click after it ends (fork issue #14)
  tools/switch_hd_test.py sweep    10..100% in steps: does a click's strength follow the power?
  tools/switch_hd_test.py hold     steady buzz for stutter hunting; reports the host's own send jitter
  tools/switch_hd_test.py pan      left only, right only, left-to-right sweeps, then one effect at five
                                   positions with short gaps (fork issue #17)
  tools/switch_hd_test.py panloop  pan back and forth for --seconds, printing LEFT / CENTER / RIGHT as it
                                   passes them, to tie a stutter to a position
  tools/switch_hd_test.py panstep  hold --steps left/right mixes for --ms each, left to right and back, in one
                                   stream, printing each side's strength: which mixes feel rough?
  tools/switch_hd_test.py --dry-run pulse    print the frames, open nothing

Put the puck in Switch Pro mode first. The device is picked by VID/PID from sysfs and nothing else is opened.
With several controllers up, name one with --device /dev/hidrawN. The kernel's hid-nintendo driver does the
init handshake and may stay bound. The tool always ends on neutral frames so a stopped run can't leave a
buzz latched.

With no hidraw node (a container that sees only /dev/bus/usb), --usb sends through pyusb instead. It detaches
the kernel driver from the controller interface for the run and re-attaches it after, so a game using the
puck loses it meanwhile. --diag (with --usb) also reads the puck's grip PCM counters (op 0x35) before and after
the run and prints what changed; close the config panel first, since it holds the same vendor interface.
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
    def __init__(self, args, out):
        self.args, self.out = args, out
        self.clock = Clock(out is None)
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
        if self.out is None:
            if self.timer <= 3:
                self.say("[FRAME]", frame.hex(" "))
        else:
            try:
                self.out(frame)
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
        if not gaps or self.out is None:
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


class UsbOut:
    """Interrupt OUT through pyusb. A real Pro Controller is also 057E:2009, so only a device with the puck's
    vendor (WebUSB) interface is taken."""

    def __init__(self):
        try:
            import usb.core
        except ImportError:
            sys.exit("[FATAL] --usb needs pyusb")
        found = [d for d in usb.core.find(find_all=True, idVendor=VID, idProduct=PID)
                 if any(i.bInterfaceClass == 0xFF for i in d.get_active_configuration())]
        if len(found) != 1:
            sys.exit("[FATAL] %d pucks in Switch Pro mode found, need exactly 1" % len(found))
        self.dev = found[0]
        cfg = self.dev.get_active_configuration()
        # the HID interface with an OUT endpoint carries output reports
        for intf in cfg:
            ep = [e for e in intf if intf.bInterfaceClass == 3 and not e.bEndpointAddress & 0x80]
            if ep:
                self.intf, self.ep = intf.bInterfaceNumber, ep[0].bEndpointAddress
                break
        else:
            sys.exit("[FATAL] no HID OUT endpoint on the puck")
        self.reattach = self.dev.is_kernel_driver_active(self.intf)
        if self.reattach:
            self.dev.detach_kernel_driver(self.intf)
        usb.util.claim_interface(self.dev, self.intf)
        print("[START] Bus %03d Device %03d, interface %d, endpoint 0x%02x" % (
            self.dev.bus, self.dev.address, self.intf, self.ep))

    def __call__(self, frame):
        import usb.core
        try:
            self.dev.write(self.ep, frame, timeout=100)
        except usb.core.USBError as e:
            raise OSError(str(e))

    def close(self):
        import usb.util
        usb.util.release_interface(self.dev, self.intf)
        if self.reattach:
            self.dev.attach_kernel_driver(self.intf)


PCM_DIAG_NAMES = ("made", "sent", "acked", "requeued", "lost", "evicted")


class PcmDiag:
    """The puck's 0xB1 grip PCM counters, read over its vendor (WebUSB) interface."""

    def __init__(self, dev):
        import usb.util
        self.dev = dev
        intf = next(i for i in dev.get_active_configuration() if i.bInterfaceClass == 0xFF)
        self.intf = intf.bInterfaceNumber
        self.ep_out = next(e.bEndpointAddress for e in intf if not e.bEndpointAddress & 0x80)
        self.ep_in = next(e.bEndpointAddress for e in intf if e.bEndpointAddress & 0x80)
        try:
            usb.util.claim_interface(dev, self.intf)
        except usb.core.USBError as e:
            sys.exit("[FATAL] cannot claim the vendor interface (%s): close the config panel" % e)
        # the panel's connect: SET_LINE_STATE 1, without which the puck sends no frames on this interface
        dev.ctrl_transfer(0x21, 0x22, 0x01, self.intf, None)

    def read(self):
        """One 0xB1 frame as a dict; other frames (an unsolicited status blob) are skipped."""
        import usb.core
        # The puck drops a frame that doesn't fit its USB send buffer (a status blob from a settings write can
        # fill it), so ask again if no answer comes.
        buf, deadline, ask = b"", time.monotonic() + 3.0, 0.0
        while time.monotonic() < deadline:
            if time.monotonic() >= ask:
                self.dev.write(self.ep_out, bytes([0x35]), timeout=2000)
                ask = time.monotonic() + 0.6
            try:
                buf += bytes(self.dev.read(self.ep_in, 64, timeout=200))
            except usb.core.USBTimeoutError:
                continue
            while len(buf) >= 2 and len(buf) >= 2 + buf[1]:
                marker, body, buf = buf[0], buf[2:2 + buf[1]], buf[2 + buf[1]:]
                if marker == 0xB1 and len(body) >= 134 and body[0] == 1:
                    d = {n: int.from_bytes(body[1 + 4 * i:5 + 4 * i], "little")
                         for i, n in enumerate(PCM_DIAG_NAMES)}
                    d["events"] = [int.from_bytes(body[25 + 2 * i:27 + 2 * i], "little") for i in range(16)]
                    d["polls"] = int.from_bytes(body[57:59], "little")
                    d["relays"] = int.from_bytes(body[59:61], "little")
                    d["khz"] = body[61]
                    d["reply"] = [int.from_bytes(body[62 + 2 * i:64 + 2 * i], "little") for i in range(16)]
                    d["crcbad"] = int.from_bytes(body[94:96], "little")
                    d["outcome"] = [int.from_bytes(body[96 + 2 * i:98 + 2 * i], "little") for i in range(15)]
                    d["audio"] = int.from_bytes(body[126:130], "little")
                    d["alt"], d["wavemask"] = body[130], body[131]
                    d["envl"] = int.from_bytes(body[132:134], "little")
                    return d
        sys.exit("[FATAL] no 0xB1 reply: this firmware predates op 0x35")

    def report(self, before, after):
        delta = {n: after[n] - before[n] for n in PCM_DIAG_NAMES}
        print("[DIAG] %d kHz stream: made %d, sent %d, acked %d, requeued %d, lost %d, evicted %d" % (
            after["khz"], *(delta[n] for n in PCM_DIAG_NAMES)))
        ev = {i: after["events"][i] - before["events"][i] for i in range(16)}
        ev = {i: n for i, n in ev.items() if n}
        print("[DIAG] controller 0x44 events: %s%s" % (
            ", ".join("0x%02x x%d" % kv for kv in ev.items()) or "none",
            "  (0x02 = ran dry)" if 2 in ev else ""))
        print("[DIAG] last second: %d polls/s, %d relays/s" % (after["polls"], after["relays"]))
        rep = [after["reply"][i] - before["reply"][i] for i in range(16)]
        print("[DIAG] reply delay after each 0x88 frame (us): %s; corrupt replies %d" % (
            ", ".join("%s %d" % ("%d-%d" % (200 * i, 200 * i + 199) if i < 15 else "3000+", n)
                      for i, n in enumerate(rep) if n) or "none",
            after["crcbad"] - before["crcbad"]))
        print("[DIAG] DualSense audio: %d packets, alt %d, stream slots 0x%02x, left level %d" % (
            after["audio"] - before["audio"], after["alt"], after["wavemask"], after["envl"]))
        kinds = ("none", "empty<400", "empty>=400", "data<400", "data>=400")
        for a, name in enumerate(("first send", "resend", "later retry")):
            row = [after["outcome"][5 * a + o] - before["outcome"][5 * a + o] for o in range(5)]
            print("[DIAG] %-11s %s" % (name, "  ".join("%s %d" % (k, n) for k, n in zip(kinds, row))))

    def close(self):
        import usb.util
        usb.util.release_interface(self.dev, self.intf)


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


def scenario_pan(rig, args):
    """Equal-power pan: each side's level is cos/sin of the position, so the total stays even."""
    def pair(pos, low_hz, high_hz):
        a = args.amp / 100.0
        gl, gr = math.cos(pos * math.pi / 2), math.sin(pos * math.pi / 2)
        left, text = encode_motor(a * gl, low_hz, a * gl, high_hz)
        right, _ = encode_motor(a * gr, low_hz, a * gr, high_hz)
        return (left if gl > 0.01 else NEUTRAL), (right if gr > 0.01 else NEUTRAL)

    tones = ((args.low_hz, args.high_hz), (300.0, 320.0))
    for low_hz, high_hz in tones:
        rig.say("[CONFIG]", "bands %.0f + %.0f Hz at %.0f%%%s" % (
            low_hz, high_hz, args.amp, "  (close: they beat at %.0f Hz)" % (high_hz - low_hz)
            if high_hz - low_hz < 40 else ""))
        for name, pos in (("LEFT only", 0.0), ("RIGHT only", 1.0)):
            rig.say("[TESTING]", name)
            rig.run(1.0, *pair(pos, low_hz, high_hz))
            rig.neutral(0.8)
        rig.say("[TESTING]", "sweep LEFT -> RIGHT over 3 s")
        steps = int(3.0 * args.rate)
        start = rig.clock.now()
        for i in range(steps):
            rig.clock.sleep_until(start + i * rig.interval)
            rig.send(*pair(i / (steps - 1), low_hz, high_hz))
        rig.neutral(0.8)
    # same effect, five positions, 200 ms apart: the stream stays up between them, as in a character select
    low_hz, high_hz = tones[1]
    rig.say("[TESTING]", "same 300 ms effect at 5 positions, L to R: each should start the same way")
    for pos in (0.0, 0.25, 0.5, 0.75, 1.0):
        rig.say("[STATE]", "position %.2f" % pos)
        rig.run(0.3, *pair(pos, low_hz, high_hz))
        rig.neutral(0.2)


def scenario_panloop(rig, args):
    """Equal-power pan, left -> right -> left every --period seconds, one continuous stream."""
    a = args.amp / 100.0
    rig.say("[CONFIG]", "panloop %.0f s, %.1f s per left-right-left, bands %.0f + %.0f Hz at %.0f%%" % (
        args.seconds, args.period, args.low_hz, args.high_hz, args.amp))
    start, last = rig.clock.now(), None
    i = 0
    while rig.clock.now() - start < args.seconds:
        rig.clock.sleep_until(start + i * rig.interval)
        t = i * rig.interval
        pos = 0.5 - 0.5 * math.cos(2 * math.pi * t / args.period)
        gl, gr = math.cos(pos * math.pi / 2), math.sin(pos * math.pi / 2)
        left, _ = encode_motor(a * gl, args.low_hz, a * gl, args.high_hz)
        right, _ = encode_motor(a * gr, args.low_hz, a * gr, args.high_hz)
        rig.send(left if gl > 0.01 else NEUTRAL, right if gr > 0.01 else NEUTRAL)
        mark = "LEFT" if pos < 0.05 else "RIGHT" if pos > 0.95 else "CENTER" if abs(pos - 0.5) < 0.05 else None
        if mark and mark != last:
            rig.say("[STATE]", mark)
        last = mark or last
        i += 1


def scenario_panstep(rig, args):
    """Equal-power mixes held one after another with no gap, so roughness can be tied to a mix."""
    a = args.amp / 100.0
    n = max(args.steps, 2)
    order = list(range(n)) + list(range(n - 2, -1, -1))
    rig.say("[CONFIG]", "panstep: %d mixes, %d ms each, bands %.0f + %.0f Hz at %.0f%%" % (
        n, args.ms, args.low_hz, args.high_hz, args.amp))
    for k in order:
        pos = k / (n - 1)
        gl, gr = math.cos(pos * math.pi / 2), math.sin(pos * math.pi / 2)
        left, _ = encode_motor(a * gl, args.low_hz, a * gl, args.high_hz)
        right, _ = encode_motor(a * gr, args.low_hz, a * gr, args.high_hz)
        rig.say("[TESTING]", "mix %d/%d  left %3.0f%%  right %3.0f%%" % (k + 1, n, 100 * gl, 100 * gr))
        rig.run(args.ms / 1000.0, left if gl > 0.01 else NEUTRAL, right if gr > 0.01 else NEUTRAL)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("scenario", choices=["pulse", "sweep", "hold", "pan", "panloop", "panstep"])
    ap.add_argument("--device", help="hidraw node, e.g. /dev/hidraw5 (needed when several controllers are up)")
    ap.add_argument("--dry-run", action="store_true", help="print the frames; open no device, take no time")
    ap.add_argument("--usb", action="store_true", help="send through pyusb instead of hidraw")
    ap.add_argument("--diag", action="store_true", help="with --usb: print the puck's PCM stream counters")
    ap.add_argument("--rate", type=float, default=66.0, help="reports per second (a console sends ~66)")
    ap.add_argument("--amp", type=float, default=80.0, help="strength, percent of full scale (pulse, hold)")
    ap.add_argument("--low-hz", type=float, default=160.0, help="low band frequency, 40..640")
    ap.add_argument("--high-hz", type=float, default=320.0, help="high band frequency, 80..1280")
    ap.add_argument("--band", choices=["both", "low", "high"], default="both")
    ap.add_argument("--side", choices=["both", "left", "right"], default="both")
    ap.add_argument("--ms", type=int, default=500, help="pulse / sweep / panstep step length")
    ap.add_argument("--tail", type=float, default=2.0, help="pulse: seconds of silence after each buzz")
    ap.add_argument("--count", type=int, default=3, help="pulse: repeats")
    ap.add_argument("--gap", type=int, default=800, help="sweep: silence between steps, ms")
    ap.add_argument("--seconds", type=float, default=10.0, help="hold, panloop: length")
    ap.add_argument("--period", type=float, default=2.0, help="panloop: seconds per left-right-left")
    ap.add_argument("--steps", type=int, default=9, help="panstep: mixes from full left to full right")
    args = ap.parse_args()
    if not 0 < args.rate <= 200 or not 0 <= args.amp <= 100:
        sys.exit("[FATAL] --rate is 1..200, --amp is 0..100")
    for name, v, lo, hi in (("--low-hz", args.low_hz, 40, 640), ("--high-hz", args.high_hz, 80, 1280)):
        if not lo <= v <= hi:
            print("[WARN] %s %.0f is outside the %d..%d Hz the field can carry; it is clamped" % (name, v, lo, hi))

    if args.diag and not args.usb:
        sys.exit("[FATAL] --diag needs --usb")
    fd, usb_out, out, diag, before = None, None, None, None, None
    if args.usb and not args.dry_run:
        usb_out = out = UsbOut()
        if args.diag:
            diag = PcmDiag(usb_out.dev)
            before = diag.read()
    elif not args.dry_run:
        path = find_puck(args.device)
        print("[START] Opening %s" % path)
        try:
            fd = os.open(path, os.O_WRONLY)
        except OSError as e:
            sys.exit("[FATAL] Cannot open %s: %s (a udev rule or root may be needed)" % (path, e))
        out = lambda frame: os.write(fd, frame)
    rig = Rig(args, out)
    try:
        {"pulse": scenario_pulse, "sweep": scenario_sweep, "hold": scenario_hold,
         "pan": scenario_pan, "panloop": scenario_panloop,
         "panstep": scenario_panstep}[args.scenario](rig, args)
    except KeyboardInterrupt:
        rig.say("[STATE]", "interrupted")
    finally:
        rig.say("[WAIT]", "Ending on neutral frames...")
        rig.neutral(0.3)
        rig.jitter_report()
        if fd is not None:
            os.close(fd)
        if diag is not None:
            # the stream's tail and the controller's last events land after the final frame
            time.sleep(0.5)
            diag.report(before, diag.read())
            diag.close()
        if usb_out is not None:
            usb_out.close()
    rig.say("[FINISH]", "Done. Anything you felt after RUMBLE OFF is the click.")


if __name__ == "__main__":
    main()
