#include "mode_hidgyro.h"
#include "triton.h"
#include "gamepad_util.h"
#include "config.h"
#include "haptics.h"
#include "bonds.h"
#include "usb_mount.h"
#include "usb_tx.h"
#include <Adafruit_TinyUSB.h>
#include <Arduino.h>
#include <string.h>

HidGyroController g_hidGyroCtl;

// Genuine DualShock 4 (054C:05C4) USB HID report descriptor -- all 467 bytes, verbatim from a real pad
// (same bytes ViGEmBus feeds its emulated DS4, which games accept as genuine).
//
// The input/output reports are the ones we actually use -- input 0x01 = 63 payload bytes (+ id = 64 on the
// wire, what hidGyroBuild() sends) and output 0x05 = 31 -- but the long tail of FEATURE declarations is not
// decoration, it is load-bearing on Windows: the HID class driver only routes GET_FEATURE for report ids that
// appear HERE, and sizes the transfer from caps.FeatureReportByteLength. A game identifying a DS4 does that
// by reading feature 0x12 (MAC) / 0xA3 (firmware info) -- the two hidGyroGetCommon() answers -- so with a
// descriptor that declares only 0x02/0x04 those reads fail inside Windows, never reach us, and the game
// concludes the device is not a DualShock 4: no controller at all, even though input reports flow fine
// (joy.cpl, Steam and DS4Windows all work, since they read input reports and treat the feature reads as
// optional). Do not trim this back to "just the reports we implement".
static const uint8_t GYRO_HID_DESC[] = {
	0x05, 0x01, 0x09, 0x05, 0xA1, 0x01, 0x85, 0x01, 0x09, 0x30, 0x09, 0x31,
	0x09, 0x32, 0x09, 0x35, 0x15, 0x00, 0x26, 0xFF, 0x00, 0x75, 0x08, 0x95,
	0x04, 0x81, 0x02, 0x09, 0x39, 0x15, 0x00, 0x25, 0x07, 0x35, 0x00, 0x46,
	0x3B, 0x01, 0x65, 0x14, 0x75, 0x04, 0x95, 0x01, 0x81, 0x42, 0x65, 0x00,
	0x05, 0x09, 0x19, 0x01, 0x29, 0x0E, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01,
	0x95, 0x0E, 0x81, 0x02, 0x06, 0x00, 0xFF, 0x09, 0x20, 0x75, 0x06, 0x95,
	0x01, 0x15, 0x00, 0x25, 0x7F, 0x81, 0x02, 0x05, 0x01, 0x09, 0x33, 0x09,
	0x34, 0x15, 0x00, 0x26, 0xFF, 0x00, 0x75, 0x08, 0x95, 0x02, 0x81, 0x02,
	0x06, 0x00, 0xFF, 0x09, 0x21, 0x95, 0x36, 0x81, 0x02, 0x85, 0x05, 0x09,
	0x22, 0x95, 0x1F, 0x91, 0x02, 0x85, 0x04, 0x09, 0x23, 0x95, 0x24, 0xB1,
	0x02, 0x85, 0x02, 0x09, 0x24, 0x95, 0x24, 0xB1, 0x02, 0x85, 0x08, 0x09,
	0x25, 0x95, 0x03, 0xB1, 0x02, 0x85, 0x10, 0x09, 0x26, 0x95, 0x04, 0xB1,
	0x02, 0x85, 0x11, 0x09, 0x27, 0x95, 0x02, 0xB1, 0x02, 0x85, 0x12, 0x06,
	0x02, 0xFF, 0x09, 0x21, 0x95, 0x0F, 0xB1, 0x02, 0x85, 0x13, 0x09, 0x22,
	0x95, 0x16, 0xB1, 0x02, 0x85, 0x14, 0x06, 0x05, 0xFF, 0x09, 0x20, 0x95,
	0x10, 0xB1, 0x02, 0x85, 0x15, 0x09, 0x21, 0x95, 0x2C, 0xB1, 0x02, 0x06,
	0x80, 0xFF, 0x85, 0x80, 0x09, 0x20, 0x95, 0x06, 0xB1, 0x02, 0x85, 0x81,
	0x09, 0x21, 0x95, 0x06, 0xB1, 0x02, 0x85, 0x82, 0x09, 0x22, 0x95, 0x05,
	0xB1, 0x02, 0x85, 0x83, 0x09, 0x23, 0x95, 0x01, 0xB1, 0x02, 0x85, 0x84,
	0x09, 0x24, 0x95, 0x04, 0xB1, 0x02, 0x85, 0x85, 0x09, 0x25, 0x95, 0x06,
	0xB1, 0x02, 0x85, 0x86, 0x09, 0x26, 0x95, 0x06, 0xB1, 0x02, 0x85, 0x87,
	0x09, 0x27, 0x95, 0x23, 0xB1, 0x02, 0x85, 0x88, 0x09, 0x28, 0x95, 0x22,
	0xB1, 0x02, 0x85, 0x89, 0x09, 0x29, 0x95, 0x02, 0xB1, 0x02, 0x85, 0x90,
	0x09, 0x30, 0x95, 0x05, 0xB1, 0x02, 0x85, 0x91, 0x09, 0x31, 0x95, 0x03,
	0xB1, 0x02, 0x85, 0x92, 0x09, 0x32, 0x95, 0x03, 0xB1, 0x02, 0x85, 0x93,
	0x09, 0x33, 0x95, 0x0C, 0xB1, 0x02, 0x85, 0xA0, 0x09, 0x40, 0x95, 0x06,
	0xB1, 0x02, 0x85, 0xA1, 0x09, 0x41, 0x95, 0x01, 0xB1, 0x02, 0x85, 0xA2,
	0x09, 0x42, 0x95, 0x01, 0xB1, 0x02, 0x85, 0xA3, 0x09, 0x43, 0x95, 0x30,
	0xB1, 0x02, 0x85, 0xA4, 0x09, 0x44, 0x95, 0x0D, 0xB1, 0x02, 0x85, 0xA5,
	0x09, 0x45, 0x95, 0x15, 0xB1, 0x02, 0x85, 0xA6, 0x09, 0x46, 0x95, 0x15,
	0xB1, 0x02, 0x85, 0xF0, 0x09, 0x47, 0x95, 0x3F, 0xB1, 0x02, 0x85, 0xF1,
	0x09, 0x48, 0x95, 0x3F, 0xB1, 0x02, 0x85, 0xF2, 0x09, 0x49, 0x95, 0x0F,
	0xB1, 0x02, 0x85, 0xA7, 0x09, 0x4A, 0x95, 0x01, 0xB1, 0x02, 0x85, 0xA8,
	0x09, 0x4B, 0x95, 0x01, 0xB1, 0x02, 0x85, 0xA9, 0x09, 0x4C, 0x95, 0x08,
	0xB1, 0x02, 0x85, 0xAA, 0x09, 0x4E, 0x95, 0x01, 0xB1, 0x02, 0x85, 0xAB,
	0x09, 0x4F, 0x95, 0x39, 0xB1, 0x02, 0x85, 0xAC, 0x09, 0x50, 0x95, 0x39,
	0xB1, 0x02, 0x85, 0xAD, 0x09, 0x51, 0x95, 0x0B, 0xB1, 0x02, 0x85, 0xAE,
	0x09, 0x52, 0x95, 0x01, 0xB1, 0x02, 0x85, 0xAF, 0x09, 0x53, 0x95, 0x02,
	0xB1, 0x02, 0x85, 0xB0, 0x09, 0x54, 0x95, 0x3F, 0xB1, 0x02, 0xC0
};
#define DS4_TOUCH_H 942
#define DS4_STATUS_USB 0x1B // cable + level 11 (full)
static unsigned long g_gyroLastMs[NSLOT] = { 0 };
// NSLOT HID instances: 4 DS4 gamepads on the wire, one per bond slot. The host enumerates each as a
// separate input device (hid-playstation, hid-sony, SDL, Steam Input).
static Adafruit_USBD_HID g_hidGyro[NSLOT];

// Per-slot MAC base: 4 distinct NICs so the host sees 4 different devices (real DS4s have unique MACs).
// OUI 0x001BDC is Sony's; vary the last byte per slot.
static const uint8_t DS4_MAC_BASE[5] = { 0x00, 0x1B, 0xDC, 0x4F, 0x55 };
static uint8_t g_ds4Mac[NSLOT][6];
static bool g_ds4MacInit = false;
static void initDs4Macs()
{
	if (g_ds4MacInit)
		return;
	for (int s = 0; s < NSLOT; s++) {
		memcpy(g_ds4Mac[s], DS4_MAC_BASE, 5);
		g_ds4Mac[s][5] = (uint8_t)(0x50 + s); // 0x50, 0x51, 0x52, 0x53
	}
	g_ds4MacInit = true;
}

static void hidGyroBuild(uint8_t usbSlot, uint8_t slot, uint8_t out[63]);

// GET_FEATURE and GET_REPORT handler. Per-slot dispatch via per-instance callback.
// Sizes per drivers/hid/hid-playstation.c: 0x02=37, 0x12=16, 0xA3=49; legacy hid-sony MAC 0x81=7.
static uint16_t hidGyroGetCommon(uint8_t slot, uint8_t rid,
				 hid_report_type_t type, uint8_t *buf,
				 uint16_t reqlen)
{
	(void)slot;
	if (!buf || reqlen == 0)
		return 0;
	memset(buf, 0, reqlen);

	// DirectInput and game polling via GET_REPORT(INPUT, 0x01)
	if (type == HID_REPORT_TYPE_INPUT) {
		if ((rid == 0x01 || rid == 0) && reqlen >= 63) {
			int bond = (slot < NSLOT) ? g_usbToBond[slot] : -1;
			if (bond < 0 || !g_slot[bond].used) {
				for (int s = 0; s < NSLOT; s++) {
					if (g_slot[s].used) {
						bond = s;
						break;
					}
				}
			}
			if (bond >= 0)
				hidGyroBuild(slot, (uint8_t)bond, buf);
			return 63;
		}
		return 0;
	}

	if (type != HID_REPORT_TYPE_FEATURE)
		return 0;
	switch (rid) {
	case 0x02: // motion calibration (37 incl id)
		if (reqlen < 36)
			return 0;
		psNeutralCalib(buf);
		return 36;
	case 0x12: // pairing info / MAC, hid-playstation (16 incl id)
		if (reqlen < 15)
			return 0;
		memcpy(buf, g_ds4Mac[slot], 6);
		return 15;
	case 0x81: // MAC, legacy hid-sony USB (7 incl id)
		if (reqlen < 6)
			return 0;
		memcpy(buf, g_ds4Mac[slot], 6);
		return 6;
	case 0xA3: // firmware / hardware info (49 incl id)
		if (reqlen < 48)
			return 0;
		// non-zero version (contents not validated over USB)
		buf[0] = 0x01;
		return 48;
	default:
		return 0;
	}
}
static void hidGyroSetCommon(uint8_t slot, uint8_t rid, hid_report_type_t type,
			     uint8_t const *b, uint16_t n)
{
	if ((type != HID_REPORT_TYPE_OUTPUT &&
	     type != HID_REPORT_TYPE_INVALID) ||
	    n < 1)
		return;
	uint8_t id;
	const uint8_t *p;
	uint16_t pn;
	if (rid == 0) {
		id = b[0];
		p = b + 1;
		pn = (uint16_t)(n - 1);
	} else {
		id = rid;
		p = b;
		pn = n;
	}
	// DS4 USB effects: report 0x05, magic at byte 0, effects block starts at byte 3.
	if (id != 0x05 || pn < 5)
		return;
	// `slot` is the USB slot the report arrived on -> route rumble to its mapped bond slot.
	int bond = (slot < NSLOT) ? g_usbToBond[slot] : -1;
	if (bond < 0)
		return;
	hapticSteamRumble((uint16_t)p[4] * 257u, (uint16_t)p[3] * 257u,
			  (uint8_t)bond); // DS4: left=low, right=high
}
// Per-slot callback trampolines -- the Adafruit HID class has ONE _get/_set pair shared across instances,
// and the lib's tud_hid_*_cb doesn't pass the interface index to the user callback. Generate a
// per-instance trampoline that closes over the slot index, matching the pattern in puck_hid.cpp.
#define HIDGYROCB(N)                                                  \
	static uint16_t hidGyroGet##N(uint8_t r, hid_report_type_t t, \
				      uint8_t *bf, uint16_t rl)       \
	{                                                             \
		return hidGyroGetCommon(N, r, t, bf, rl);             \
	}                                                             \
	static void hidGyroSet##N(uint8_t r, hid_report_type_t t,     \
				  uint8_t const *b, uint16_t n)       \
	{                                                             \
		hidGyroSetCommon(N, r, t, b, n);                      \
	}
// clang-format off
HIDGYROCB(0)
HIDGYROCB(1)
HIDGYROCB(2)
HIDGYROCB(3)
// clang-format on
typedef uint16_t (*ds4_getcb_t)(uint8_t, hid_report_type_t, uint8_t *,
				uint16_t);
typedef void (*ds4_setcb_t)(uint8_t, hid_report_type_t, uint8_t const *,
			    uint16_t);
static ds4_getcb_t const DS4_GETCB[NSLOT] = { hidGyroGet0, hidGyroGet1,
					      hidGyroGet2, hidGyroGet3 };
static ds4_setcb_t const DS4_SETCB[NSLOT] = { hidGyroSet0, hidGyroSet1,
					      hidGyroSet2, hidGyroSet3 };

// usbSlot drives the per-HID counters; slot (bond) is the controller whose decoded input feeds the report.
static void hidGyroBuild(uint8_t usbSlot, uint8_t slot, uint8_t out[63])
{
	uint32_t b = psButtonsFromSteam(g_in[slot].buttons);
	psPadClickEdge(slot, (b & (TB_LPADC | TB_RPADC)) != 0);
	if ((g_in[slot].buttons & CHORD_BACK4) == CHORD_BACK4)
		b &= ~(TB_A | TB_B | TB_X | TB_Y | TB_DDN | TB_DRT | TB_DLF |
		       TB_DUP | TB_LPADC | TB_RPADC);
	// A pad mapped to a stick must NOT also report as a touchpad contact -- the host would read the same
	// finger twice (stick deflection AND a cursor drag).
	bool lTouch = !g_touchpadDisabled && g_padStick[0] == PS_OFF &&
		      ((b & TB_LPADT) || (b & TB_LPADC)),
	     rTouch = !g_touchpadDisabled && g_padStick[1] == PS_OFF &&
		      ((b & TB_RPADT) || (b & TB_RPADC));
	memset(out, 0, 63);
	int16_t lx, ly, rx, ry;
	slotSticks(slot, &lx, &ly, &rx, &ry);
	out[0] = swStick(lx, false);
	out[1] = swStick(ly, true);
	out[2] = swStick(rx, false);
	out[3] = swStick(ry, true);
	out[4] = psHatNibble(b) | psFaceNibble(b);
	out[5] = psShouldersByte(b, g_in[slot].lt, g_in[slot].rt);
	static uint8_t ctr[NSLOT] = { 0 };
	out[6] = ((ctr[usbSlot]++ & 0x0F) << 4) |
		 (((b & TB_TOUCH) ||
		   (!g_touchpadDisabled && (b & (TB_LPADC | TB_RPADC)))) ?
			  0x02 :
			  0) |
		 ((b & TB_STEAM) ? 0x01 : 0);
	out[7] = g_in[slot].lt;
	out[8] = g_in[slot].rt;
	uint16_t ds4ts = (uint16_t)(micros() / 16);
	out[9] = (uint8_t)(ds4ts & 0xFF);
	out[10] = (uint8_t)((ds4ts >> 8) & 0xFF);
	// gyro X/Y/Z then accel X/Y/Z, 6 x le16 (hid-sony: rd[13..] / rd[19..])
	psImuPack(out + 12, g_in[slot]);
	out[29] = DS4_STATUS_USB;
	if (lTouch || rTouch) {
		uint16_t tlx, tly, trx, trry;
		steamPadsToTouch(b, DS4_TOUCH_H, g_in[slot].lpx, g_in[slot].lpy,
				 g_in[slot].rpx, g_in[slot].rpy, &tlx, &tly,
				 &trx, &trry);
		static uint8_t tstamp[NSLOT] = { 0 };
		out[32] = 1;
		out[33] = tstamp[usbSlot]++;
		touchPackPadsStateful(slot, out + 34, lTouch, rTouch, tlx, tly,
				      trx, trry);
	} else {
		out[32] = 0;
		touchPackPadsStateful(
			slot, out + 34, false, false, 0, 0, 0,
			0); // contact 0x80 -- memset(0) reads as touch @0,0
	}
}

// Dynamic-mount mode: begin() is unused (setup() calls beginPool()+usbReenumerate instead).
void HidGyroController::begin()
{
}
// HID budget: clean DS4 (MODE_DS4_GAME) has no wake mouse; normal HIDGYRO keeps it (1 HID).
uint8_t HidGyroController::maxSlots() const
{
	// Clean-PS modes exist to present exactly what a host that CLASSIFIES the USB device expects of a real
	// Sony pad -- GameInput / Windows.Gaming.Input and the native-PlayStation paths in games look at the
	// whole device, not just the VID/PID, and refuse the PS glyph path for a composite. One connected
	// controller = one HID interface = a non-composite device (no MI_xx on Windows). A SECOND controller
	// would add a second interface and make it composite again, so the clean modes are deliberately
	// single-pad; use MODE_PS5 / MODE_HIDGYRO (composite either way, and they keep the panel + host-wake)
	// when you want several controllers at once.
	if (modeIsCleanPS(g_usbMode))
		return 1;
	uint8_t cap = (uint8_t)(CFG_TUD_HID - 1);
	return cap < NSLOT ? cap : (uint8_t)NSLOT;
}
void HidGyroController::usbIdentity()
{
	USBDevice.setID(0x054C, 0x05C4);
	USBDevice.setVersion(0x0200);
	USBDevice.setDeviceVersion(0x0120);
	USBDevice.setManufacturerDescriptor("Sony Computer Entertainment");
	USBDevice.setProductDescriptor("Wireless Controller");
}
void HidGyroController::beginPool()
{
	initDs4Macs();
	uint8_t pool = maxSlots();
	for (uint8_t s = 0; s < pool; s++) {
		g_hidGyro[s].enableOutEndpoint(true);
		g_hidGyro[s].setReportCallback(DS4_GETCB[s], DS4_SETCB[s]);
		g_hidGyro[s].setReportDescriptor(GYRO_HID_DESC,
						 sizeof GYRO_HID_DESC);
		g_hidGyro[s].setPollInterval(1);
		g_hidGyro[s].begin();
	}
}
void HidGyroController::mountSlots(uint8_t k)
{
	for (uint8_t u = 0; u < k; u++)
		USBDevice.addInterface(g_hidGyro[u]);
}
void HidGyroController::task()
{
	for (uint8_t u = 0; u < g_usbMountCount; u++) {
		if (!g_hidGyro[u].ready())
			continue;
		if (millis() - g_gyroLastMs[u] < USB_STREAM_MS)
			continue;
		int bond = g_usbToBond[u];
		if (bond < 0 || !g_slot[bond].used) {
			for (int s = 0; s < NSLOT; s++) {
				if (g_slot[s].used) {
					bond = s;
					break;
				}
			}
		}
		if (bond < 0)
			continue;
		g_gyroLastMs[u] = millis();
		uint8_t p[63];
		hidGyroBuild(u, (uint8_t)bond, p);
		usbTxHid(&g_hidGyro[u], 0x01, p, sizeof p);
	}
}
