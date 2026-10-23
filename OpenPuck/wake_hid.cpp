#include "wake_hid.h"
#include "usb_tx.h"
#include "gamepad_util.h"
#include <Adafruit_TinyUSB.h>

// Boot MOUSE descriptor -- proven to enumerate and wake Windows. The host enumerates a "HID-compliant mouse"
// child and arms IT as the wake source, so the wake nudge (wakeHidMove, driven from the puck wake path) must
// ride THIS interface -- a report on the gamepad slot lands on an interface the host never allow-listed. (A boot
// keyboard didn't enumerate on Windows and suppressed the wake the mouse class provides.)
static const uint8_t WAKE_HID_DESC[] = { TUD_HID_REPORT_DESC_MOUSE() };

// Puck modes: Linux hid-steam (7.3+) claims every 28DE:1305 HID interface as a
// controller slot unless its FIRST collection is FF00:0002 (the real puck's
// pogo-pin interface), then fails a dongle-status GET on our mouse (-22 in
// dmesg). Lead with that collection so it is skipped like the pogo interface.
// Two top-level collections need report IDs; the vendor one is never sent.
#define WAKE_MOUSE_RID 1
static const uint8_t WAKE_HID_DESC_PUCK[] = {
	HID_USAGE_PAGE_N(HID_USAGE_PAGE_VENDOR, 2),
	HID_USAGE(0x02),
	HID_COLLECTION(HID_COLLECTION_APPLICATION),
	HID_REPORT_ID(2) HID_USAGE(0x02),
	HID_LOGICAL_MIN(0),
	HID_LOGICAL_MAX_N(0xFF, 2),
	HID_REPORT_SIZE(8),
	HID_REPORT_COUNT(1),
	HID_INPUT(HID_DATA | HID_VARIABLE | HID_ABSOLUTE),
	HID_COLLECTION_END,
	TUD_HID_REPORT_DESC_MOUSE(HID_REPORT_ID(WAKE_MOUSE_RID))
};
static Adafruit_USBD_HID g_wakeHid;
static bool g_wakeHidPresent = false;
static bool g_wakeHidPuck = false;

static uint16_t wakeGetCb(uint8_t report_id, hid_report_type_t report_type,
			  uint8_t *buffer, uint16_t reqlen)
{
	if (report_type == HID_REPORT_TYPE_FEATURE && buffer && reqlen > 0) {
		memset(buffer, 0, reqlen);
		if ((report_id == 0x05 || report_id == 0x02) && reqlen >= 34)
			psNeutralCalib(buffer);
		return reqlen;
	}
	return 0;
}

void wakeHidBegin(bool puck)
{
	g_wakeHidPuck = puck;
	// boot mouse = a wake device class honored by Windows + Linux
	g_wakeHid.setBootProtocol(HID_ITF_PROTOCOL_MOUSE);
	g_wakeHid.setStringDescriptor("OpenPuck Wake");
	g_wakeHid.setReportCallback(wakeGetCb, NULL);
	if (puck)
		g_wakeHid.setReportDescriptor(WAKE_HID_DESC_PUCK,
					      sizeof WAKE_HID_DESC_PUCK);
	else
		g_wakeHid.setReportDescriptor(WAKE_HID_DESC,
					      sizeof WAKE_HID_DESC);
	g_wakeHid.setPollInterval(10);
	g_wakeHid.begin();
	g_wakeHidPresent = true;
}

bool wakeHidPresent()
{
	return g_wakeHidPresent;
}

bool wakeHidReady()
{
	return g_wakeHidPresent && g_wakeHid.ready();
}

bool wakeHidMove(int8_t dx, int8_t dy)
{
	if (!wakeHidReady())
		return false;
	// boot mouse descriptor has no report ID -> report_id 0; buttons=0 so we move but never click. Queued for
	// the usbd task (usbTxHid) rather than sent inline, like every other report -- loop() issues no tud_* call.
	hid_mouse_report_t m;
	m.buttons = 0;
	m.x = dx;
	m.y = dy;
	m.wheel = 0;
	m.pan = 0;
	// A host in boot protocol (BIOS) expects the bare boot report, no ID.
	uint8_t rid = 0;
	if (g_wakeHidPuck && g_wakeHid.getProtocol() != HID_PROTOCOL_BOOT)
		rid = WAKE_MOUSE_RID;
	usbTxHid(&g_wakeHid, rid, &m, sizeof m);
	return true;
}

void wakeHidAddInterface()
{
	TinyUSBDevice.addInterface(g_wakeHid);
}
