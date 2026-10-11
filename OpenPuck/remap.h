// remap.h -- the one place that turns the controller's physical buttons into the buttons a host should see.
//
// Every emulated mode works in Steam-position TB_* bits: remapButtons() takes the shortcut-masked button word and
// returns it with each remappable source replaced by what it is configured to act as, and each mode only has to
// turn TB_* into its own report bits.
//
// Room for macros (not built): a target byte is a button code below 128 and, from 128, a macro slot, so a source
// can later be bound to a macro with no change to ButtonMap or the stored maps. A combination of sources bound to
// a target (or a macro) would be a second table, read before the per-source one, that consumes its member
// sources; it is a new section in the stored profile, not a change to the existing ones.
#pragma once
#include <stdint.h>
#include "triton.h"

// The physical buttons that can be remapped. RS_SELECT / RS_START are the Select-side (Xbox Back, Switch Minus,
// PlayStation Create) and Start-side buttons: TB_MENU and TB_VIEW, which triton.h names backwards.
enum RemapSource : uint8_t {
	RS_A,
	RS_B,
	RS_X,
	RS_Y,
	RS_LB,
	RS_RB,
	RS_L3,
	RS_R3,
	RS_SELECT,
	RS_START,
	RS_STEAM,
	RS_DUP,
	RS_DDN,
	RS_DLF,
	RS_DRT,
	RS_L4,
	RS_R4,
	RS_L5,
	RS_R5,
	RS_QAM,
	RS_LPADC,
	RS_RPADC,
	RS_L2, // the digital full-pull click of the left trigger
	RS_R2,
	RS_COUNT
};

// What a source acts as, as a target code: 0 none, 1-4 A/B/X/Y, 5-8 LB/RB/L3/R3, 9 Select-side, 10 Start-side,
// 11 Steam, 12-15 D-pad up/down/left/right, 16 PS touchpad click, 17 PS mute, 18 Switch Capture, 19/20 LT/RT,
// 21/22 left/right trackpad click. 23-127 are reserved and 128-255 are macro slots; a code a mode does not know
// acts as none, and is kept as it is when a map is stored.
#define REMAP_CODE_CAPTURE 18
#define REMAP_CODE_MAX 22
#define REMAP_CODE_MACRO_BASE 128

struct ButtonMap {
	uint8_t target[RS_COUNT];
};
// The map the emulated modes are using now.
extern ButtonMap g_btnMap;

// Every source acts as itself, except the paddles (LB, RB, L3, R3) and QAM (nothing).
void remapDefaultMap(ButtonMap *m);
// The map the separate paddle / QAM / swap settings describe. The swap exchanges A with B and X with Y, and also
// the paddle / QAM targets that name one of them; the Xbox types keep their paddle targets as absolute buttons
// (paddlesFollowSwap false).
void remapLegacyMap(ButtonMap *m, const uint8_t back[4], uint8_t qam, bool swap,
		    bool paddlesFollowSwap);
// True when the face buttons are exchanged in pairs (the Nintendo layout).
bool remapFacesSwapped(const ButtonMap &m);

// What pressing one target stands for: the Steam-position buttons, plus Capture, which has no TB_* bit (all 32
// are taken). swap exchanges the A/B and X/Y codes first.
struct RemapTarget {
	uint32_t tb;
	bool capture;
};
RemapTarget remapTarget(uint8_t code, bool swap);

// b with every source replaced by its target in g_btnMap. Every other bit passes through. capture (optional) is
// set when a target is Switch Capture.
uint32_t remapButtons(uint32_t b, bool *capture = nullptr);
