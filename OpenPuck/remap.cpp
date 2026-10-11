#include "remap.h"
#include <string.h>

// Button code -> TB_* flag (the codes are listed in remap.h). Capture has no flag, and a code that is not a button
// (none, reserved, a macro slot) stands for nothing.
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
	case 21:
		return TB_LPADC;
	case 22:
		return TB_RPADC;
	default:
		return 0;
	}
}

// the Nintendo layout: A and B trade places, as do X and Y
uint8_t remapSwapCode(uint8_t c)
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
		code = remapSwapCode(code);
	return { codeToTb(code), code == REMAP_CODE_CAPTURE };
}

ButtonMap g_btnMap;

static const uint32_t SOURCE_TB[RS_COUNT] = {
	TB_A,	 TB_B,	  TB_X,	    TB_Y,   TB_LB,    TB_RB,	TB_L3,	TB_R3,
	TB_MENU, TB_VIEW, TB_STEAM, TB_DUP, TB_DDN,   TB_DLF,	TB_DRT, TB_L4,
	TB_R4,	 TB_L5,	  TB_R5,    TB_QAM, TB_LPADC, TB_RPADC, TB_L2,	TB_R2
};

uint32_t remapSourceTb(uint8_t source)
{
	return source < RS_COUNT ? SOURCE_TB[source] : 0;
}

void remapDefaultMap(ButtonMap *m)
{
	// a source acts as itself: its code is the one codeToTb() turns back into its own flag
	static const uint8_t SELF[RS_COUNT] = { 1, 2,  3,  4,  5,  6,  7,  8,
						9, 10, 11, 12, 13, 14, 15, 5,
						6, 7,  8,  0,  21, 22, 19, 20 };
	memcpy(m->target, SELF, sizeof m->target);
}

void remapApplyLegacy(ButtonMap *m, const uint8_t back[4], uint8_t qam,
		      bool swap, bool paddlesFollowSwap)
{
	for (uint8_t i = 0; i < 4; i++)
		m->target[RS_A + i] = swap ? remapSwapCode((uint8_t)(i + 1)) :
					     (uint8_t)(i + 1);
	for (uint8_t i = 0; i < 4; i++)
		m->target[RS_L4 + i] = swap && paddlesFollowSwap ?
					       remapSwapCode(back[i]) :
					       back[i];
	m->target[RS_QAM] = swap ? remapSwapCode(qam) : qam;
}

void remapLegacyMap(ButtonMap *m, const uint8_t back[4], uint8_t qam, bool swap,
		    bool paddlesFollowSwap)
{
	remapDefaultMap(m);
	remapApplyLegacy(m, back, qam, swap, paddlesFollowSwap);
}

void remapLegacyView(const ButtonMap &m, bool paddlesFollowSwap,
		     uint8_t back[4], uint8_t *qam)
{
	const bool swap = remapFacesSwapped(m);
	for (uint8_t i = 0; i < 4; i++)
		back[i] = swap && paddlesFollowSwap ?
				  remapSwapCode(m.target[RS_L4 + i]) :
				  m.target[RS_L4 + i];
	*qam = swap ? remapSwapCode(m.target[RS_QAM]) : m.target[RS_QAM];
}

bool remapFacesSwapped(const ButtonMap &m)
{
	return m.target[RS_A] == 2 && m.target[RS_B] == 1 &&
	       m.target[RS_X] == 4 && m.target[RS_Y] == 3;
}

uint32_t remapButtons(uint32_t b, bool *capture)
{
	// every target is read from the original word, so two buttons trading places can't cascade
	uint32_t sources = 0, out = 0;
	bool cap = false;
	for (uint8_t i = 0; i < RS_COUNT; i++) {
		sources |= SOURCE_TB[i];
		if (!(b & SOURCE_TB[i]))
			continue;
		const RemapTarget t = remapTarget(g_btnMap.target[i], false);
		out |= t.tb;
		cap |= t.capture;
	}
	if (capture)
		*capture = cap;
	return (b & ~sources) | out;
}
