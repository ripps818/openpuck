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
#include <stdint.h>
#include "remap.h"
#include "config.h"

#define BM_PROFILES 3

struct MapProfile {
	ButtonMap map;
	uint8_t padStick[2]; // PS_*: left pad, right pad
};
extern MapProfile g_profile[ET_COUNT][BM_PROFILES];
extern uint8_t g_profileActive[ET_COUNT];

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

// Mark the file out of date. It is written holdMs after the last change, so a burst of edits is one write.
void btnmapTouch(uint32_t holdMs = 0);
void btnmapTask(uint32_t now);
void btnmapFlush();
