#include "mode_lizard.h"
#include "lizard_map.h"
#include "triton.h"
#include "config.h"
#include "usb_tx.h"
#include <string.h>

// Evaluate the binding table for ONE controller's button word, merging its keyboard/mouse-button/
// consumer outputs into the shared accumulators. Pulled out of rfLizard so every bonded controller can
// feed the same outputs. The axes are map-level (set if such a binding exists at all).
struct LizardAxes {
	bool rpadMouse, lpadMouse, lpadScroll, lstickMouse, rstickMouse,
		lstickScroll, rstickScroll;
};
static void lizardEvalSlot(uint64_t buttons, uint8_t &outMod,
			   uint8_t outKeys[6], uint8_t &nKeys, uint8_t &outMBtn,
			   uint8_t &consumerBits, LizardAxes &ax)
{
	if (g_touchpadDisabled)
		buttons &= ~(TB_LPADT | TB_RPADT | TB_LPADC | TB_RPADC);
	// kbdConsumed (per controller): trig bits claimed by a hold-modifier binding so simpler
	// single-button bindings sharing those bits are suppressed for THIS controller.
	uint64_t kbdConsumed = 0;
	for (uint8_t i = 0; i < g_lizardMap.count; i++) {
		const LizardBinding &b = g_lizardMap.bindings[i];
		if (b.outType == LZ_OUT_NONE)
			continue;

		if (b.outType == LZ_OUT_MOUSE_AXIS) {
			if (b.outData[0] == LZ_MSRC_RPAD && !g_touchpadDisabled)
				ax.rpadMouse = true;
			if (b.outData[0] == LZ_MSRC_LPAD_MOUSE &&
			    !g_touchpadDisabled)
				ax.lpadMouse = true;
			if (b.outData[0] == LZ_MSRC_LSTICK)
				ax.lstickMouse = true;
			if (b.outData[0] == LZ_MSRC_RSTICK)
				ax.rstickMouse = true;
			// LZ_MSRC_GYRO is not driven yet
			continue;
		}
		if (b.outType == LZ_OUT_SCROLL) {
			if (b.outData[0] == LZ_MSRC_LPAD && !g_touchpadDisabled)
				ax.lpadScroll = true;
			if (b.outData[0] == LZ_MSRC_LSTICK)
				ax.lstickScroll = true;
			if (b.outData[0] == LZ_MSRC_RSTICK)
				ax.rstickScroll = true;
			continue;
		}

		// Check hold modifier (AND) then trigger (any-of OR)
		if (b.holdMask && (buttons & b.holdMask) != b.holdMask)
			continue;
		if (b.trigMask && (buttons & b.trigMask) == 0)
			continue;

		switch (b.outType) {
		case LZ_OUT_MOUSE_BTN:
			if (!b.trigMask || (buttons & b.trigMask))
				outMBtn |= b.outData[0];
			break;

		case LZ_OUT_KBD_CHORD:
			// suppress if trig bits already claimed by a hold-modifier binding
			if (b.holdMask == 0 && b.trigMask != 0 &&
			    (b.trigMask & kbdConsumed))
				break;
			outMod |= b.outData[0];
			for (int j = 1; j < 7 && b.outData[j]; j++) {
				if (nKeys < 6)
					outKeys[nKeys++] = b.outData[j];
			}
			// claim trig bits so simpler bindings don't double-fire
			if (b.holdMask != 0)
				kbdConsumed |= b.trigMask;
			break;

		case LZ_OUT_CONSUMER:
			if (g_usbMode == MODE_LIZARD)
				consumerBits |= b.outData[0];
			break;

		default:
			break;
		}
	}
}

// Add the virtual stick-deflection bits so bindings can trigger on left-stick direction.
// The LZ_BTN_LSTICK_* flags live on bits 28..31, which OVERLAP real controller inputs: bit 28 = right
// grip touch, bit 29 = left grip touch (PROTOCOL.md §8). Merely holding the controller sets the grip
// bits, which would masquerade as an L-stick deflection and fire the bound key. Clear the top 4 bits of
// the physical word (grips are not a bindable lizard input) so these flags reflect ONLY stick deflection.
static uint64_t lizardButtons(const PuckInput &in)
{
	uint64_t buttons = (uint64_t)in.buttons;
	// the profile-switch buttons (btnmap.h) are the gesture's while the modifier is held, not a binding's
	if (shortcutModifierHeld(in.buttons))
		buttons &= ~(uint64_t)g_gestureMask;
	if (in.lx > 12000)
		buttons |= LZ_BTN_LSTICK_RT;
	if (in.lx < -12000)
		buttons |= LZ_BTN_LSTICK_LF;
	if (in.ly < -12000)
		buttons |= LZ_BTN_LSTICK_DN;
	if (in.ly > 12000)
		buttons |= LZ_BTN_LSTICK_UP;
	if (in.rx > 12000)
		buttons |= LZ_BTN_RSTICK_RT;
	if (in.rx < -12000)
		buttons |= LZ_BTN_RSTICK_LF;
	if (in.ry < -12000)
		buttons |= LZ_BTN_RSTICK_DN;
	if (in.ry > 12000)
		buttons |= LZ_BTN_RSTICK_UP;
	return buttons;
}

// What a stick held at full deflection does per report, after a deadzone, with a squared curve between so small
// deflections are slow enough to aim. One report per RF poll, about 250 a second: 5 px is about 1250 px/s, and
// 0.12 of a wheel notch about 30 notches/s.
#define LZ_STICK_DEAD 5000
#define LZ_STICK_MOUSE_PX 5.0f
#define LZ_STICK_SCROLL_NOTCHES 0.12f
static float lizardStickAxis(int16_t v, float max)
{
	const int a = v < 0 ? -(int)v : (int)v;
	if (a <= LZ_STICK_DEAD)
		return 0;
	float n = (float)(a - LZ_STICK_DEAD) / (float)(32767 - LZ_STICK_DEAD);
	if (n > 1.0f)
		n = 1.0f;
	const float out = max * n * n;
	return v < 0 ? -out : out;
}

// Per-slot glide/scroll integrators + last-sent report state for rfLizard. These are FILE-SCOPE (not
// function-local statics) so rfLizardRelease() can reset them on a lizard->Steam handoff: without that reset
// a key/mouse-button that was DOWN the instant Steam takes over is never released (the change-dedup below
// thinks it is still "down") and sticks on the desktop until a reconnect/power-cycle.
// [PM_RIGHT] / [PM_LEFT]: each pad bound to mouse move glides on its own
enum { PM_RIGHT, PM_LEFT, PM_N };
static int prx[PM_N][NSLOT] = {}, pry[PM_N][NSLOT] = {};
static bool prt[PM_N][NSLOT] = {};
static float vx[PM_N][NSLOT] = {}, vy[PM_N][NSLOT] = {}, rmx = 0, rmy = 0;
static int ply[NSLOT] = { 0 };
static bool plt[NSLOT] = { false };
static float sacc = 0;
static uint8_t pmbtn = 0; // last-sent mouse buttons
static uint8_t prevCC = 0; // last-sent consumer bits
static float lsx = 0, lsy = 0; // stick pointer sub-pixel carry
static float ssc = 0; // stick scroll carry
static uint8_t pmod = 0, pkc[6] = {
	0, 0, 0, 0, 0, 0
}; // last-sent kbd modifier + keycodes

void rfLizard(Adafruit_USBD_HID *mdev, Adafruit_USBD_HID *kdev, uint8_t mrid,
	      uint8_t krid)
{
	// ---- merge binding outputs across every bonded controller ----
	uint8_t outMod = 0;
	uint8_t outKeys[6] = { 0, 0, 0, 0, 0, 0 };
	uint8_t nKeys = 0;
	uint8_t outMBtn = 0;
	LizardAxes ax = {};
	uint8_t consumerBits = 0;

	for (int s = 0; s < NSLOT; s++) {
		if (!g_slot[s].used)
			continue;
		lizardEvalSlot(lizardButtons(g_in[s]), outMod, outKeys, nKeys,
			       outMBtn, consumerBits, ax);
	}

	// ---- trackpads -> mouse motion with glide ----
	// Per-slot, per-pad velocity/last-position so each pad integrates independently; the resulting
	// deltas are SUMMED into one cursor (sub-pixel carry rmx/rmy is shared -- one mouse). State is
	// file-scope (see the block above rfLizard) so rfLizardRelease() can zero it on a handoff.
	int dx = 0, dy = 0;
	if (ax.rpadMouse || ax.lpadMouse) {
		float sumx = 0, sumy = 0;
		float f = g_mFric / 100.0f;
		for (int p = 0; p < PM_N; p++) {
			const bool right = (p == PM_RIGHT);
			const bool bound = right ? ax.rpadMouse : ax.lpadMouse;
			for (int s = 0; s < NSLOT; s++) {
				if (!bound || !g_slot[s].used) {
					vx[p][s] = vy[p][s] = 0;
					prt[p][s] = false;
					continue;
				}
				const PuckInput &in = g_in[s];
				bool touch =
					!g_touchpadDisabled &&
					((in.buttons &
					  (right ? TB_RPADT : TB_LPADT)) != 0);
				int x = right ? in.rpx : in.lpx;
				int y = right ? in.rpy : in.lpy;
				if (touch && prt[p][s]) {
					vx[p][s] += (x - prx[p][s]);
					vy[p][s] += (y - pry[p][s]);
				}
				if (touch) {
					prx[p][s] = x;
					pry[p][s] = y;
				}
				prt[p][s] = touch;
				sumx += vx[p][s];
				sumy += vy[p][s];
				// friction = glide/decay (per slot)
				vx[p][s] *= f;
				vy[p][s] *= f;
				if (vx[p][s] > -1 && vx[p][s] < 1)
					vx[p][s] = 0;
				if (vy[p][s] > -1 && vy[p][s] < 1)
					vy[p][s] = 0;
			}
		}
		// Y inverted; *10 = desktop cursor sensitivity (g_mDiv 64 -> eff 640)
		float mxf = sumx / (float)(g_mDiv * 10) + rmx,
		      myf = -(sumy / (float)(g_mDiv * 10)) + rmy;
		dx = (int)mxf;
		dy = (int)myf;
		rmx = mxf - dx;
		rmy = myf - dy; // sub-pixel carry
		if (dx > 127)
			dx = 127;
		if (dx < -127)
			dx = -127;
		if (dy > 127)
			dy = 127;
		if (dy < -127)
			dy = -127;
	}

	// ---- stick -> mouse motion ----
	// Speed, not position: a held deflection keeps the cursor moving. The carry is shared like the pad's, and
	// every controller's sticks add to the one cursor (both, when both are bound).
	if (ax.lstickMouse || ax.rstickMouse) {
		float sumx = 0, sumy = 0;
		for (int s = 0; s < NSLOT; s++) {
			if (!g_slot[s].used)
				continue;
			if (ax.lstickMouse) {
				sumx += lizardStickAxis(g_in[s].lx,
							LZ_STICK_MOUSE_PX);
				sumy += lizardStickAxis(g_in[s].ly,
							LZ_STICK_MOUSE_PX);
			}
			if (ax.rstickMouse) {
				sumx += lizardStickAxis(g_in[s].rx,
							LZ_STICK_MOUSE_PX);
				sumy += lizardStickAxis(g_in[s].ry,
							LZ_STICK_MOUSE_PX);
			}
		}
		// stick up is positive, the cursor's y grows downward
		float mxf = sumx + lsx, myf = -sumy + lsy;
		int sx = (int)mxf, sy = (int)myf;
		lsx = mxf - sx;
		lsy = myf - sy;
		dx += sx;
		dy += sy;
		if (dx > 127)
			dx = 127;
		if (dx < -127)
			dx = -127;
		if (dy > 127)
			dy = 127;
		if (dy < -127)
			dy = -127;
	} else {
		lsx = lsy = 0;
	}

	// ---- left pad -> scroll wheel ----
	// Per-slot last-position; accumulator shared (one wheel). Reset only when NO controller is scrolling.
	// State is file-scope (see the block above rfLizard) so rfLizardRelease() can zero it on a handoff.
	int dw = 0;
	if (ax.lpadScroll) {
		bool anyTouch = false;
		for (int s = 0; s < NSLOT; s++) {
			if (!g_slot[s].used) {
				plt[s] = false;
				continue;
			}
			const PuckInput &in = g_in[s];
			bool ltouch = !g_touchpadDisabled &&
				      ((in.buttons & TB_LPADT) != 0);
			int ly = in.lpy;
			if (ltouch && plt[s])
				sacc += (ly - ply[s]) / (float)(g_mDiv * 24);
			if (ltouch) {
				ply[s] = ly;
				anyTouch = true;
			}
			plt[s] = ltouch;
		}
		if (!anyTouch)
			sacc = 0;
		dw = (int)sacc;
		sacc -= dw;
	}
	// A stick scrolls as a speed too: up is up, a held deflection keeps the wheel turning. Its carry is its
	// own, so a pad scroll's reset (no finger down) does not eat it.
	if (ax.lstickScroll || ax.rstickScroll) {
		float sum = 0;
		for (int s = 0; s < NSLOT; s++) {
			if (!g_slot[s].used)
				continue;
			if (ax.lstickScroll)
				sum += lizardStickAxis(g_in[s].ly,
						       LZ_STICK_SCROLL_NOTCHES);
			if (ax.rstickScroll)
				sum += lizardStickAxis(g_in[s].ry,
						       LZ_STICK_SCROLL_NOTCHES);
		}
		const float wf = sum + ssc;
		const int n = (int)wf;
		ssc = wf - n;
		dw += n;
	} else {
		ssc = 0;
	}
	if (dw > 15)
		dw = 15;
	if (dw < -15)
		dw = -15;

	// ---- mouse report ----
	// Mouse, consumer and keyboard share ONE endpoint (hid[0]) that stays busy
	// until the host next polls. Sending directly under ready() dropped every
	// report after the first in a cycle while the shadow state still advanced,
	// losing key edges whenever the cursor moved; usbTxHid queues them in order.
	if (dx || dy || dw || outMBtn != pmbtn) {
		pmbtn = outMBtn;
		hid_mouse_report_t m;
		m.buttons = outMBtn;
		m.x = (int8_t)dx;
		m.y = (int8_t)dy;
		m.wheel = (int8_t)dw;
		m.pan = 0;
		usbTxHid(mdev, mrid, &m, sizeof m);
	}

	// ---- consumer control (edge-triggered) ----
	if (g_usbMode == MODE_LIZARD) {
		if (consumerBits != prevCC) {
			usbTxHid(mdev, 0x03, &consumerBits, 1);
			prevCC = consumerBits;
		}
	}

	// ---- keyboard report ----
	bool chg = (outMod != pmod);
	for (int i = 0; i < 6; i++)
		if (outKeys[i] != pkc[i])
			chg = true;
	if (chg) {
		pmod = outMod;
		for (int i = 0; i < 6; i++)
			pkc[i] = outKeys[i];
		uint8_t krep[8] = { outMod,	0,	    outKeys[0],
				    outKeys[1], outKeys[2], outKeys[3],
				    outKeys[4], outKeys[5] };
		usbTxHid(kdev, krid, krep, 8);
	}
}

// Release everything lizard may currently be holding on the host, then clear the last-sent dedup + glide
// state so a later re-entry re-asserts from scratch. Called by puck_hid when Steam TAKES OVER (the
// lizard->gamepad handoff): that transition is a pure runtime flip with NO USB re-enumeration, so a
// keyboard key / mouse button / consumer key that was DOWN at that instant would otherwise stay latched on
// the desktop until a reconnect or power-cycle (the reported "stuck input after switching modes"). Sends the
// neutral reports unconditionally (not change-gated) because the whole point is to override a stale held
// state that the dedup would suppress. Same usbTxHid path rfLizard uses.
void rfLizardRelease(Adafruit_USBD_HID *mdev, Adafruit_USBD_HID *kdev,
		     uint8_t mrid, uint8_t krid)
{
	uint8_t krep[8] = { 0, 0, 0, 0, 0, 0, 0, 0 }; // all keys + modifiers up
	usbTxHid(kdev, krid, krep, 8);
	hid_mouse_report_t m = { 0, 0, 0, 0, 0 }; // no buttons, no motion/wheel
	usbTxHid(mdev, mrid, &m, sizeof m);
	if (g_usbMode == MODE_LIZARD) {
		uint8_t cc = 0; // release any held consumer-control key
		usbTxHid(mdev, 0x03, &cc, 1);
	}
	// Zero the integrators + last-sent shadows so re-entry starts clean (no cursor fling from stale
	// velocity, and held keys/buttons re-send correctly on the next rfLizard pass).
	memset(prx, 0, sizeof prx);
	memset(pry, 0, sizeof pry);
	memset(prt, 0, sizeof prt);
	memset(vx, 0, sizeof vx);
	memset(vy, 0, sizeof vy);
	for (int s = 0; s < NSLOT; s++) {
		ply[s] = 0;
		plt[s] = false;
	}
	rmx = rmy = sacc = lsx = lsy = ssc = 0;
	pmbtn = 0;
	prevCC = 0;
	pmod = 0;
	for (int i = 0; i < 6; i++)
		pkc[i] = 0;
}
