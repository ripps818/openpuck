#include "identity.h"
#include <Arduino.h>
#include <stdio.h>
#include <string.h>

char g_unit[16];
char g_board[16];

// 0x83 attributes for the CONTROLLER, as [tag][u32-LE] records, matching controller firmware
// 0x6ABC4999 (IBEX_FW_6ABC4999.fw): tag 01 = product 0x1302; tag 02 = capabilities; tag 0A =
// bootloader build 0x68D2F92E (read from a real unit -- not part of the .fw image); tag 04 = fw build;
// tag 09 = board rev 0x48; tag 0B = connection interval in us (4000 on both the ESB and USB transports;
// firmware >= 0x6A4D85E3 appends it, older builds return only the first 25 bytes). These are
// firmware/model values shared across units, so verbatim is correct; the per-unit serial lives in 0xAE.
// Steam validates these byte-for-byte -- two wrong bytes (the puck's bootloader build + board rev) were
// why it kept re-asking.
// clang-format off
const uint8_t ATTR83[] = {
	0x01, 0x02, 0x13, 0x00, 0x00,
	0x02, 0x00, 0x00, 0x00, 0x00,
	0x0A, 0x2E, 0xF9, 0xD2, 0x68,
	0x04, 0x99, 0x49, 0xBC, 0x6A,
	0x09, 0x48, 0x00, 0x00, 0x00,
	0x0B, 0xA0, 0x0F, 0x00, 0x00,
};
// clang-format on
const uint16_t ATTR83_LEN = sizeof ATTR83;

// Git SHA embedded in the same firmware image; Steam reads it back as 0xAE tag 3.
const char CTRL_GIT_SHA[] = "3a5c18c37841";

uint32_t attr83Value(uint8_t tag)
{
	for (uint16_t i = 0; i + 5 <= ATTR83_LEN; i += 5)
		if (ATTR83[i] == tag)
			return (uint32_t)ATTR83[i + 1] |
			       (uint32_t)ATTR83[i + 2] << 8 |
			       (uint32_t)ATTR83[i + 3] << 16 |
			       (uint32_t)ATTR83[i + 4] << 24;
	return 0;
}

void genSerial()
{
	uint32_t id = NRF_FICR->DEVICEID[0] ^ NRF_FICR->DEVICEID[1];
	snprintf(g_unit, sizeof g_unit, "FXA99602%05lX",
		 (unsigned long)(id & 0xFFFFF));
	snprintf(g_board, sizeof g_board, "MXA99602%05lX",
		 (unsigned long)(id & 0xFFFFF));
}
