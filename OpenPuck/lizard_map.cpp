#include "lizard_map.h"
#include "storage.h"
#include <Adafruit_LittleFS.h>
#include <InternalFileSystem.h>
#include <string.h>
#include <class/hid/hid.h>
using namespace Adafruit_LittleFS_Namespace;

LizardMap g_lizardMap;

#define LZ_FILE "/lizard_map.bin"
#define LZ_MAGIC 0xB1u
#define LZ_VERSION 2u

// Version-1 records use 32-bit masks and borrow bits 28..31 for virtual
// left-stick directions. The current format stores those directions above the physical word.
struct LizardBindingV1 {
	uint8_t outType;
	uint8_t outData[7];
	uint32_t trigMask;
	uint32_t holdMask;
};
static_assert(sizeof(LizardBindingV1) == 16,
	      "version-1 lizard binding layout changed");

static uint64_t lizardMaskFromV1(uint32_t m)
{
	uint64_t out = (uint64_t)(m & 0x0FFFFFFFu);
	if (m & 0x10000000u)
		out |= LZ_BTN_LSTICK_RT;
	if (m & 0x20000000u)
		out |= LZ_BTN_LSTICK_LF;
	if (m & 0x40000000u)
		out |= LZ_BTN_LSTICK_DN;
	if (m & 0x80000000u)
		out |= LZ_BTN_LSTICK_UP;
	return out;
}

// KB modifier bits (from TinyUSB hid.h)
#define KM_LCTRL 0x01u
#define KM_LSHIFT 0x02u
#define KM_LALT 0x04u
#define KM_LGUI 0x08u

// Helper: append a binding to the map defaultLizardMap() is filling
static LizardMap *s_fill = &g_lizardMap;
static void addBind(uint8_t type, const uint8_t *od7, uint64_t trig,
		    uint64_t hold)
{
	if (s_fill->count >= LZ_MAX_BINDINGS)
		return;
	LizardBinding &b = s_fill->bindings[s_fill->count++];
	b.outType = type;
	for (int i = 0; i < 7; i++)
		b.outData[i] = od7[i];
	b.trigMask = trig;
	b.holdMask = hold;
}

static inline void addAxis(uint8_t src, uint8_t gyroAct)
{
	uint8_t d[7] = { src, gyroAct, 0, 0, 0, 0, 0 };
	addBind(LZ_OUT_MOUSE_AXIS, d, 0, 0);
}
static inline void addScroll(uint8_t src)
{
	uint8_t d[7] = { src, 0, 0, 0, 0, 0, 0 };
	addBind(LZ_OUT_SCROLL, d, 0, 0);
}
static inline void addMouseBtn(uint8_t btn, uint64_t trig, uint64_t hold)
{
	uint8_t d[7] = { btn, 0, 0, 0, 0, 0, 0 };
	addBind(LZ_OUT_MOUSE_BTN, d, trig, hold);
}
static inline void addKey(uint8_t mod, uint8_t k0, uint64_t trig, uint64_t hold)
{
	uint8_t d[7] = { mod, k0, 0, 0, 0, 0, 0 };
	addBind(LZ_OUT_KBD_CHORD, d, trig, hold);
}
static inline void addKey3(uint8_t mod, uint8_t k0, uint8_t k1, uint8_t k2,
			   uint64_t trig, uint64_t hold)
{
	uint8_t d[7] = { mod, k0, k1, k2, 0, 0, 0 };
	addBind(LZ_OUT_KBD_CHORD, d, trig, hold);
}
static inline void addConsumer(uint8_t bits, uint64_t trig, uint64_t hold)
{
	uint8_t d[7] = { bits, 0, 0, 0, 0, 0, 0 };
	addBind(LZ_OUT_CONSUMER, d, trig, hold);
}

void defaultLizardMap(LizardMap &m)
{
	s_fill = &m;
	m.count = 0;

	// Analog sources (always active; no trigger mask)
	addAxis(LZ_MSRC_RPAD, LZ_GYRO_ALWAYS); // right pad → mouse
	addScroll(LZ_MSRC_LPAD); // left pad → scroll

	// Mouse buttons
	// right pad click → left mouse
	addMouseBtn(1, 0x400000u /*TB_RPADC*/, 0);
	// right trigger (digital click) → left mouse
	addMouseBtn(1, 0x800000u /*TB_R2*/, 0);
	// left trigger → right mouse
	addMouseBtn(2, 0x8000000u /*TB_L2*/, 0);
	// left pad click → middle mouse
	addMouseBtn(4, 0x4000000u /*TB_LPADC*/, 0);

	// Hold-modifier shortcuts (Steam-button combos: place BEFORE generic X/L4 so they consume first)
	// Steam+L4 → Ctrl+Alt+Delete
	addKey3(KM_LCTRL | KM_LALT, HID_KEY_DELETE, 0, 0, 0x20000u /*TB_L4*/,
		0x10000u /*TB_STEAM*/);
	// Steam+X → Win+Ctrl+O (on-screen keyboard)
	addKey3(KM_LGUI | KM_LCTRL, HID_KEY_O, 0, 0, 0x4u /*TB_X*/,
		0x10000u /*TB_STEAM*/);
	// Steam+L5 → volume down (consumer bit1=0x02)
	addConsumer(0x02, 0x40000u /*TB_L5*/, 0x10000u /*TB_STEAM*/);
	// Steam+R5 → volume up (consumer bit0=0x01)
	addConsumer(0x01, 0x100u /*TB_R5*/, 0x10000u /*TB_STEAM*/);

	// Keyboard keys
	addKey(0, HID_KEY_ENTER, 0x1u /*TB_A*/, 0);
	addKey(0, HID_KEY_ESCAPE, 0x2u /*TB_B*/, 0);
	addKey(0, HID_KEY_PAGE_UP, 0x4u /*TB_X*/, 0);
	addKey(0, HID_KEY_PAGE_DOWN, 0x8u /*TB_Y*/, 0);
	addKey(0, HID_KEY_TAB, 0x40u /*TB_VIEW*/, 0);
	addKey(0, HID_KEY_ESCAPE, 0x4000u /*TB_MENU*/, 0);

	// D-pad → arrow keys
	addKey(0, HID_KEY_ARROW_UP, 0x2000u /*TB_DUP*/, 0);
	addKey(0, HID_KEY_ARROW_DOWN, 0x400u /*TB_DDN*/, 0);
	addKey(0, HID_KEY_ARROW_LEFT, 0x1000u /*TB_DLF*/, 0);
	addKey(0, HID_KEY_ARROW_RIGHT, 0x800u /*TB_DRT*/, 0);

	// Left stick → arrow keys (virtual deflection bits)
	addKey(0, HID_KEY_ARROW_UP, LZ_BTN_LSTICK_UP, 0);
	addKey(0, HID_KEY_ARROW_DOWN, LZ_BTN_LSTICK_DN, 0);
	addKey(0, HID_KEY_ARROW_LEFT, LZ_BTN_LSTICK_LF, 0);
	addKey(0, HID_KEY_ARROW_RIGHT, LZ_BTN_LSTICK_RT, 0);

	// Shoulder buttons → modifier keys only (no keycode)
	addKey(KM_LCTRL, 0, 0x80000u /*TB_LB*/, 0);
	addKey(KM_LALT, 0, 0x200u /*TB_RB*/, 0);
}

static const char *const LZ_FILES[LZ_PROFILES] = { LZ_FILE, "/lizard_map2.bin",
						   "/lizard_map3.bin" };

void saveLizardProfile(uint8_t profile, const LizardMap &m)
{
	if (profile >= LZ_PROFILES)
		return;
	uint8_t data[3 + LZ_MAX_BINDINGS * sizeof(LizardBinding)];
	data[0] = LZ_MAGIC;
	data[1] = LZ_VERSION;
	data[2] = m.count;
	size_t length = m.count * sizeof(LizardBinding);
	memcpy(data + 3, m.bindings, length);
	storageWriteFile(LZ_FILES[profile], "/lizard.tmp", data, 3 + length);
}

void saveLizardMap(const LizardMap &m)
{
	saveLizardProfile(0, m);
}

// False when the file is missing, not ours or empty. *migrated is set for a version-1 file.
static bool lzRead(const char *path, LizardMap &m, bool *migrated)
{
	m.count = 0;
	File f(InternalFS);
	if (!f.open(path, FILE_O_READ))
		return false;
	uint8_t hdr[3] = { 0, 0, 0 };
	if (f.read(hdr, 3) == 3 && hdr[0] == LZ_MAGIC &&
	    hdr[2] <= LZ_MAX_BINDINGS) {
		uint8_t cnt = hdr[2];
		if (hdr[1] == LZ_VERSION) {
			int got = f.read((uint8_t *)m.bindings,
					 cnt * sizeof(LizardBinding));
			if (got == (int)(cnt * sizeof(LizardBinding)))
				m.count = cnt;
		} else if (hdr[1] == 1u) {
			static LizardBindingV1 old[LZ_MAX_BINDINGS];
			int got = f.read((uint8_t *)old,
					 cnt * sizeof(LizardBindingV1));
			if (got == (int)(cnt * sizeof(LizardBindingV1))) {
				for (uint8_t i = 0; i < cnt; i++) {
					LizardBinding &b = m.bindings[i];
					b.outType = old[i].outType;
					memcpy(b.outData, old[i].outData,
					       sizeof b.outData);
					b.trigMask = lizardMaskFromV1(
						old[i].trigMask);
					b.holdMask = lizardMaskFromV1(
						old[i].holdMask);
				}
				m.count = cnt;
				*migrated = true;
			}
		}
	}
	f.close();
	return m.count != 0;
}

void loadLizardProfile(uint8_t profile, LizardMap &m)
{
	if (profile >= LZ_PROFILES)
		profile = 0;
	if (g_storageState == 0) {
		defaultLizardMap(m);
		return;
	}
	bool migrated = false;
	if (lzRead(LZ_FILES[profile], m, &migrated)) {
		if (migrated)
			saveLizardProfile(profile, m);
		return;
	}
	// nothing usable: profile 0 gets the defaults, the others a copy of profile 0, and either is persisted
	if (profile)
		loadLizardProfile(0, m);
	else
		defaultLizardMap(m);
	saveLizardProfile(profile, m);
}

void loadLizardMap(LizardMap &m)
{
	loadLizardProfile(0, m);
}

void seedLizardProfiles(LizardMap &m)
{
	if (g_storageState == 0)
		return;
	for (uint8_t p = 1; p < LZ_PROFILES; p++) {
		File f(InternalFS);
		const bool have = f.open(LZ_FILES[p], FILE_O_READ);
		if (have)
			f.close();
		else
			loadLizardProfile(p, m);
	}
}
