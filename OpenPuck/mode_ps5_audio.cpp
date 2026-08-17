#include "mode_ps5_audio.h"
#include "haptics.h"
#include "fault_diag.h"
#include <Arduino.h>
#include <string.h>

#define UAC1_DESC_LEN 111
#define UAC1_ISO_EP_BUFSIZE 384

static uint8_t g_uac1ItfAc = 0xFF;
static uint8_t g_uac1ItfAs = 0xFF;
static uint8_t g_uac1EpOut = 0;
static uint8_t g_uac1AltSetting = 0;

CFG_TUD_MEM_SECTION static uint8_t g_isoOutBuf[UAC1_ISO_EP_BUFSIZE];

Adafruit_USBD_Audio_UAC1 g_ps5Audio;
Adafruit_USBD_Audio_UAC1_AS g_ps5AudioAs;

Adafruit_USBD_Audio_UAC1::Adafruit_USBD_Audio_UAC1()
{
}

uint16_t Adafruit_USBD_Audio_UAC1::getInterfaceDescriptor(uint8_t itfnum,
							  uint8_t *buf,
							  uint16_t bufsize)
{
	if (!buf)
		return UAC1_DESC_LEN;
	if (bufsize < UAC1_DESC_LEN)
		return 0;

	uint8_t ac_itf = itfnum;
	uint8_t as_itf = (uint8_t)(itfnum + 1);
	if (g_uac1EpOut == 0)
		g_uac1EpOut = TinyUSBDevice.allocEndpoint(TUSB_DIR_OUT);
	uint8_t ep_out = g_uac1EpOut;

	g_uac1ItfAc = ac_itf;
	g_uac1ItfAs = as_itf;

	const uint8_t desc[UAC1_DESC_LEN] = {
		// Interface Association Descriptor (IAD) - 8 bytes
		8, TUSB_DESC_INTERFACE_ASSOCIATION, ac_itf, 2, TUSB_CLASS_AUDIO,
		0x00, 0x00, 0,

		// Audio Control (AC) Standard Interface Descriptor - 9 bytes
		9, TUSB_DESC_INTERFACE, ac_itf, 0, 0, TUSB_CLASS_AUDIO, 0x01,
		0x00, 0,

		// AC Class-Specific Header Descriptor - 9 bytes
		9, 0x24, 0x01, 0x00, 0x01, 42, 0x00, 1, as_itf,

		// Input Terminal Descriptor (USB Streaming, 4ch) - 12 bytes
		12, 0x24, 0x02, 0x01, 0x01, 0x01, 0x00, 4, 0x33, 0x00, 0x00, 0,

		// Feature Unit Descriptor (Mute / Volume) - 12 bytes
		12, 0x24, 0x06, 0x02, 0x01, 0x01, 0x01, 0x02, 0x02, 0x02, 0x02,
		0,

		// Output Terminal Descriptor (Speaker) - 9 bytes
		9, 0x24, 0x03, 0x03, 0x01, 0x03, 0x00, 0x02, 0,

		// Audio Streaming (AS) Standard Interface Descriptor (Alt 0) - 9 bytes
		9, TUSB_DESC_INTERFACE, as_itf, 0, 0, TUSB_CLASS_AUDIO, 0x02,
		0x00, 0,

		// Audio Streaming (AS) Standard Interface Descriptor (Alt 1) - 9 bytes
		9, TUSB_DESC_INTERFACE, as_itf, 1, 1, TUSB_CLASS_AUDIO, 0x02,
		0x00, 0,

		// AS Class-Specific General Descriptor - 7 bytes
		7, 0x24, 0x01, 0x01, 0x01, 0x01, 0x00,

		// AS Class-Specific Format Type I Descriptor (PCM 4ch 16-bit 48kHz) - 11 bytes
		11, 0x24, 0x02, 0x01, 4, 2, 16, 1, 0x80, 0xBB, 0x00,

		// Standard Isochronous Audio Data Endpoint Descriptor - 9 bytes
		9, TUSB_DESC_ENDPOINT, ep_out, 0x09,
		U16_TO_U8S_LE(UAC1_ISO_EP_BUFSIZE), 1, 0, 0,

		// Class-Specific Audio Data Endpoint Descriptor - 7 bytes
		7, 0x25, 0x01, 0x01, 0, 0, 0
	};

	memcpy(buf, desc, UAC1_DESC_LEN);
	return UAC1_DESC_LEN;
}

bool Adafruit_USBD_Audio_UAC1::begin()
{
	return TinyUSBDevice.addInterface(*this);
}

// 16-bit linear PCM to 8-bit u-law conversion (ITU-T G.711)
static uint8_t pcm2ulaw(int16_t pcm_val)
{
	int16_t mask;
	int16_t seg;
	uint8_t uval;

	pcm_val = (int16_t)(pcm_val >> 2);
	if (pcm_val < 0) {
		pcm_val = (int16_t)(-pcm_val);
		mask = 0x7F;
	} else {
		mask = 0xFF;
	}
	if (pcm_val > 8159)
		pcm_val = 8159;

	pcm_val = (int16_t)(pcm_val + 0x84);

	if (pcm_val >= 0x4000)
		seg = 7;
	else if (pcm_val >= 0x2000)
		seg = 6;
	else if (pcm_val >= 0x1000)
		seg = 5;
	else if (pcm_val >= 0x0800)
		seg = 4;
	else if (pcm_val >= 0x0400)
		seg = 3;
	else if (pcm_val >= 0x0200)
		seg = 2;
	else if (pcm_val >= 0x0100)
		seg = 1;
	else
		seg = 0;

	uval = (uint8_t)((seg << 4) | ((pcm_val >> (seg + 3)) & 0x0F));
	return (uint8_t)(uval ^ mask);
}

static void processAudioSamples(const uint8_t *data, uint32_t len)
{
	if (len < 8)
		return;

	uint32_t num_frames = len / 8;
	uint8_t ulaw_out[16];
	uint32_t out_cnt = 0;

	// 12:1 decimation (48kHz -> 4kHz)
	for (uint32_t i = 0; i < num_frames; i += 12) {
		const int16_t *s = (const int16_t *)(data + i * 8);
		// Mix Left (ch0) and Right (ch1) haptic channels
		int32_t mixed = ((int32_t)s[0] + (int32_t)s[1]) / 2;
		if (out_cnt < sizeof ulaw_out)
			ulaw_out[out_cnt++] = pcm2ulaw((int16_t)mixed);
	}

	if (out_cnt > 0)
		relayEnqueue(0x82, ulaw_out, (uint8_t)out_cnt, 0xFF);
}

// TinyUSB class driver implementation for UAC1
static void uac1_init(void)
{
}

static void uac1_reset(uint8_t rhport)
{
	(void)rhport;
	g_uac1AltSetting = 0;
}

static uint16_t uac1_open(uint8_t rhport, tusb_desc_interface_t const *itf_desc,
			  uint16_t max_len)
{
	(void)rhport;
	(void)max_len;
	if (itf_desc->bInterfaceClass != TUSB_CLASS_AUDIO)
		return 0;

	if (itf_desc->bInterfaceSubClass == 0x01)
		return sizeof(tusb_desc_interface_t) + 9 + 12 + 12 + 9;
	else if (itf_desc->bInterfaceSubClass == 0x02)
		return sizeof(tusb_desc_interface_t);
	return 0;
}

static bool uac1_control_xfer_cb(uint8_t rhport, uint8_t stage,
				 tusb_control_request_t const *request)
{
	if (stage != CONTROL_STAGE_SETUP)
		return true;

	if (request->bmRequestType_bit.type == TUSB_REQ_TYPE_STANDARD) {
		if (request->bRequest == TUSB_REQ_SET_INTERFACE) {
			uint8_t itf = tu_u16_low(request->wIndex);
			uint8_t alt = tu_u16_low(request->wValue);
			if (itf == g_uac1ItfAs) {
				g_uac1AltSetting = alt;
				if (alt == 1 && g_uac1EpOut) {
					// Explicitly set ISOSPLIT to HalfIN so ISO OUT gets buffer allocation!
					NRF_USBD->ISOSPLIT =
						USBD_ISOSPLIT_SPLIT_HalfIN;
					usbd_edpt_xfer(rhport, g_uac1EpOut,
						       g_isoOutBuf,
						       sizeof g_isoOutBuf);
				}
			}
			return tud_control_status(rhport, request);
		}
	} else if (request->bmRequestType_bit.type == TUSB_REQ_TYPE_CLASS) {
		if (request->bRequest == 0x01) { // SET_CUR
			return tud_control_xfer(rhport, request, g_isoOutBuf,
						tu_u16_low(request->wLength));
		} else if (request->bRequest == 0x81) { // GET_CUR
			uint8_t resp[3] = { 0x80, 0xBB, 0x00 }; // 48000 Hz
			return tud_control_xfer(rhport, request, resp, 3);
		}
	}
	return false;
}

static bool uac1_xfer_cb(uint8_t rhport, uint8_t ep_addr, xfer_result_t result,
			 uint32_t xferred_bytes)
{
	if (ep_addr == g_uac1EpOut && result == XFER_RESULT_SUCCESS) {
		if (xferred_bytes > 0)
			processAudioSamples(g_isoOutBuf, xferred_bytes);
		// Explicitly keep ISOSPLIT set
		NRF_USBD->ISOSPLIT = USBD_ISOSPLIT_SPLIT_HalfIN;
		usbd_edpt_xfer(rhport, g_uac1EpOut, g_isoOutBuf,
			       sizeof g_isoOutBuf);
		return true;
	}
	return false;
}

static const usbd_class_driver_t g_uac1Driver = {
#if CFG_TUSB_DEBUG >= 2
	.name = "UAC1",
#endif
	.init = uac1_init,
	.reset = uac1_reset,
	.open = uac1_open,
	.control_xfer_cb = uac1_control_xfer_cb,
	.xfer_cb = uac1_xfer_cb,
	.sof = NULL
};

const usbd_class_driver_t *uac1_get_driver(void)
{
	return &g_uac1Driver;
}
