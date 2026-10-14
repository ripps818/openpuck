"""Lizard mode, a stick bound to mouse move or the scroll wheel: it follows the stick's deflection. Compiles the real
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
# usbTxHid queues for the usbd task; here it hands the report straight to the stand-in device
usb_tx = r'''#pragma once
#include "Adafruit_TinyUSB.h"
static inline void usbTxHid(Adafruit_USBD_HID *hid, uint8_t rid, const void *data, uint16_t len)
{
	hid->sendReport(rid, data, (uint8_t)len);
}
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
static long wheel;
// run n reports with the stick held, and return the pointer's total travel (and the wheel's, in `wheel`)
static void run(int n, int lx, int ly, long *tx, long *ty)
{
	g_in[0].lx = lx;
	g_in[0].ly = ly;
	dev.mouse.clear();
	*tx = *ty = wheel = 0;
	for (int i = 0; i < n; i++)
		rfLizard(&dev, &dev, 0x40, 0x41);
	for (auto &m : dev.mouse) { *tx += m.x; *ty += m.y; wheel += m.wheel; }
}
// drag one finger across a trackpad (x 0 -> 6000 over 20 reports), lift, and let the glide run out
static void dragAxis(bool right, bool vertical, long *tx, long *ty)
{
	dev.mouse.clear();
	*tx = *ty = wheel = 0;
	for (int i = 0; i <= 120; i++) {
		bool down = i <= 20;
		int16_t v = (int16_t)(down ? i * 300 : 0);
		g_in[0].buttons = down ? (right ? TB_RPADT : TB_LPADT) : 0;
		int16_t &px = right ? (vertical ? g_in[0].rpy : g_in[0].rpx) :
				      (vertical ? g_in[0].lpy : g_in[0].lpx);
		if (down)
			px = v;
		rfLizard(&dev, &dev, 0x40, 0x41);
	}
	g_in[0].buttons = 0;
	g_in[0].lpx = g_in[0].lpy = g_in[0].rpx = g_in[0].rpy = 0;
	for (auto &m : dev.mouse) { *tx += m.x; *ty += m.y; wheel += m.wheel; }
}
static void drag(bool right, long *tx, long *ty) { dragAxis(right, false, tx, ty); }
static void dragY(long *tx, long *ty) { dragAxis(false, true, tx, ty); }
static void bindScroll(uint8_t src)
{
	g_lizardMap.count = 1;
	g_lizardMap.bindings[0] = LizardBinding{ LZ_OUT_SCROLL, { src, 0, 0, 0, 0, 0, 0 }, 0, 0 };
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
	// a stick bound to the scroll wheel: up scrolls up, at about 0.12 notch a report at full deflection
	bindScroll(LZ_MSRC_RSTICK);
	g_in[0].ry = 32767;
	run(1000, 0, 0, &x, &y);
	assert(wheel > 100 && wheel <= 120 && x == 0 && y == 0); // the pointer stays put
	g_in[0].ry = -32767;
	run(1000, 0, 0, &x, &y);
	assert(wheel < -100 && wheel >= -120);
	g_in[0].ry = 4000;
	run(1000, 0, 0, &x, &y);
	assert(wheel == 0 && dev.mouse.empty()); // the deadzone
	g_in[0].ry = 18000;
	run(1000, 0, 0, &x, &y);
	assert(wheel > 10 && wheel < 60); // slower than full, and the carry still gets it there
	g_in[0].ry = 0;
	// the left stick is its own source, and scroll and move can use different sticks at once
	bindScroll(LZ_MSRC_LSTICK);
	run(1000, 0, 32767, &x, &y);
	assert(wheel > 100 && x == 0 && y == 0);
	g_lizardMap.count = 2;
	g_lizardMap.bindings[1] = LizardBinding{ LZ_OUT_MOUSE_AXIS, { LZ_MSRC_RSTICK, 0, 0, 0, 0, 0, 0 }, 0, 0 };
	g_in[0].rx = 32767;
	run(100, 0, 32767, &x, &y);
	assert(wheel > 10 && x > 400);
	g_in[0].rx = 0;
	// a stick that is not the bound one does nothing, and releasing resets the carry
	bindScroll(LZ_MSRC_RSTICK);
	run(100, 32767, 32767, &x, &y);
	assert(wheel == 0 && x == 0 && y == 0);
	g_in[0].ry = 6000;
	run(1, 0, 0, &x, &y);
	bindScroll(LZ_MSRC_LSTICK);
	g_in[0].ry = 0;
	run(1, 0, 0, &x, &y);
	rfLizardRelease(&dev, &dev, 0x40, 0x41);
	run(300, 0, 0, &x, &y);
	assert(wheel == 0);
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

	// a trackpad bound to mouse move: a drag moves the cursor and glides on after the finger lifts
	bind(LZ_MSRC_LPAD_MOUSE);
	drag(false, &x, &y);
	assert(x > 0 && y == 0);
	long left = x;
	// the left pad's binding does not make the right pad move the cursor, and the other way round
	drag(true, &x, &y);
	assert(x == 0 && y == 0);
	bind(LZ_MSRC_RPAD);
	drag(false, &x, &y);
	assert(x == 0 && y == 0);
	drag(true, &x, &y);
	assert(labs(x - left) <= 1); // the right pad behaves as before, the same glide model
	// both pads bound: each drives the cursor on its own
	g_lizardMap.count = 2;
	g_lizardMap.bindings[1] = LizardBinding{ LZ_OUT_MOUSE_AXIS, { LZ_MSRC_LPAD_MOUSE, 0, 0, 0, 0, 0, 0 }, 0, 0 };
	drag(false, &x, &y);
	assert(labs(x - left) <= 1);
	drag(true, &x, &y);
	assert(labs(x - left) <= 1);
	// up the pad is up the screen, and a disabled touchpad does nothing
	dragY(&x, &y);
	assert(y < 0 && x == 0);
	g_touchpadDisabled = true;
	drag(false, &x, &y);
	assert(x == 0 && y == 0);
	g_touchpadDisabled = false;
	// left pad bound to scroll and mouse move at once: a vertical drag both scrolls and moves
	bindScroll(LZ_MSRC_LPAD);
	g_lizardMap.count = 2;
	dragY(&x, &y);
	assert(y < 0 && wheel != 0);
	// releasing mid-glide leaves nothing to fling on re-entry
	bind(LZ_MSRC_LPAD_MOUSE);
	g_in[0].buttons = TB_LPADT;
	g_in[0].lpx = 0;
	run(1, 0, 0, &x, &y);
	g_in[0].lpx = 3000;
	run(1, 0, 0, &x, &y);
	g_in[0].buttons = 0;
	rfLizardRelease(&dev, &dev, 0x40, 0x41);
	run(50, 0, 0, &x, &y);
	assert(x == 0 && y == 0);
}
'''
with tempfile.TemporaryDirectory() as td:
    (Path(td) / 'Adafruit_TinyUSB.h').write_text(usb)
    (Path(td) / 'usb_tx.h').write_text(usb_tx)
    p = Path(td) / 'test.cpp'
    p.write_text('#include <stddef.h>\n#include <string.h>\n' + lizard + test)
    subprocess.run(['g++', '-std=c++11', '-Wall', '-Wextra', '-Werror', '-Wno-unused', '-fsanitize=address,undefined',
                    '-I' + td, '-I' + str(r / 'OpenPuck'), str(p), '-o', td + '/test'], check=True)
    subprocess.run([td + '/test'], check=True, env={'ASAN_OPTIONS': 'detect_leaks=0'})
print('Lizard stick: the sticks and trackpads drive the pointer and the scroll wheel')
