#!/usr/bin/env python3
"""Fingerprint Valve Ibex (controller) / Proteus (puck) .fw images, or diff two of them.

  tools/fw_inspect.py IMAGE.fw            identity, USB, HID and RF fingerprint
  tools/fw_inspect.py OLD.fw NEW.fw       fingerprint diff + added/removed log strings

Images: https://github.com/OpenSteamController/IbexFirmware. See docs/FIRMWARE_CHANGES.md for what
the fields mean. Heuristic, no disassembler needed: if a field reads "?", the code moved and needs a
look in a real disassembler.
"""
import re
import signal
import struct
import sys
import zlib
from datetime import datetime, timezone

# Payload is a Zephyr image linked here; image-info block at +0x100.
BASE = 0x8000


def load(path):
    raw = open(path, 'rb').read()
    size, crc = struct.unpack_from('<II', raw, 4)
    img = raw[32:]
    fp = {
        'file': path.split('/')[-1],
        'header': 'ok' if size == len(img) and crc == zlib.crc32(img)
        else 'BAD size/crc',
    }
    sha = img[0x10C:0x118].decode(errors='replace')
    build = struct.unpack_from('<I', img, 0x120)[0]
    fp['git_sha'] = sha
    fp['build'] = '%08X (%s)' % (build, datetime.fromtimestamp(
        build, timezone.utc).strftime('%Y-%m-%d %H:%M'))
    return img, fp


def usb(img, fp):
    devs = set()
    for m in re.finditer(rb'\x12\x01\x00\x02..\x01\x40\xde\x28', img, re.S):
        pid, bcd = struct.unpack_from('<HH', img, m.start() + 10)
        devs.add('28DE:%04X bcd %04X' % (pid, bcd))
    fp['usb_device'] = ', '.join(sorted(devs)) or '?'


def hid_collection(img, start):
    """Report-id summary and length of the top-level collection starting at start."""
    i, depth, rid, rsize, rcount, out = start, 0, 0, 0, 0, []
    while i < len(img):
        b = img[i]
        sz = (b & 3) if (b & 3) != 3 else 4
        tag = b & 0xFC
        v = int.from_bytes(img[i + 1:i + 1 + sz], 'little')
        i += 1 + sz
        if tag == 0xA0:
            depth += 1
        elif tag == 0xC0:
            depth -= 1
            if depth <= 0:
                break
        elif tag == 0x84:
            rid = v
        elif tag == 0x74:
            rsize = v
        elif tag == 0x94:
            rcount = v
        elif tag in (0x80, 0x90, 0xB0):
            kind = {0x80: 'IN', 0x90: 'OUT', 0xB0: 'FT'}[tag]
            key = '%s%02X' % (kind, rid)
            if out and out[-1][0] == key:
                out[-1][1] += rsize * rcount
            else:
                out.append([key, rsize * rcount])
    return ' '.join('%s:%d' % (k, n // 8) for k, n in out), i - start


def hid(img, fp):
    # Descriptors sit back to back in flash, so count distinct top-level collections instead.
    seen, ends = {}, []
    for pat in (rb'\x05\x01\x09[\x02\x06]\xa1\x01\x85', rb'\x06\x00\xff\x09.\xa1\x01\x85'):
        for m in re.finditer(pat, img, re.S):
            summary, n = hid_collection(img, m.start())
            if summary:
                seen[summary] = seen.get(summary, 0) + 1
    fp['hid'] = ['x%d %s' % (c, k) for k, c in sorted(seen.items())]


def rf_opcodes(img, fp):
    # movs r3,#op ; ... strb rX,[rY,#5] -- the RF frame builders store the opcode at msg[5]
    ops = set()
    for m in re.finditer(rb'([\xe0-\xf7])\x23', img):
        if re.search(rb'[\x40-\x7f]\x71', img[m.start() + 2:m.start() + 12]):
            ops.add('%02X' % m.group(1)[0])
    fp['rf_builders'] = ' '.join(sorted(ops))


def lit_xrefs(img, addr):
    """Code addresses whose PC-relative literal load yields addr (T1/T2 LDR literal)."""
    want = struct.pack('<I', addr)
    pools = {m.start() for m in re.finditer(re.escape(want), img)}
    refs = []
    for o in range(0, len(img) - 4, 2):
        hw = img[o] | img[o + 1] << 8
        if hw & 0xF800 == 0x4800:
            la = ((o + 4) & ~3) + (hw & 0xFF) * 4
        elif hw & 0xFF7F == 0xF85F:
            imm = (img[o + 2] | img[o + 3] << 8) & 0xFFF
            la = ((o + 4) & ~3) + (imm if hw & 0x80 else -imm)
        else:
            continue
        if la in pools:
            refs.append(o)
    return refs


def attr83(img, fp):
    s = img.find(b'%s: GET: ID_GET_ATTRIBUTES_VALUES\0')
    fp['attr83_len'] = '?'
    for o in lit_xrefs(img, BASE + s) if s >= 0 else []:
        # the handler stores the reply length with "movs r3,#len" (0x19 = 25 B, 0x1E = 30 B)
        m = re.search(rb'([\x19\x1e])\x23', img[o:o + 0x80])
        if m:
            fp['attr83_len'] = str(m.group(1)[0])
            break


def strings(img):
    out = set()
    for m in re.finditer(rb'[\x20-\x7e\t\n]{6,}\x00', img):
        t = m.group()[:-1].decode()
        if sum(c.isalpha() or c in ' _%/' for c in t) / len(t) > 0.7:
            out.add(t)
    return out


def inspect(path):
    img, fp = load(path)
    usb(img, fp)
    hid(img, fp)
    rf_opcodes(img, fp)
    attr83(img, fp)
    return img, fp


def show(fp):
    for k, v in fp.items():
        if isinstance(v, list):
            print('%-12s' % k)
            for x in v:
                print('    ' + x)
        else:
            print('%-12s %s' % (k, v))


def main(argv):
    if len(argv) == 2:
        show(inspect(argv[1])[1])
        return 0
    if len(argv) != 3:
        print(__doc__)
        return 2
    (ia, a), (ib, b) = inspect(argv[1]), inspect(argv[2])
    for k in a:
        if a[k] != b[k]:
            print('%s:\n  - %s\n  + %s' % (k, a[k], b[k]))
    sa, sb = strings(ia), strings(ib)
    print('\nstrings removed (%d):' % len(sa - sb))
    for t in sorted(sa - sb):
        print('  - ' + t.replace('\n', '\\n'))
    print('strings added (%d):' % len(sb - sa))
    for t in sorted(sb - sa):
        print('  + ' + t.replace('\n', '\\n'))
    return 0


if __name__ == '__main__':
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    sys.exit(main(sys.argv))
