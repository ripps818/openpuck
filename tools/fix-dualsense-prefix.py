#!/usr/bin/env python3
"""Repair a Wine/Proton prefix where a game stopped seeing a DualSense (or the puck in DualSense mode) as one.

  tools/fix-dualsense-prefix.py PREFIX [--ffxiv-cfg FFXIV.cfg] [--dry-run]

PREFIX is the directory holding system.reg (a Proton compatdata/<appid> directory also works). Close the game
first: Wine rewrites system.reg when its wineserver exits.

1. Stale XInput devices. A prefix that ever exposed a Sony pad through XInput (older Proton, Steam Input,
   PROTON_SONY_HIDRAW_XINPUT=1) keeps WINEXINPUT\\VID_054C&...&IG_xx device keys. Wine 11's WMI lists them even with
   the pad unplugged, so a game's "is this an XInput device?" check (IG_ plus a matching VID/PID) finds them, and the
   game drops the DualSense's DirectInput device: no buttons, no haptics. This removes every Sony WINEXINPUT key;
   Wine recreates any that are still live at the next start.
2. FFXIV only (--ffxiv-cfg): FFXIV saves a button map for one pad by DirectInput instance GUID. Wine 11 keeps
   instance GUIDs across runs, so a map saved while the pad looked different (XInput, another layout) is applied
   again and the buttons do nothing. This removes InstanceGuid, ProductGuid and Alias from <GamePad Settings>;
   the game rebuilds the default layout and saves them back as zeros, which this leaves alone. Custom button
   assignments in the game's Button Config are not touched.

Backups are written next to each file as <name>.bak-dualsense-<time> before any change.
"""
import argparse
import os
import re
import shutil
import sys
import time

SONY_XINPUT_KEY = re.compile(r'^\[System\\\\ControlSet001\\\\Enum\\\\WINEXINPUT\\\\VID_054C&', re.IGNORECASE)
FFXIV_PAD_KEYS = re.compile(r'^(InstanceGuid|ProductGuid|Alias)\t')


def running_wine(prefix):
    """PIDs whose cwd is this prefix's wineserver directory (/tmp/.wine-UID/server-DEV-INODE)."""
    st = os.stat(prefix)
    server = f'/tmp/.wine-{os.getuid()}/server-{st.st_dev:x}-{st.st_ino:x}'
    pids = []
    for pid in filter(str.isdigit, os.listdir('/proc')):
        try:
            if os.readlink(f'/proc/{pid}/cwd') == server:
                pids.append(pid)
        except OSError:
            pass
    return pids


def running_ffxiv():
    for pid in filter(str.isdigit, os.listdir('/proc')):
        try:
            with open(f'/proc/{pid}/cmdline', 'rb') as f:
                if b'ffxiv_dx11.exe' in f.read():
                    return True
        except OSError:
            pass
    return False


def backup_and_write(path, text):
    bak = f'{path}.bak-dualsense-{time.strftime("%Y%m%d-%H%M%S")}'
    shutil.copy2(path, bak)
    with open(path, 'w', encoding='latin-1', newline='') as f:
        f.write(text)
    print(f'  backup: {bak}')


def fix_registry(prefix, dry_run):
    path = os.path.join(prefix, 'system.reg')
    with open(path, encoding='latin-1', newline='') as f:
        lines = f.read().split('\n')
    # A key's section runs from its "[...]" line to the next one.
    out, removed, drop = [], [], False
    for line in lines:
        if line.startswith('['):
            drop = bool(SONY_XINPUT_KEY.match(line))
            if drop:
                removed.append(line.split(']')[0][1:])
        if not drop:
            out.append(line)
    devices = sorted({k.split('\\\\')[4] for k in removed})
    print(f'{path}: {len(removed)} Sony XInput registry keys')
    for d in devices:
        print(f'  WINEXINPUT\\{d}')
    if removed and not dry_run:
        backup_and_write(path, '\n'.join(out))


def fix_ffxiv_cfg(path, dry_run):
    with open(path, encoding='latin-1', newline='') as f:
        text = f.read()
    newline = '\r\n' if '\r\n' in text else '\n'
    out, removed, in_pad = [], [], False
    for line in text.split(newline):
        if line.startswith('<'):
            in_pad = line == '<GamePad Settings>'
        # all zeros is the game's own "no saved pad" state, written after a reset
        if in_pad and FFXIV_PAD_KEYS.match(line) and re.search(r'[1-9A-Fa-f]', line.split('\t', 1)[1]):
            removed.append(line)
        else:
            out.append(line)
    print(f'{path}: {len(removed)} saved pad entries')
    for line in removed:
        print(f'  {line[:80]}')
    if removed and not dry_run:
        backup_and_write(path, newline.join(out))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('prefix', help='Wine prefix (directory with system.reg) or Proton compatdata/<appid>')
    ap.add_argument('--ffxiv-cfg', help="also reset FFXIV's saved pad identity and button map in this FFXIV.cfg")
    ap.add_argument('--dry-run', action='store_true', help='show what would change, change nothing')
    args = ap.parse_args()

    prefix = args.prefix
    if not os.path.isfile(os.path.join(prefix, 'system.reg')) and os.path.isfile(
            os.path.join(prefix, 'pfx', 'system.reg')):
        prefix = os.path.join(prefix, 'pfx')
    if not os.path.isfile(os.path.join(prefix, 'system.reg')):
        sys.exit(f'{args.prefix}: no system.reg, not a Wine prefix')
    prefix = os.path.realpath(prefix)

    if not args.dry_run:
        pids = running_wine(prefix)
        if pids:
            sys.exit(f'Wine is still running in this prefix (pids {" ".join(pids)}). Close the game and run '
                     f'`WINEPREFIX={prefix} wineserver -k` if it lingers.')
        if args.ffxiv_cfg and running_ffxiv():
            sys.exit('FFXIV is running; close it first, it rewrites FFXIV.cfg on exit.')

    fix_registry(prefix, args.dry_run)
    if args.ffxiv_cfg:
        fix_ffxiv_cfg(args.ffxiv_cfg, args.dry_run)
    if args.dry_run:
        print('dry run: nothing changed')


if __name__ == '__main__':
    main()
