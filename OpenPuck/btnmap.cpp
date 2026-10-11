#include "btnmap.h"
#include "storage.h"
#include <Adafruit_LittleFS.h>
#include <InternalFileSystem.h>
#include <string.h>
using namespace Adafruit_LittleFS_Namespace;

#define BM_FILE "/btnmap.bin"
#define BM_TMP "/btnmap.tmp"
#define BM_MAGIC 0x42
#define BM_VERSION 3
// [magic][version][types][profiles][sources], then per type [active] and its profiles [target x sources][pad x2],
// then (version 2) the gesture [enabled][prev][next], then (version 3) the active Lizard profile. Older versions
// read with the defaults for what they lack.
#define BM_HDR 5
#define BM_PROFILE_BYTES (RS_COUNT + 2)
#define BM_LEN_V1 (BM_HDR + ET_COUNT * (1 + BM_PROFILES * BM_PROFILE_BYTES))
#define BM_LEN_V2 (BM_LEN_V1 + 3)
#define BM_LEN (BM_LEN_V2 + 1)
static_assert(BM_PROFILES == LZ_PROFILES,
	      "Lizard keeps as many profiles as the emulated types");
// how long a profile change made on the controller waits for the next one before it is written
#define BM_GESTURE_SAVE_MS 3000
// a button that is held 40 ms while the modifier is held switches the profile once
#define BM_GESTURE_HOLD_MS 40

MapProfile g_profile[ET_COUNT][BM_PROFILES];
uint8_t g_profileActive[ET_COUNT];
uint8_t g_lizardActive;

ProfileGesture g_gesture = { 1, RS_LB, RS_RB };
uint32_t g_gestureMask;

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

// Not A/B/X/Y, the D-pad or the pad clicks (mode shortcuts), not Steam (shutdown chord, learn mode) and not a
// paddle (the modifier), and an analog trigger's click is too easy to graze.
static bool bmGestureOk(uint8_t enabled, uint8_t prev, uint8_t next)
{
	const uint8_t ok[] = { RS_LB, RS_RB, RS_L3, RS_R3, RS_SELECT, RS_START };
	bool p = false, n = false;
	for (uint8_t i = 0; i < sizeof ok; i++) {
		p |= prev == ok[i];
		n |= next == ok[i];
	}
	return enabled <= 1 && p && n && prev != next;
}

// what the gesture steps: the running emulated type, BM_LIZARD in Lizard mode, else nothing (ET_NONE)
static uint8_t bmGestureKind()
{
	if (g_etype < ET_COUNT)
		return g_etype;
	return g_usbMode == MODE_LIZARD ? BM_LIZARD : ET_NONE;
}

void btnmapUpdateGestureMask()
{
	g_gestureMask = g_gesture.enabled && bmGestureKind() != ET_NONE ?
				remapSourceTb(g_gesture.prev) |
					remapSourceTb(g_gesture.next) :
				0;
}

static void bmFromLegacy()
{
	g_gesture = { 1, RS_LB, RS_RB };
	g_lizardActive = 0;
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
	*d++ = g_gesture.enabled;
	*d++ = g_gesture.prev;
	*d++ = g_gesture.next;
	*d++ = g_lizardActive;
}

// Takes the file only if every value is in range; anything else is rebuilt from the older settings.
static bool bmParse(const uint8_t *d, size_t n)
{
	const bool v1 = n == BM_LEN_V1 && d[1] == 1,
		   v2 = n == BM_LEN_V2 && d[1] == 2;
	if (!(v1 || v2 || (n == BM_LEN && d[1] == BM_VERSION)) ||
	    d[0] != BM_MAGIC || d[2] != ET_COUNT || d[3] != BM_PROFILES ||
	    d[4] != RS_COUNT)
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
	// a gesture setting that is out of range is not worth losing the profiles over
	if (!v1 && bmGestureOk(p[0], p[1], p[2]))
		g_gesture = { p[0], p[1], p[2] };
	else
		g_gesture = { 1, RS_LB, RS_RB };
	g_lizardActive = !v1 && !v2 && p[3] < BM_PROFILES ? p[3] : 0;
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
			const int n = (int)f.size();
			ok = (n == BM_LEN || n == BM_LEN_V2 ||
			      n == BM_LEN_V1) &&
			     f.read(data, (uint16_t)n) == n &&
			     bmParse(data, (size_t)n);
			f.close();
		}
	}
	if (!ok) {
		bmFromLegacy();
		g_bmDirty = true;
	}
	g_bmReady = true;
	bmMirrorLegacy();
	btnmapUpdateGestureMask();
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

bool btnmapToggleNintendo(uint8_t et, uint8_t profile)
{
	if (!bmValid(et, profile))
		return false;
	ButtonMap &m = g_profile[et][profile].map;
	const bool revert = remapFacesSwapped(m);
	for (uint8_t i = 0; i < 4; i++)
		m.target[RS_A + i] = revert ? (uint8_t)(i + 1) :
					      remapSwapCode((uint8_t)(i + 1));
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

bool btnmapSelect(uint8_t et, uint8_t profile, uint32_t holdMs)
{
	if (!bmValid(et, profile))
		return false;
	g_profileActive[et] = profile;
	bmMirrorLegacy();
	btnmapTouch(holdMs);
	return true;
}

bool btnmapSetGesture(uint8_t enabled, uint8_t prev, uint8_t next)
{
	if (!g_bmReady || !bmGestureOk(enabled, prev, next))
		return false;
	g_gesture = { enabled, prev, next };
	btnmapUpdateGestureMask();
	btnmapTouch();
	return true;
}

bool btnmapLizardSelect(uint8_t profile, uint32_t holdMs)
{
	if (!g_bmReady || profile >= BM_PROFILES)
		return false;
	g_lizardActive = profile;
	if (g_usbMode == MODE_LIZARD)
		loadLizardProfile(profile, g_lizardMap);
	btnmapTouch(holdMs);
	return true;
}

static LizardMap &bmLizardMap(uint8_t profile, LizardMap &scratch)
{
	return g_usbMode == MODE_LIZARD && profile == g_lizardActive ?
		       g_lizardMap :
		       scratch;
}

bool btnmapLizardReset(uint8_t profile, LizardMap &scratch)
{
	if (!g_bmReady || profile >= BM_PROFILES)
		return false;
	LizardMap &m = bmLizardMap(profile, scratch);
	defaultLizardMap(m);
	saveLizardProfile(profile, m);
	return true;
}

bool btnmapLizardCopy(uint8_t from, uint8_t to, LizardMap &scratch)
{
	if (!g_bmReady || from >= BM_PROFILES || to >= BM_PROFILES)
		return false;
	LizardMap &m = bmLizardMap(to, scratch);
	loadLizardProfile(from, m);
	saveLizardProfile(to, m);
	return true;
}

static uint8_t bmCycle(int8_t dir)
{
	const uint8_t kind = bmGestureKind();
	if (!g_bmReady || kind == ET_NONE)
		return 0;
	if (kind == BM_LIZARD) {
		const uint8_t next =
			(uint8_t)((g_lizardActive + BM_PROFILES + dir) %
				  BM_PROFILES);
		btnmapLizardSelect(next, BM_GESTURE_SAVE_MS);
		return (uint8_t)(next + 1);
	}
	const uint8_t next =
		(uint8_t)((g_profileActive[g_etype] + BM_PROFILES + dir) %
			  BM_PROFILES);
	// a change made on the controller is written once the next one has had time to follow
	btnmapSelect(g_etype, next, BM_GESTURE_SAVE_MS);
	applyActiveType();
	return (uint8_t)(next + 1);
}

uint8_t btnmapGesture(uint8_t slot, uint32_t buttons, uint32_t now,
		      bool suspended)
{
	static struct {
		int8_t dir;
		bool latched;
		uint32_t since;
	} st[NSLOT];
	if (slot >= NSLOT)
		return 0;
	int8_t dir = 0;
	if (g_bmReady && g_gesture.enabled && bmGestureKind() != ET_NONE &&
	    !suspended && shortcutModifierHeld(buttons)) {
		const bool p = buttons & remapSourceTb(g_gesture.prev),
			   n = buttons & remapSourceTb(g_gesture.next);
		if (p != n)
			dir = p ? -1 : 1;
	}
	// released, or a different button: start over, so one hold is one change
	if (dir == 0) {
		st[slot].dir = 0;
		st[slot].latched = false;
		return 0;
	}
	if (dir != st[slot].dir) {
		st[slot].dir = dir;
		st[slot].latched = false;
		st[slot].since = now;
		return 0;
	}
	if (st[slot].latched ||
	    (uint32_t)(now - st[slot].since) < BM_GESTURE_HOLD_MS)
		return 0;
	st[slot].latched = true;
	return bmCycle(dir);
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
	if (!g_bmReady || et > BM_LIZARD)
		return 0;
	if (et == BM_LIZARD) {
		const uint8_t f[] = {
			1, BM_LIZARD,	      g_lizardActive, BM_PROFILES,
			0, g_gesture.enabled, g_gesture.prev, g_gesture.next
		};
		memcpy(out, f, sizeof f);
		return sizeof f;
	}
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
	*d++ = g_gesture.enabled;
	*d++ = g_gesture.prev;
	*d++ = g_gesture.next;
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
