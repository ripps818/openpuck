// btnmap.h -- the stored button-mapping profiles, one set per emulated type.
//
// A profile is a ButtonMap plus the trackpad -> stick setting. Each type keeps BM_PROFILES of them and one is
// active; the active one is what g_btnMap and g_padStick hold. They live in /btnmap.bin. The older per-type
// settings (paddles, QAM, swap in g_type[], pad -> stick in g_padStickCfg[]) are kept as a view of the active
// profile, so cfg.bin, the status blob and older panels and backups carry on working.
//
// Storage is written from loop context only: the RF path and USB handlers call btnmapTouch(), and the loop
// writes the file (btnmapTask), or saveCfg() does.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "remap.h"
#include "config.h"
#include "lizard_map.h"

#define BM_PROFILES 3

struct MapProfile {
	ButtonMap map;
	uint8_t padStick[2]; // PS_*: left pad, right pad
};
extern MapProfile g_profile[ET_COUNT][BM_PROFILES];
extern uint8_t g_profileActive[ET_COUNT];

// Lizard mode has BM_PROFILES binding maps of its own (lizard_map.h keeps them, one file each); only which one
// is active is stored here. In the WebUSB profile ops and the 0xB0 frame it is type BM_LIZARD.
#define BM_LIZARD ET_COUNT
extern uint8_t g_lizardActive;
// In Lizard mode selecting also loads the profile into the live g_lizardMap. Reset and copy write the profile's
// file, through the live map when the profile is the one Lizard mode is running, else through scratch.
bool btnmapLizardSelect(uint8_t profile, uint32_t holdMs = 0);
bool btnmapLizardReset(uint8_t profile, LizardMap &scratch);
bool btnmapLizardCopy(uint8_t from, uint8_t to, LizardMap &scratch);

// Read /btnmap.bin; when it is missing or not ours, build the profiles from the older settings (every profile
// of a type starts as a copy of them) and write the file. Call after the settings are loaded.
void btnmapLoad();
// The active profile's map for a type; false until btnmapLoad() has run.
bool btnmapActiveMap(uint8_t et, ButtonMap *m);
MapProfile &btnmapActive(uint8_t et);

// Edits through the older per-type settings, applied to the active profile: k 0-3 paddle (L4, R4, L5, R5),
// 4 QAM, 5 swap. Changing the swap also re-reads the paddle / QAM codes through it, as the old setting did.
// The caller refreshes the live map (applyActiveType) when et is the running type.
void btnmapLegacySet(uint8_t et, uint8_t k, uint8_t v);
void btnmapSetPadStick(uint8_t et, uint8_t pad, uint8_t v);

// Editing any profile of a type, for the WebUSB profile ops. Each returns false, changing nothing, for an
// argument out of range. The caller refreshes the live map (applyActiveType) when et is the running type and the
// profile is its active one (or select was called).
bool btnmapSetEntry(uint8_t et, uint8_t profile, uint8_t source,
		    uint8_t target);
// The Nintendo layout: overwrites the four face-button entries only, so a face button set some other way is lost
// but nothing else is touched. When they are already exchanged (remapFacesSwapped) it puts them back as
// themselves, so the same op applies the layout and reverts it.
bool btnmapToggleNintendo(uint8_t et, uint8_t profile);
bool btnmapResetProfile(uint8_t et, uint8_t profile);
bool btnmapCopyProfile(uint8_t et, uint8_t from, uint8_t to);
bool btnmapSelect(uint8_t et, uint8_t profile, uint32_t holdMs = 0);
bool btnmapSetProfilePadStick(uint8_t et, uint8_t profile, uint8_t pad,
			      uint8_t v);

// The profile switch: with the modifier held, the previous / next button steps the running type's active profile
// (in Lizard mode, the Lizard profile) and the gesture answers with the new profile number (1-3) for the caller
// to buzz. Puck-wide, not per profile, and independent of the Mode shortcuts switch. prev / next are RemapSource
// values and must differ.
struct ProfileGesture {
	uint8_t enabled, prev, next;
};
extern ProfileGesture g_gesture;
bool btnmapSetGesture(uint8_t enabled, uint8_t prev, uint8_t next);
// Call with every fresh report of a slot. Returns the profile number when it switched on this call, else 0.
uint8_t btnmapGesture(uint8_t slot, uint32_t buttons, uint32_t now,
		      bool suspended);
// Refresh g_gestureMask (triton.h); applyActiveType() calls it, as the running type decides whether it applies.
void btnmapUpdateGestureMask();

// A type's profiles as the payload of the 0xB0 frame: [1][type][active][profiles][sources], then per profile
// the targets and the two pad settings, then the gesture [enabled][prev][next]. Returns its length
// (BM_DUMP_LEN), 0 for a bad type. BM_LIZARD reports 0 sources, so it is the header and the gesture only.
#define BM_DUMP_LEN (5 + BM_PROFILES * (RS_COUNT + 2) + 3)
size_t btnmapDump(uint8_t et, uint8_t *out);

// Mark the file out of date. It is written holdMs after the last change, so a burst of edits is one write.
void btnmapTouch(uint32_t holdMs = 0);
void btnmapTask(uint32_t now);
void btnmapFlush();
