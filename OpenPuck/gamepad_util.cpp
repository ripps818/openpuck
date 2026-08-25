#include "gamepad_util.h"
#include "triton.h"
#include "config.h"

void psNeutralCalib(uint8_t *buf)
{
	// Payload offsets = kernel buf[] index minus 1. buf[0..5] gyro bias stays zero (caller memset).
	//
	// The numbers are not arbitrary: every consumer turns them into a SENSITIVITY and sanity-checks it.
	//  - gyro: hid-playstation/hid-sony scale by (speed_plus+speed_minus)*1024 / (|plus|+|minus|), and SDL
	//    computes the same ratio and REJECTS the whole calibration unless it is within 50% of 64 (its
	//    divisor). 4096 = 16 * 256 lands the ratio exactly on 64 -> reported deg/s = raw/16, which matches
	//    the SC2's ~16.384 counts/dps. (The old 2844/2844 pair produced a ratio of 1024 = 16x too fast on
	//    Linux/SteamOS, and was thrown out as "bad calibration" by SDL.)
	//  - accel: scale is 2*8192/(plus-minus), so +/-8192 = unity, and psImuPack() already halves the SC2
	//    accel into the pads' 8192-counts/g scale. Keep the range at +/-8192, NOT +/-16384: SDL computes
	//    the span in an Sint16 (sAccXPlus - sAccXMinus), so a 32768-wide range overflows and the
	//    calibration is discarded.
	le16(buf + 6, 4096);
	le16(buf + 8, -4096); // gyro pitch +/-
	le16(buf + 10, 4096);
	le16(buf + 12, -4096); // gyro yaw +/-
	le16(buf + 14, 4096);
	le16(buf + 16, -4096); // gyro roll +/-
	le16(buf + 18, 256);
	le16(buf + 20, 256); // gyro speed +/- (sum != 0)
	le16(buf + 22, 8192);
	le16(buf + 24, -8192); // accel X +/-
	le16(buf + 26, 8192);
	le16(buf + 28, -8192); // accel Y +/-
	le16(buf + 30, 8192);
	le16(buf + 32, -8192); // accel Z +/-
}

// Negate without the -32768 trap (its positive twin does not exist in int16).
static inline int16_t neg16(int16_t v)
{
	return v == -32768 ? (int16_t)32767 : (int16_t)-v;
}

void psImuPack(uint8_t *out, const PuckInput &in)
{
	le16(out + 0, in.gx);
	le16(out + 2, in.gz);
	le16(out + 4, neg16(in.gy));
	le16(out + 6, (int16_t)(in.ax / 2));
	le16(out + 8, (int16_t)(in.az / 2));
	le16(out + 10, (int16_t)(-(in.ay / 2)));
}

uint8_t swStick(int16_t v, bool invert)
{
	int32_t a = 0x80 + (invert ? -((int32_t)v >> 8) : ((int32_t)v >> 8));
	if (a < 0)
		a = 0;
	if (a > 255)
		a = 255;
	return (uint8_t)a;
}

// Pick whichever of the two sources is deflected further from center, keeping its sign. -32768 has no
// positive twin in int16, so clamp its magnitude to 32767 before comparing -- otherwise the negation
// overflows and a full-left stick would lose to anything.
static inline int16_t strongerAxis(int16_t a, int16_t b)
{
	int32_t ma = (a == -32768) ? 32767 : (a < 0 ? -(int32_t)a : (int32_t)a);
	int32_t mb = (b == -32768) ? 32767 : (b < 0 ? -(int32_t)b : (int32_t)b);
	return (ma >= mb) ? a : b;
}

void padStickBlend(uint32_t b, int16_t lpx, int16_t lpy, int16_t rpx,
		   int16_t rpy, int16_t *lx, int16_t *ly, int16_t *rx,
		   int16_t *ry)
{
	// pad index 0 = left pad, 1 = right pad; both share the same s16, center-0 coordinate space as the sticks
	const int16_t px[2] = { lpx, rpx };
	const int16_t py[2] = { lpy, rpy };
	const bool touch[2] = { (b & TB_LPADT) != 0, (b & TB_RPADT) != 0 };
	for (int pad = 0; pad < 2; pad++) {
		int16_t *sx, *sy;
		if (g_padStick[pad] == PS_LEFT) {
			sx = lx;
			sy = ly;
		} else if (g_padStick[pad] == PS_RIGHT) {
			sx = rx;
			sy = ry;
		} else
			continue;
		// An untouched pad contributes NOTHING rather than forcing center, so the physical
		// stick keeps working while the pad is idle. (No touch means no pad value that could
		// get stuck on the axis after a release.)
		if (!touch[pad])
			continue;
		// Both sources live: send whichever is pushed further, per axis, sign preserved.
		*sx = strongerAxis(*sx, px[pad]);
		*sy = strongerAxis(*sy, py[pad]);
	}
}

void slotSticks(uint8_t slot, int16_t *lx, int16_t *ly, int16_t *rx,
		int16_t *ry)
{
	const PuckInput &in = g_in[slot];
	*lx = in.lx;
	*ly = in.ly;
	*rx = in.rx;
	*ry = in.ry;
	padStickBlend(in.buttons, in.lpx, in.lpy, in.rpx, in.rpy, lx, ly, rx,
		      ry);
}

// Map Steam trackpad s16 coords into a 0..max axis (centered touch -> mid-range).
uint16_t padNormU16(int16_t v, uint16_t maxv)
{
	int32_t t = ((int32_t)v + 32768);
	if (t < 0)
		t = 0;
	if (t > 65535)
		t = 65535;
	return (uint16_t)((t * (int32_t)maxv) / 65535);
}
uint16_t touchHalfX(int16_t v, bool rightHalf)
{
	uint16_t halfMax = TOUCH_PAD_W / 2 - 1;
	uint16_t x = padNormU16(v, halfMax);
	return rightHalf ? (uint16_t)(TOUCH_PAD_W / 2 + x) : x;
}
uint16_t touchYInv(int16_t v, uint16_t height)
{
	uint16_t maxy = height - 1;
	return (uint16_t)(maxy - padNormU16(v, maxy));
}
void touchPackPoint(uint8_t *base, int finger, bool touch, uint16_t x,
		    uint16_t y)
{
	uint8_t *f = base + finger * 4;
	if (!touch) {
		f[0] = 0x80;
		f[1] = 0;
		f[2] = 0;
		f[3] = 0;
		return;
	}
	f[0] = (uint8_t)(finger & 0x7F);
	f[1] = (uint8_t)(x & 0xFF);
	f[2] = (uint8_t)(((x >> 8) & 0x0F) | ((y & 0x0F) << 4));
	f[3] = (uint8_t)((y >> 4) & 0xFF);
}
void touchPackPads(uint8_t *pts, bool lTouch, bool rTouch, uint16_t lx,
		   uint16_t ly, uint16_t rx, uint16_t ry)
{
	touchPackPoint(pts, 0, false, 0, 0);
	touchPackPoint(pts, 1, false, 0, 0);
	if (lTouch && rTouch) {
		touchPackPoint(pts, 0, true, lx, ly);
		touchPackPoint(pts, 1, true, rx, ry);
	} else if (lTouch) {
		touchPackPoint(pts, 0, true, lx, ly);
	} else if (rTouch) {
		touchPackPoint(pts, 0, true, rx, ry);
	}
}
void steamPadsToTouch(uint32_t b, uint16_t touchH, int16_t lpx, int16_t lpy,
		      int16_t rpx, int16_t rpy, uint16_t *lx, uint16_t *ly,
		      uint16_t *rx, uint16_t *ry)
{
	bool lt = (b & TB_LPADT) || (b & TB_LPADC),
	     rt = (b & TB_RPADT) || (b & TB_RPADC);
	*lx = touchHalfX(lpx, false);
	*ly = touchYInv(lpy, touchH);
	*rx = touchHalfX(rpx, true);
	*ry = touchYInv(rpy, touchH);
	if (lt && !(b & TB_LPADT)) {
		*lx = TOUCH_PAD_W / 4;
		*ly = touchH / 2;
	}
	if (rt && !(b & TB_RPADT)) {
		*rx = TOUCH_PAD_W / 4 * 3;
		*ry = touchH / 2;
	}
}

// Map g_back[] paddle code -> Steam button flags (same codes as codeToXB / codeToSwitch).
static void psOrBackCode(uint32_t *b, uint8_t c)
{
	switch (c) {
	case 1:
		*b |= TB_A;
		break;
	case 2:
		*b |= TB_B;
		break;
	case 3:
		*b |= TB_X;
		break;
	case 4:
		*b |= TB_Y;
		break;
	case 5:
		*b |= TB_LB;
		break;
	case 6:
		*b |= TB_RB;
		break;
	case 7:
		*b |= TB_L3;
		break;
	case 8:
		*b |= TB_R3;
		break;
	// 9 = Select-side (Create/Share), 10 = Start-side (Options) -- TB_VIEW/TB_MENU are named backwards
	// with respect to the physical buttons, see tritonFromCode() and triton.h.
	case 9:
		*b |= TB_MENU;
		break;
	case 10:
		*b |= TB_VIEW;
		break;
	case 11:
		*b |= TB_STEAM;
		break;
	case 12:
		*b |= TB_DUP;
		break;
	case 13:
		*b |= TB_DDN;
		break;
	case 14:
		*b |= TB_DLF;
		break;
	case 15:
		*b |= TB_DRT;
		break;
	case 16:
		*b |= TB_TOUCH;
		break;
	case 17:
		*b |= TB_MUTE;
		break;
	case 19:
		*b |= TB_L2; // left trigger (L2)
		break;
	case 20:
		*b |= TB_R2; // right trigger (R2)
		break;
	default:
		break;
	}
}
uint32_t psButtonsFromSteam(uint32_t raw)
{
	uint32_t b = raw;
	if (g_qamMap && (b & TB_QAM)) {
		b &= ~(uint32_t)TB_QAM;
		b |= tritonFromCode(g_qamMap);
	}
	if ((b & CHORD_BACK4) == CHORD_BACK4)
		b &= ~(uint32_t)(TB_A | TB_B | TB_X | TB_Y | TB_DUP | TB_DDN |
				 TB_DLF | TB_DRT);
	if (b & TB_L4)
		psOrBackCode(&b, g_back[0]);
	if (b & TB_R4)
		psOrBackCode(&b, g_back[1]);
	if (b & TB_L5)
		psOrBackCode(&b, g_back[2]);
	if (b & TB_R5)
		psOrBackCode(&b, g_back[3]);
	return b;
}
// DualSense / DS4 buttons[1]: L1..R3, Create(Share), Options(Start). The analog trigger values come from
// the per-slot `g_in[slot]` (pass lt/rt explicitly so a single shoulder byte never leaks across slots).
uint8_t psShouldersByte(uint32_t b, uint8_t lt, uint8_t rt)
{
	return ((b & TB_LB) ? 0x01 : 0) | ((b & TB_RB) ? 0x02 : 0) |
	       ((lt > SW_TRIG_ON || (b & 0x8000000u)) ? 0x04 : 0) |
	       ((rt > SW_TRIG_ON || (b & 0x800000u)) ? 0x08 : 0) |
	       // 0x10 = Create/Share, 0x20 = Options; TB_MENU/TB_VIEW are the
	       // Select/Start-side buttons respectively (see triton.h)
	       ((b & TB_MENU) ? 0x10 : 0) | ((b & TB_VIEW) ? 0x20 : 0) |
	       ((b & TB_L3) ? 0x40 : 0) | ((b & TB_R3) ? 0x80 : 0);
}
uint8_t psHatNibble(uint32_t b)
{
	bool u = b & TB_DUP, d = b & TB_DDN, l = b & TB_DLF, r = b & TB_DRT;
	if (u && r)
		return 1;
	if (r && d)
		return 3;
	if (d && l)
		return 5;
	if (l && u)
		return 7;
	if (u)
		return 0;
	if (r)
		return 2;
	if (d)
		return 4;
	if (l)
		return 6;
	return 8;
}
uint8_t psFaceNibble(uint32_t b)
{
	uint8_t f = 0;
	if (g_abSwap) {
		if (b & TB_A)
			f |= 0x40;
		if (b & TB_B)
			f |= 0x20;
		if (b & TB_X)
			f |= 0x80;
		if (b & TB_Y)
			f |= 0x10;
	} else {
		if (b & TB_A)
			f |= 0x20;
		if (b & TB_B)
			f |= 0x40;
		if (b & TB_X)
			f |= 0x10;
		if (b & TB_Y)
			f |= 0x80;
	}
	return f;
}
