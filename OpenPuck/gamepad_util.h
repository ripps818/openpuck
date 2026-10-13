// gamepad_util.h -- shared helpers for building host USB gamepad reports from g_in.
//
// These are reused across the DualSense / DS4 / Switch personalities: analog-stick rescaling, Steam-trackpad
// -> absolute-touch mapping, and the PlayStation-layout button/hat/face/shoulder packers. Per-target button
// button remapping (paddles, QAM, A/B swap) is in remap.h; only the cross-mode pieces are here.
#pragma once
#include <stdint.h>
#include "triton.h"

// int16 stick (center 0) -> uint8 (center 0x80), optional axis invert (HID Y is down-positive).
uint8_t swStick(int16_t v, bool invert);

// Write a signed 16-bit value little-endian.
static inline void le16(uint8_t *p, int16_t v)
{
	p[0] = (uint8_t)(v & 0xFF);
	p[1] = (uint8_t)((v >> 8) & 0xFF);
}

// Fill a DS4/DualSense motion-calibration feature report PAYLOAD. The TinyUSB GET_REPORT path already wrote the
// report id and hands us the buffer PAST it, so our offsets = the kernel's buf[] index minus one (bias at 0..5,
// stays zero from the caller's memset). Zero bias + symmetric non-zero ranges so hid-playstation's/hid-sony's
// divisor (|plus-bias|+|minus-bias|, and gyro speed_plus+speed_minus) is never zero. Shared by report 0x02 (DS4)
// and 0x05 (DualSense) -- identical layout; the caller returns size-1 and leaves trailing bytes zero.
void psNeutralCalib(uint8_t *buf);

// SC2 IMU -> PlayStation (DualSense / DS4) IMU, written as six little-endian int16s at out[0..11]:
// gyro X/Y/Z then accel X/Y/Z (contiguous in both the DualSense report at payload 15 and the DS4 report at
// payload 12).
//
// TWO things have to line up or motion reads wrong on the host:
//  - FRAME. The host expects the axes SDL's own SC2 driver produces (SDL_hidapi_steam_triton.c):
//    X <- +x, Y <- +z, Z <- -y, the SAME signed permutation for gyro AND accel. Using the SC2 frame
//    verbatim for the accel (as this code used to) puts gravity on PS Z instead of PS Y and gives the accel
//    the opposite handedness to the gyro -- so anything that FUSES them (Cemu, rpcs3, console motion) latches
//    into a rotated solution. See mode_switch_pro's IMU comment for the same lesson on the Switch side.
//  - SCALE. The SC2 accelerometer is +/-2g over the full int16 (~16384 counts/g); a DualSense/DS4 reports
//    8192 counts/g (DS_ACCEL_RES_PER_G), so halve it. Gyro needs no scaling: SC2 is 2000 dps full-scale
//    (~16.384 counts/dps) against the PS pads' 16 counts/dps -- 0.4% apart. psNeutralCalib() presents the
//    matching calibration so hosts that trust it land on the same numbers as hosts that fall back to raw.
void psImuPack(uint8_t *out, const PuckInput &in);
void padClickEdge(uint8_t slot, uint32_t clicks);
// Play a movement tick each time a finger on either pad has travelled the active type's tick spacing. Call
// every loop while Trackpad haptics is On with a tick level; it reads the slot's pad positions itself.
void padTickMove(uint8_t slot);

// Steam trackpad s16 coords -> absolute touch surface. TOUCH_PAD_W is split into left/right halves so both
// pads can co-exist as two contacts on a single DualSense/DS4 touchpad.
#define TOUCH_PAD_W 1920u
uint16_t padNormU16(int16_t v, uint16_t maxv);
uint16_t touchHalfX(int16_t v, bool rightHalf);
uint16_t touchYInv(int16_t v, uint16_t height);
void touchPackPoint(uint8_t *base, int finger, bool touch, uint16_t x,
		    uint16_t y);
// DualSense / DS4: many hosts only honor contact slot 0 -- put a lone pad in slot 0, both pads in 0+1.
void touchPackPads(uint8_t *pts, bool lTouch, bool rTouch, uint16_t lx,
		   uint16_t ly, uint16_t rx, uint16_t ry);
void touchPackPadsStateful(uint8_t stateSlot, uint8_t *pts, bool lTouch,
			   bool rTouch, uint16_t lx, uint16_t ly, uint16_t rx,
			   uint16_t ry);
void steamPadsToTouch(uint32_t b, uint16_t touchH, int16_t lpx, int16_t lpy,
		      int16_t rpx, int16_t rpy, uint16_t *lx, uint16_t *ly,
		      uint16_t *rx, uint16_t *ry);

// Trackpad -> analog stick blend (WebUI "map trackpad to joystick", g_padStick). A pad mapped to a stick
// BLENDS with it rather than replacing it: while the pad is touched each axis reports whichever of the two
// sources is deflected further from center (signed), so pad and stick stay usable at the same time. An
// untouched pad contributes nothing and the physical stick passes through unchanged -- which also means a
// release can never leave a stale pad value stuck on the axis. b = raw TB_* buttons (touch bits); the
// sticks are updated in place.
void padStickBlend(uint32_t b, int16_t lpx, int16_t lpy, int16_t rpx,
		   int16_t rpy, int16_t *lx, int16_t *ly, int16_t *rx,
		   int16_t *ry);

// D-pad bits (TB_D*) from the trackpads set to a D-pad mode (PS_DPAD_TOUCH / PS_DPAD_CLICK). raw = TB_* buttons.
uint32_t padDpadBits(uint32_t raw, int16_t lpx, int16_t lpy, int16_t rpx,
		     int16_t rpy);
static inline uint32_t padDpadButtons(const PuckInput &in)
{
	return padDpadBits(in.buttons, in.lpx, in.lpy, in.rpx, in.rpy);
}
// raw with the D-pad bits added, for every emulated mode's report builder ahead of the remap. A pad on
// D-pad-on-click spends its click on the D-pad, so the click's own mapping (touchpad click, mouse button)
// doesn't fire with it.
uint32_t padDpadApply(uint32_t raw, int16_t lpx, int16_t lpy, int16_t rpx,
		      int16_t rpy);
static inline uint32_t padDpadApplyIn(const PuckInput &in)
{
	return padDpadApply(in.buttons, in.lpx, in.lpy, in.rpx, in.rpy);
}
// the same from a raw 0x45 report, for the modes that decode it in place (16/18 left pad, 22/24 right pad)
static inline uint32_t padDpadApplyRaw(const uint8_t *r)
{
	return padDpadApply(btnsOf(r), (int16_t)s16off(r, 16),
			    (int16_t)s16off(r, 18), (int16_t)s16off(r, 22),
			    (int16_t)s16off(r, 24));
}
// The pulse for a click on a pad in a D-pad mode (the active type's D-pad click feedback). Called for every
// controller each loop in the emulated modes.
void padDpadClickFeedback(uint8_t slot);

// g_in[slot] sticks with padStickBlend applied -- what every emulated mode should send to the host.
void slotSticks(uint8_t slot, int16_t *lx, int16_t *ly, int16_t *rx,
		int16_t *ry);

// The host's buttons for one controller: the shortcut chords taken out, the button remap applied, and the
// Quick Access + Select target added while that chord is held (capture reports the Switch's Capture button, for
// the modes that have one). raw = TB_* buttons of the controller in `slot`.
uint32_t remapHostButtons(uint8_t slot, uint32_t raw, bool *capture = nullptr);
// PlayStation-layout button packing (shared by mode_ps5 + mode_hidgyro).
static inline uint32_t psButtonsFromSteam(uint8_t slot, uint32_t raw)
{
	return remapHostButtons(slot, raw);
}
// L1..R3 + Create/Options byte. lt/rt are the per-slot analog trigger values so the digital ZL/ZR trip
// doesn't leak across slots when several slots are active.
uint8_t psShouldersByte(uint32_t b, uint8_t lt, uint8_t rt);
uint8_t psHatNibble(uint32_t b); // d-pad -> 8-way hat (8 = neutral)
uint8_t psFaceNibble(uint32_t b); // face buttons
