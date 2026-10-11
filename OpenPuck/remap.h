// remap.h -- the one place that turns the controller's physical buttons into the buttons a host should see.
//
// Every emulated mode works in Steam-position TB_* bits: remapButtons() takes the shortcut-masked button word and
// returns it with the face buttons, the four paddles and QAM replaced by what they are configured to act as, and
// each mode only has to turn TB_* into its own report bits.
#pragma once
#include <stdint.h>
#include "triton.h"

// Target code of Switch Capture. It has no TB_* bit (all 32 are taken), so it travels beside the word.
#define REMAP_CODE_CAPTURE 18

// Whether the A/B + X/Y swap also applies to the paddle / QAM targets. A target is a Steam-position button, so
// "A" with swap on lands on the host's B. The modes disagree today; this keeps each one's behaviour until the
// stored maps carry the swap themselves.
enum RemapStyle : uint8_t {
	REMAP_SWAP_TARGETS, // paddles and QAM both follow the swap (Switch, PlayStation)
	REMAP_XBOX360, // paddles are absolute host buttons, QAM follows the swap
	REMAP_ABSOLUTE, // neither follows the swap (Original Xbox)
	REMAP_NO_SWAP, // the swap is left to the caller (PS3, whose swap is not a plain A/B + X/Y exchange)
};

// What pressing one target stands for: the Steam-position buttons, plus Capture.
struct RemapTarget {
	uint32_t tb;
	bool capture;
};
RemapTarget remapTarget(uint8_t code, bool swap);

// b with A/B/X/Y, L4/R4/L5/R5 and QAM replaced by their configured targets (g_abSwap, g_back[], g_qamMap).
// Every other bit passes through. capture (optional) is set when a target is Switch Capture.
uint32_t remapButtons(uint32_t b, RemapStyle style, bool *capture = nullptr);
