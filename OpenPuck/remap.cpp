#include "remap.h"
#include "config.h"

// Button code -> TB_* flag. 0 none, 1-4 A/B/X/Y, 5-8 LB/RB/L3/R3, 9-10 Select/Start side, 11 Steam, 12-15 D-pad
// up/down/left/right, 16 PS touchpad click, 17 PS mute, 18 Switch Capture, 19/20 LT/RT.
static uint32_t codeToTb(uint8_t c)
{
	switch (c) {
	case 1:
		return TB_A;
	case 2:
		return TB_B;
	case 3:
		return TB_X;
	case 4:
		return TB_Y;
	case 5:
		return TB_LB;
	case 6:
		return TB_RB;
	case 7:
		return TB_L3;
	case 8:
		return TB_R3;
	// 9 = the Select-side button (Xbox Back, Switch Minus, PlayStation Create/Share) and 10 = the
	// Start-side one (Xbox Start, Switch Plus, PlayStation Options). TB_VIEW / TB_MENU are named
	// BACKWARDS with respect to those positions (see triton.h), so 9 must produce TB_MENU. Mapping 10
	// to TB_QAM was a dead end: no mode turns a TB_QAM bit into a host button, so "Options" did
	// nothing while "Create" came out as Options.
	case 9:
		return TB_MENU;
	case 10:
		return TB_VIEW;
	case 11:
		return TB_STEAM;
	case 12:
		return TB_DUP;
	case 13:
		return TB_DDN;
	case 14:
		return TB_DLF;
	case 15:
		return TB_DRT;
	case 16:
		return TB_TOUCH;
	case 17:
		return TB_MUTE;
	case 19:
		return TB_L2; // left trigger (LT / L2 / ZL)
	case 20:
		return TB_R2; // right trigger (RT / R2 / ZR)
	default:
		return 0;
	}
}

// the Nintendo layout: A and B trade places, as do X and Y
static uint8_t swapCode(uint8_t c)
{
	switch (c) {
	case 1:
		return 2;
	case 2:
		return 1;
	case 3:
		return 4;
	case 4:
		return 3;
	default:
		return c;
	}
}

RemapTarget remapTarget(uint8_t code, bool swap)
{
	if (swap)
		code = swapCode(code);
	return { codeToTb(code), code == REMAP_CODE_CAPTURE };
}

uint32_t remapButtons(uint32_t b, RemapStyle style, bool *capture)
{
	static const uint32_t FACE[4] = { TB_A, TB_B, TB_X, TB_Y };
	static const uint32_t PADDLE[4] = { TB_L4, TB_R4, TB_L5, TB_R5 };
	const uint32_t sources = TB_A | TB_B | TB_X | TB_Y | TB_L4 | TB_R4 |
				 TB_L5 | TB_R5 | TB_QAM;
	// each target is read from the original word, so a swap of two buttons can't cascade
	uint32_t out = b & ~sources;
	bool cap = false;
	auto press = [&](uint8_t code, bool swap) {
		const RemapTarget t = remapTarget(code, swap);
		out |= t.tb;
		cap |= t.capture;
	};
	const bool swap = g_abSwap;
	for (uint8_t i = 0; i < 4; i++)
		if (b & FACE[i])
			press((uint8_t)(i + 1), swap);
	for (uint8_t i = 0; i < 4; i++)
		if (b & PADDLE[i])
			press(g_back[i], swap && style == REMAP_SWAP_TARGETS);
	if (b & TB_QAM)
		press(g_qamMap, swap && style != REMAP_ABSOLUTE);
	if (capture)
		*capture = cap;
	return out;
}
