#include "btnmap.h"
#include "storage.h"
#include <Adafruit_LittleFS.h>
#include <InternalFileSystem.h>
#include <string.h>

#define BM_FILE "/btnmap.bin"
#define BM_TMP "/btnmap.tmp"
#define BM_MAGIC 0x42
#define BM_VERSION 1
// [magic][version][types][profiles][sources], then per type [active] and its profiles [target x sources][pad x2]
#define BM_HDR 5
#define BM_PROFILE_BYTES (RS_COUNT + 2)
#define BM_LEN (BM_HDR + ET_COUNT * (1 + BM_PROFILES * BM_PROFILE_BYTES))

MapProfile g_profile[ET_COUNT][BM_PROFILES];
uint8_t g_profileActive[ET_COUNT];

static bool g_bmReady, g_bmDirty, g_bmArmed;
static uint32_t g_bmHoldMs, g_bmArmedAt;

// The Xbox types take a paddle target as an absolute button; the others apply the swap to it.
static bool bmPaddlesFollowSwap(uint8_t et)
{
	return et != ET_XBOX;
}

MapProfile &btnmapActive(uint8_t et)
{
	return g_profile[et][g_profileActive[et]];
}

// The older settings follow the active profile.
static void bmMirrorLegacy()
{
	for (uint8_t et = 0; et < ET_COUNT; et++) {
		const MapProfile &p = btnmapActive(et);
		remapLegacyView(p.map, bmPaddlesFollowSwap(et), g_type[et].back,
				&g_type[et].qamMap);
		g_type[et].abSwap = remapFacesSwapped(p.map);
		g_padStickCfg[et][0] = p.padStick[0];
		g_padStickCfg[et][1] = p.padStick[1];
	}
}

static void bmFromLegacy()
{
	for (uint8_t et = 0; et < ET_COUNT; et++) {
		MapProfile &p = g_profile[et][0];
		remapLegacyMap(&p.map, g_type[et].back, g_type[et].qamMap,
			       g_type[et].abSwap, bmPaddlesFollowSwap(et));
		p.padStick[0] = g_padStickCfg[et][0];
		p.padStick[1] = g_padStickCfg[et][1];
		for (uint8_t i = 1; i < BM_PROFILES; i++)
			g_profile[et][i] = p;
		g_profileActive[et] = 0;
	}
}

static void bmSerialize(uint8_t *d)
{
	d[0] = BM_MAGIC;
	d[1] = BM_VERSION;
	d[2] = ET_COUNT;
	d[3] = BM_PROFILES;
	d[4] = RS_COUNT;
	d += BM_HDR;
	for (uint8_t et = 0; et < ET_COUNT; et++) {
		*d++ = g_profileActive[et];
		for (uint8_t i = 0; i < BM_PROFILES; i++) {
			memcpy(d, g_profile[et][i].map.target, RS_COUNT);
			d += RS_COUNT;
			*d++ = g_profile[et][i].padStick[0];
			*d++ = g_profile[et][i].padStick[1];
		}
	}
}

// Takes the file only if every value is in range; anything else is rebuilt from the older settings.
static bool bmParse(const uint8_t *d, size_t n)
{
	if (n != BM_LEN || d[0] != BM_MAGIC || d[1] != BM_VERSION ||
	    d[2] != ET_COUNT || d[3] != BM_PROFILES || d[4] != RS_COUNT)
		return false;
	const uint8_t *p = d + BM_HDR;
	for (uint8_t et = 0; et < ET_COUNT; et++) {
		if (*p++ >= BM_PROFILES)
			return false;
		for (uint8_t i = 0; i < BM_PROFILES; i++) {
			p += RS_COUNT;
			if (p[0] > PS_MAX || p[1] > PS_MAX)
				return false;
			p += 2;
		}
	}
	p = d + BM_HDR;
	for (uint8_t et = 0; et < ET_COUNT; et++) {
		g_profileActive[et] = *p++;
		for (uint8_t i = 0; i < BM_PROFILES; i++) {
			memcpy(g_profile[et][i].map.target, p, RS_COUNT);
			p += RS_COUNT;
			g_profile[et][i].padStick[0] = *p++;
			g_profile[et][i].padStick[1] = *p++;
		}
	}
	return true;
}

void btnmapFlush()
{
	if (!g_bmDirty)
		return;
	g_bmDirty = false;
	static uint8_t data[BM_LEN];
	bmSerialize(data);
	storageWriteFile(BM_FILE, BM_TMP, data, sizeof data);
}

void btnmapLoad()
{
	bool ok = false;
	if (g_storageState != 0) {
		static uint8_t data[BM_LEN];
		File f(InternalFS);
		if (f.open(BM_FILE, FILE_O_READ)) {
			ok = f.size() == BM_LEN &&
			     f.read(data, sizeof data) == (int)sizeof data &&
			     bmParse(data, sizeof data);
			f.close();
		}
	}
	if (!ok) {
		bmFromLegacy();
		g_bmDirty = true;
	}
	g_bmReady = true;
	bmMirrorLegacy();
	if (!ok)
		btnmapFlush();
}

bool btnmapActiveMap(uint8_t et, ButtonMap *m)
{
	if (!g_bmReady || et >= ET_COUNT)
		return false;
	*m = btnmapActive(et).map;
	return true;
}

void btnmapLegacySet(uint8_t et, uint8_t k, uint8_t v)
{
	if (!g_bmReady || et >= ET_COUNT || k > 5)
		return;
	ButtonMap &m = btnmapActive(et).map;
	const bool follow = bmPaddlesFollowSwap(et),
		   swap = remapFacesSwapped(m);
	// a paddle or QAM edit touches only that entry, so entries set some other way are kept
	if (k < 4) {
		m.target[RS_L4 + k] = swap && follow ? remapSwapCode(v) : v;
	} else if (k == 4) {
		m.target[RS_QAM] = swap ? remapSwapCode(v) : v;
	} else {
		uint8_t back[4], qam;
		remapLegacyView(m, follow, back, &qam);
		remapApplyLegacy(&m, back, qam, v != 0, follow);
	}
	bmMirrorLegacy();
	btnmapTouch();
}

void btnmapSetPadStick(uint8_t et, uint8_t pad, uint8_t v)
{
	if (!g_bmReady || et >= ET_COUNT || pad > 1 || v > PS_MAX)
		return;
	btnmapActive(et).padStick[pad] = v;
	bmMirrorLegacy();
	btnmapTouch();
}

static bool bmValid(uint8_t et, uint8_t profile)
{
	return g_bmReady && et < ET_COUNT && profile < BM_PROFILES;
}

// an edit to the active profile also moves the older view of it
static void bmChanged(uint8_t et, uint8_t profile)
{
	if (profile == g_profileActive[et])
		bmMirrorLegacy();
	btnmapTouch();
}

bool btnmapSetEntry(uint8_t et, uint8_t profile, uint8_t source, uint8_t target)
{
	if (!bmValid(et, profile) || source >= RS_COUNT)
		return false;
	g_profile[et][profile].map.target[source] = target;
	bmChanged(et, profile);
	return true;
}

bool btnmapApplyNintendo(uint8_t et, uint8_t profile)
{
	if (!bmValid(et, profile))
		return false;
	ButtonMap &m = g_profile[et][profile].map;
	for (uint8_t i = 0; i < 4; i++)
		m.target[RS_A + i] = remapSwapCode((uint8_t)(i + 1));
	bmChanged(et, profile);
	return true;
}

bool btnmapResetProfile(uint8_t et, uint8_t profile)
{
	if (!bmValid(et, profile))
		return false;
	MapProfile &p = g_profile[et][profile];
	const TypeCfg &d = g_typeDefault[et];
	remapLegacyMap(&p.map, d.back, d.qamMap, d.abSwap,
		       bmPaddlesFollowSwap(et));
	p.padStick[0] = p.padStick[1] = PS_OFF;
	bmChanged(et, profile);
	return true;
}

bool btnmapCopyProfile(uint8_t et, uint8_t from, uint8_t to)
{
	if (!bmValid(et, from) || !bmValid(et, to))
		return false;
	g_profile[et][to] = g_profile[et][from];
	bmChanged(et, to);
	return true;
}

bool btnmapSelect(uint8_t et, uint8_t profile)
{
	if (!bmValid(et, profile))
		return false;
	g_profileActive[et] = profile;
	bmMirrorLegacy();
	btnmapTouch();
	return true;
}

bool btnmapSetProfilePadStick(uint8_t et, uint8_t profile, uint8_t pad,
			      uint8_t v)
{
	if (!bmValid(et, profile) || pad > 1 || v > PS_MAX)
		return false;
	g_profile[et][profile].padStick[pad] = v;
	bmChanged(et, profile);
	return true;
}

size_t btnmapDump(uint8_t et, uint8_t *out)
{
	if (!g_bmReady || et >= ET_COUNT)
		return 0;
	out[0] = 1;
	out[1] = et;
	out[2] = g_profileActive[et];
	out[3] = BM_PROFILES;
	out[4] = RS_COUNT;
	uint8_t *d = out + 5;
	for (uint8_t i = 0; i < BM_PROFILES; i++) {
		memcpy(d, g_profile[et][i].map.target, RS_COUNT);
		d += RS_COUNT;
		*d++ = g_profile[et][i].padStick[0];
		*d++ = g_profile[et][i].padStick[1];
	}
	return BM_DUMP_LEN;
}

void btnmapTouch(uint32_t holdMs)
{
	g_bmDirty = true;
	g_bmHoldMs = holdMs;
	g_bmArmed = false;
}

void btnmapTask(uint32_t now)
{
	if (!g_bmDirty)
		return;
	if (!g_bmArmed) {
		g_bmArmed = true;
		g_bmArmedAt = now;
	}
	if ((uint32_t)(now - g_bmArmedAt) >= g_bmHoldMs)
		btnmapFlush();
}
