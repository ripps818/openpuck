"""Lizard mode, left stick bound to mouse move: the pointer follows the stick's deflection. Compiles the real
mode_lizard.cpp against a stand-in for the USB HID layer and records the mouse reports it sends."""
from pathlib import Path
import subprocess, tempfile

r = Path(__file__).resolve().parents[2]
lizard = (r / 'OpenPuck/mode_lizard.cpp').read_text()
# the HID layer: just enough of Adafruit_TinyUSB for mode_lizard.h / .cpp
usb = r'''#pragma once
#include <stdint.h>
#include <vector>
struct hid_mouse_report_t { uint8_t buttons; int8_t x, y, wheel, pan; };
struct Adafruit_USBD_HID {
	std::vector<hid_mouse_report_t> mouse;
	std::vector<std::vector<uint8_t> > kbd;
	bool ready() { return true; }
	bool sendReport(uint8_t id, const void *d, uint8_t n)
	{
		if (id == 0x40) mouse.push_back(*(const hid_mouse_report_t *)d);
		else kbd.push_back(std::vector<uint8_t>((const uint8_t *)d, (const uint8_t *)d + n));
		return true;
	}
};
'''
test = r'''
#include <cassert>
#include <cmath>
#include "config.h"
Slot g_slot[NSLOT];
PuckInput g_in[NSLOT];
unsigned long g_connReplyMs[NSLOT];
bool g_touchpadDisabled = false;
int g_mDiv = 64, g_mFric = 50;
uint8_t g_usbMode = MODE_LIZARD;
uint8_t g_shortcutFlags = SHORTCUT_ENABLED;
uint32_t g_gestureMask = 0;
LizardMap g_lizardMap;

static Adafruit_USBD_HID dev;
static void bind(uint8_t src)
{
	g_lizardMap.count = 1;
	g_lizardMap.bindings[0] = LizardBinding{ LZ_OUT_MOUSE_AXIS, { src, 0, 0, 0, 0, 0, 0 }, 0, 0 };
}
// run n reports with the stick held, and return the pointer's total travel
static void run(int n, int lx, int ly, long *tx, long *ty)
{
	g_in[0].lx = lx;
	g_in[0].ly = ly;
	dev.mouse.clear();
	*tx = *ty = 0;
	for (int i = 0; i < n; i++)
		rfLizard(&dev, &dev, 0x40, 0x41);
	for (auto &m : dev.mouse) { *tx += m.x; *ty += m.y; }
}

int main()
{
	g_slot[0].used = true;
	long x, y;
	// stick -> mouse bound: held right moves right, and keeps moving while held
	bind(LZ_MSRC_LSTICK);
	run(100, 32767, 0, &x, &y);
	assert(x > 400 && x <= 500 && y == 0); // full deflection: 5 px a report
	run(100, -32767, 0, &x, &y);
	assert(x < -400 && x >= -500 && y == 0);
	// up on the stick is up on the screen (the cursor's y grows downward)
	run(100, 0, 32767, &x, &y);
	assert(y < -400 && x == 0);
	run(100, 0, -32767, &x, &y);
	assert(y > 400);
	// the deadzone: a resting stick (and a grazed one) does not drift the cursor, and sends no reports
	run(100, 4000, -4000, &x, &y);
	assert(x == 0 && y == 0 && dev.mouse.empty());
	// small deflections are slow (squared curve), in proportion
	long half;
	run(1000, 18000, 0, &half, &y);
	run(1000, 32767, 0, &x, &y);
	assert(half > 0 && half * 4 < x && half * 20 > x);
	// the sub-pixel carry: a slow stick still gets there, not rounded to nothing
	run(1000, 6000, 0, &x, &y);
	assert(x > 0);
	// a stick on a controller that is not bonded does nothing, and two controllers add up
	g_slot[0].used = false;
	run(100, 32767, 0, &x, &y);
	assert(x == 0);
	g_slot[0].used = g_slot[1].used = true;
	g_in[1].lx = 32767;
	long both;
	run(100, 32767, 0, &both, &y);
	assert(both > 800);
	g_in[1].lx = 0;
	g_slot[1].used = false;
	// the right stick is its own source, and both can be bound at once
	bind(LZ_MSRC_RSTICK);
	g_in[0].rx = 32767;
	g_in[0].ry = -32767;
	run(100, 0, 0, &x, &y);
	assert(x > 400 && y > 400); // right and down
	g_in[0].rx = g_in[0].ry = 0;
	run(100, 32767, 32767, &x, &y);
	assert(x == 0 && y == 0);
	g_lizardMap.count = 2;
	g_lizardMap.bindings[1] = LizardBinding{ LZ_OUT_MOUSE_AXIS, { LZ_MSRC_LSTICK, 0, 0, 0, 0, 0, 0 }, 0, 0 };
	g_in[0].rx = 32767;
	run(100, 32767, 0, &x, &y);
	assert(x > 800); // both sticks add up
	g_in[0].rx = 0;
	// without a stick binding the stick does not move the cursor, and a right-pad binding is not the stick
	bind(LZ_MSRC_RPAD);
	run(100, 32767, 32767, &x, &y);
	assert(x == 0 && y == 0);
	g_lizardMap.count = 0;
	run(100, 32767, 32767, &x, &y);
	assert(x == 0 && y == 0);
	// dropping the binding clears the carry, and releasing resets it too
	bind(LZ_MSRC_LSTICK);
	run(1, 6000, 0, &x, &y);
	bind(LZ_MSRC_RPAD);
	run(1, 0, 0, &x, &y);
	rfLizardRelease(&dev, &dev, 0x40, 0x41);
	bind(LZ_MSRC_LSTICK);
	run(1, 0, 0, &x, &y);
	assert(x == 0 && y == 0);
}
'''
with tempfile.TemporaryDirectory() as td:
    (Path(td) / 'Adafruit_TinyUSB.h').write_text(usb)
    p = Path(td) / 'test.cpp'
    p.write_text('#include <stddef.h>\n#include <string.h>\n' + lizard + test)
    subprocess.run(['g++', '-std=c++11', '-Wall', '-Wextra', '-Werror', '-Wno-unused', '-fsanitize=address,undefined',
                    '-I' + td, '-I' + str(r / 'OpenPuck'), str(p), '-o', td + '/test'], check=True)
    subprocess.run([td + '/test'], check=True, env={'ASAN_OPTIONS': 'detect_leaks=0'})
print('Lizard stick: left stick bound to mouse move drives the pointer')
