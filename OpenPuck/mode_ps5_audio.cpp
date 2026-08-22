#include "mode_ps5_audio.h"
#include "haptics.h"
#include "bonds.h"
#include "usb_mount.h"
#include "fault_diag.h"
#include <Arduino.h>
#include <string.h>

// 4-channel layout: IAD(8)+AC_std(9)+CS_hdr(9)+input_term(12)+feat_unit(12)+out_term(9) = 59
#define UAC1_AC_DESC_LEN 59
#define UAC1_AS_DESC_LEN 52
// 4ch * 2 bytes * 48 frames/ms = 384 bytes per 1ms isochronous packet
#define UAC1_ISO_EP_BUFSIZE 384

static uint8_t g_uac1ItfAc = 0xFF;
static uint8_t g_uac1ItfAs = 0xFF;
static uint8_t g_uac1EpOut = 0x08;
static uint8_t g_uac1AltSetting = 0;

CFG_TUD_MEM_SECTION static uint32_t g_isoOutBuf32[UAC1_ISO_EP_BUFSIZE / 4];
static uint8_t *g_isoOutBuf = (uint8_t *)g_isoOutBuf32;

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
		return UAC1_AC_DESC_LEN;
	if (bufsize < UAC1_AC_DESC_LEN)
		return 0;

	uint8_t ac_itf = TinyUSBDevice.allocInterface(1);
	uint8_t as_itf = (uint8_t)(ac_itf + 1);
	g_uac1ItfAc = ac_itf;

	uartPrintf(
		"[UART] UAC1 getInterfaceDescriptor (AC): ac_itf=%u as_itf=%u ep_out=0x08\r\n",
		ac_itf, as_itf);

	const uint8_t desc[UAC1_AC_DESC_LEN] = {
		// Interface Association Descriptor (IAD) - 8 bytes
		8, TUSB_DESC_INTERFACE_ASSOCIATION, ac_itf, 2, TUSB_CLASS_AUDIO,
		0x00, 0x00, 0,

		// Audio Control (AC) Standard Interface Descriptor - 9 bytes
		9, TUSB_DESC_INTERFACE, ac_itf, 0, 0, TUSB_CLASS_AUDIO, 0x01,
		0x00, 0,

		// AC Class-Specific Header Descriptor - 9 bytes
		// wTotalLength = CS_hdr(9)+input_term(12)+feat_unit(12)+out_term(9) = 42
		9, 0x24, 0x01, 0x00, 0x01, 42, 0x00, 1, as_itf,

		// Input Terminal Descriptor (USB Streaming, 4ch) - 12 bytes
		// wChannelConfig 0x0033: FL + FR + BL(haptic-L) + BR(haptic-R)
		12, 0x24, 0x02, 0x01, 0x01, 0x01, 0x00, 4, 0x33, 0x00, 0x00, 0,

		// Feature Unit Descriptor (Mute / Volume, 4ch) - 12 bytes
		// bControlSize=1: master mute(0x01), ch1-4 volume(0x02 each)
		12, 0x24, 0x06, 0x02, 0x01, 0x01, 0x01, 0x02, 0x02, 0x02, 0x02,
		0,

		// Output Terminal Descriptor (Speaker) - 9 bytes
		9, 0x24, 0x03, 0x03, 0x01, 0x03, 0x00, 0x02, 0
	};

	memcpy(buf, desc, UAC1_AC_DESC_LEN);
	return UAC1_AC_DESC_LEN;
}

bool Adafruit_USBD_Audio_UAC1::begin()
{
	return TinyUSBDevice.addInterface(*this);
}

Adafruit_USBD_Audio_UAC1_AS::Adafruit_USBD_Audio_UAC1_AS()
{
}

uint16_t Adafruit_USBD_Audio_UAC1_AS::getInterfaceDescriptor(uint8_t itfnum,
							     uint8_t *buf,
							     uint16_t bufsize)
{
	if (!buf)
		return UAC1_AS_DESC_LEN;
	if (bufsize < UAC1_AS_DESC_LEN)
		return 0;

	uint8_t as_itf = TinyUSBDevice.allocInterface(1);
	g_uac1ItfAs = as_itf;

	uartPrintf(
		"[UART] UAC1 getInterfaceDescriptor (AS): as_itf=%u ep_out=0x08\r\n",
		as_itf);

	const uint8_t desc[UAC1_AS_DESC_LEN] = {
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

		// Standard Isochronous Audio Data Endpoint Descriptor - 9 bytes (EP 0x08)
		// bmAttributes 0x05: isochronous (01b) + asynchronous sync (01b)
		9, TUSB_DESC_ENDPOINT, 0x08, 0x05,
		U16_TO_U8S_LE(UAC1_ISO_EP_BUFSIZE), 1, 0, 0,

		// Class-Specific Audio Data Endpoint Descriptor - 7 bytes
		7, 0x25, 0x01, 0x01, 0, 0, 0
	};

	memcpy(buf, desc, UAC1_AS_DESC_LEN);
	return UAC1_AS_DESC_LEN;
}

bool Adafruit_USBD_Audio_UAC1_AS::begin()
{
	return TinyUSBDevice.addInterface(*this);
}

static const uint8_t s_muLawTable[256] = {
	0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4,
	4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
	5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6,
	6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
	6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
	6, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
	7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
	7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
	7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
	7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
	7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7
};

static inline uint8_t linearToMuLaw(int16_t sample)
{
	const int cBias = 0x84;
	const int cClip = 32635;
	int sign = (sample >> 8) & 0x80;
	if (sign != 0)
		sample = (int16_t)-sample;
	if (sample > cClip)
		sample = cClip;

	sample = (int16_t)(sample + cBias);
	int exponent = (int)s_muLawTable[(sample >> 7) & 0xFF];
	int mantissa = (sample >> (exponent + 3)) & 0x0F;
	return (uint8_t)(~(sign | (exponent << 4) | mantissa));
}

#define AUDIO_FIFO_CAP 64

static volatile uint8_t s_pcmFifoL[AUDIO_FIFO_CAP];
static volatile uint8_t s_pcmFifoR[AUDIO_FIFO_CAP];
static volatile uint8_t s_pcmFifoHead = 0;
static volatile uint8_t s_pcmFifoTail = 0;
static volatile uint32_t s_audioLastPktMs = 0;
static volatile bool s_audioActive = false;

static void processAudioSamples(const uint8_t *data, uint32_t len)
{
	// 4-channel 16-bit PCM: 8 bytes per frame (FL, FR, RL, RR)
	// ch3 (s[2]) = Left LRA, ch4 (s[3]) = Right LRA
	if (len < 8)
		return;

	uint32_t num_frames = len / 8;
	// 24:1 decimation: 48 kHz / 24 = 2 kHz (2 output samples per 1 ms)
	for (uint32_t blk = 0; blk + 24 <= num_frames; blk += 24) {
		int32_t sum_l = 0, sum_r = 0;
		int32_t peak = 0;
		for (uint32_t i = 0; i < 24; i++) {
			const int16_t *s =
				(const int16_t *)(data + (blk + i) * 8);
			int16_t l = s[2];
			int16_t r = s[3];
			sum_l += l;
			sum_r += r;
			int32_t al = l < 0 ? -l : l;
			int32_t ar = r < 0 ? -r : r;
			if (al > peak)
				peak = al;
			if (ar > peak)
				peak = ar;
		}

		uint8_t mu_l = linearToMuLaw((int16_t)(sum_l / 24));
		uint8_t mu_r = linearToMuLaw((int16_t)(sum_r / 24));

		uint8_t next_head = (s_pcmFifoHead + 1) % AUDIO_FIFO_CAP;
		if (next_head != s_pcmFifoTail) {
			s_pcmFifoL[s_pcmFifoHead] = mu_l;
			s_pcmFifoR[s_pcmFifoHead] = mu_r;
			s_pcmFifoHead = next_head;
		}

		if (peak > 200)
			s_audioActive = true;
	}
	s_audioLastPktMs = millis();
}

void ps5AudioTask(void)
{
	uint32_t now = millis();
	bool timedOut = (uint32_t)(now - s_audioLastPktMs) > 50u;
	if (timedOut)
		s_audioActive = false;

	uint8_t count =
		(s_pcmFifoHead >= s_pcmFifoTail) ?
			(s_pcmFifoHead - s_pcmFifoTail) :
			(AUDIO_FIFO_CAP - s_pcmFifoTail + s_pcmFifoHead);

	// 8 samples per channel = 4 ms of 2 kHz stereo audio
	if (count >= 8 && s_audioActive) {
		uint8_t p[17];
		p[0] = 8;
		for (uint8_t i = 0; i < 8; i++) {
			uint8_t idx = (s_pcmFifoTail + i) % AUDIO_FIFO_CAP;
			p[1 + i] = s_pcmFifoL[idx];
			p[9 + i] = s_pcmFifoR[idx];
		}
		s_pcmFifoTail = (s_pcmFifoTail + 8) % AUDIO_FIFO_CAP;

		for (uint8_t u = 0; u < g_usbMountCount; u++) {
			int bond = (u < NSLOT) ? g_usbToBond[u] : -1;
			if (bond < 0 || !g_slot[bond].used) {
				for (int s = 0; s < NSLOT; s++) {
					if (g_slot[s].used) {
						bond = s;
						break;
					}
				}
			}
			if (bond >= 0)
				hapticSendAudioPcm(p, sizeof p, (uint8_t)bond);
		}
	} else if (timedOut) {
		s_pcmFifoTail = s_pcmFifoHead;
	}
}

// TinyUSB class driver implementation for UAC1

// Endpoint descriptor for the ISO OUT endpoint on Alt 1.
// Must match the AS descriptor emitted by getInterfaceDescriptor.
static const tusb_desc_endpoint_t s_iso_ep_out = {
	.bLength = sizeof(tusb_desc_endpoint_t),
	.bDescriptorType = TUSB_DESC_ENDPOINT,
	.bEndpointAddress = 0x08,
	// bmAttributes 0x05: isochronous (01b) + asynchronous sync (01b)
	.bmAttributes = { .xfer = TUSB_XFER_ISOCHRONOUS, .sync = 1, .usage = 0 },
	.wMaxPacketSize = UAC1_ISO_EP_BUFSIZE,
	.bInterval = 1,
};

static void uac1_init(void)
{
	// USBD_ISOSPLIT_SPLIT_OneDir (0x0000) is the hardware reset default;
	// writing it here races with the USBD power-on sequence and causes the
	// host's first GET_DESCRIPTOR to stall (-71 EPROTO). TinyUSB's own
	// dcd_nrf5x.c sets ISOSPLIT when ISO endpoints are opened.
}

static void uac1_reset(uint8_t rhport)
{
	(void)rhport;
	g_uac1AltSetting = 0;
}

static uint16_t uac1_open(uint8_t rhport, tusb_desc_interface_t const *itf_desc,
			  uint16_t max_len)
{
	(void)max_len;
	if (itf_desc->bInterfaceClass != TUSB_CLASS_AUDIO)
		return 0;

	uartPrintf("[UART] UAC1 open: subclass=0x%02X itf=%u alt=%u\r\n",
		   itf_desc->bInterfaceSubClass, itf_desc->bInterfaceNumber,
		   itf_desc->bAlternateSetting);

	if (itf_desc->bInterfaceSubClass == 0x01) {
		usbd_edpt_open(rhport, &s_iso_ep_out);
		/*
		 * IAD has bInterfaceCount=2, so TinyUSB pre-binds both AC
		 * and AS to this driver before calling open(). We must
		 * consume both interfaces' bytes here so the scanner doesn't
		 * hit AS again and fail the already-bound slot assertion.
		 * AC (51) + AS (52) = 103 bytes past the standard-interface ptr.
		 * AC = std(9)+CS_hdr(9)+input_term(12)+feat_unit(12)+out_term(9).
		 */
		return (9 + 9 + 12 + 12 + 9) + UAC1_AS_DESC_LEN;
	}
	return 0;
}

static bool uac1_control_xfer_cb(uint8_t rhport, uint8_t stage,
				 tusb_control_request_t const *request)
{
	if (stage != CONTROL_STAGE_SETUP)
		return true;

	if (request->bmRequestType_bit.type == TUSB_REQ_TYPE_STANDARD) {
		if (request->bRequest != TUSB_REQ_SET_INTERFACE)
			return false;
		uint8_t itf = tu_u16_low(request->wIndex);
		uint8_t alt = tu_u16_low(request->wValue);
		if (itf == g_uac1ItfAs) {
			uint8_t prev_alt = g_uac1AltSetting;
			g_uac1AltSetting = alt;
			if (alt == 1 && prev_alt == 0) {
				usbd_edpt_xfer(rhport, g_uac1EpOut, g_isoOutBuf,
					       UAC1_ISO_EP_BUFSIZE);
			}
		}
		return tud_control_status(rhport, request);
	}

	if (request->bmRequestType_bit.type != TUSB_REQ_TYPE_CLASS)
		return false;

	// Endpoint-directed: sampling frequency
	if (request->bmRequestType_bit.recipient == TUSB_REQ_RCPT_ENDPOINT) {
		if (request->bRequest == 0x01) { // SET_CUR
			return tud_control_xfer(rhport, request, g_isoOutBuf,
						request->wLength);
		}
		// GET_CUR / GET_MIN / GET_MAX / GET_RES: return 48 kHz
		static uint8_t s_freq[3] = { 0x80, 0xBB, 0x00 };
		return tud_control_xfer(rhport, request, s_freq, sizeof s_freq);
	}

	// Interface-directed: mute / volume on the Feature Unit
	static uint8_t s_cur_mute = 0;
	static int16_t s_cur_vol[2] = { 0, 0 }; // 0 dB default
	uint8_t cs = tu_u16_high(request->wValue);

	if (request->bRequest == 0x01) { // SET_CUR
		if (cs == 0x01) { // Mute
			return tud_control_xfer(rhport, request, &s_cur_mute,
						1);
		}
		if (cs == 0x02) { // Volume
			uint8_t cn = tu_u16_low(request->wValue);
			uint8_t ch = (cn > 0 && cn <= 2) ? (cn - 1) : 0;
			return tud_control_xfer(rhport, request, &s_cur_vol[ch],
						sizeof(int16_t));
		}
		return tud_control_xfer(rhport, request, g_isoOutBuf,
					request->wLength);
	}

	if (cs == 0x01) {
		// Mute: 1-byte boolean
		return tud_control_xfer(rhport, request, &s_cur_mute, 1);
	}

	if (cs == 0x02) {
		// Volume: 16-bit signed 1/256-dB, little-endian
		uint8_t cn = tu_u16_low(request->wValue);
		uint8_t ch = (cn > 0 && cn <= 2) ? (cn - 1) : 0;
		switch (request->bRequest) {
		case 0x81: // GET_CUR
			return tud_control_xfer(rhport, request, &s_cur_vol[ch],
						sizeof(int16_t));
		case 0x82: { // GET_MIN: -46 dB (0xD200 LE)
			static const int16_t s_min = (int16_t)0xD200;
			return tud_control_xfer(rhport, request, (void *)&s_min,
						sizeof s_min);
		}
		case 0x83: { // GET_MAX: 0 dB
			static const int16_t s_max = 0;
			return tud_control_xfer(rhport, request, (void *)&s_max,
						sizeof s_max);
		}
		case 0x84: { // GET_RES: 1 dB (0x0100 LE)
			static const int16_t s_res = (int16_t)0x0100;
			return tud_control_xfer(rhport, request, (void *)&s_res,
						sizeof s_res);
		}
		default:
			return false;
		}
	}
	return false;
}

static bool uac1_xfer_cb(uint8_t rhport, uint8_t ep_addr, xfer_result_t result,
			 uint32_t xferred_bytes)
{
	if (ep_addr == g_uac1EpOut && result == XFER_RESULT_SUCCESS) {
		if (xferred_bytes > 0 && g_uac1AltSetting == 1)
			processAudioSamples(g_isoOutBuf, xferred_bytes);
		if (g_uac1AltSetting == 1)
			usbd_edpt_xfer(rhport, g_uac1EpOut, g_isoOutBuf,
				       UAC1_ISO_EP_BUFSIZE);
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
