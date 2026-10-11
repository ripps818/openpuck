"""Button-mapping profiles: the stored profiles, the migration from the older per-type settings, and edits through
those settings. Compiles the real storage.cpp, remap.cpp and btnmap.cpp over a RAM stand-in for the filesystem."""
from pathlib import Path
import subprocess, tempfile

r = Path(__file__).resolve().parents[2]
storage = (r / 'OpenPuck/storage.cpp').read_text().replace('0xED000', '(uintptr_t)testFlash')
remap = (r / 'OpenPuck/remap.cpp').read_text()
btnmap = (r / 'OpenPuck/btnmap.cpp').read_text()
lizard = (r / 'OpenPuck/lizard_map.cpp').read_text()
# the default Lizard map uses a handful of TinyUSB keycodes; the values only need to be distinct here
hid = '#pragma once\n' + ''.join(f'#define HID_KEY_{k} {0x40 + i}\n' for i, k in enumerate(
    'ARROW_DOWN ARROW_LEFT ARROW_RIGHT ARROW_UP DELETE ENTER ESCAPE O PAGE_DOWN PAGE_UP TAB'.split()))
test = r'''
#include <cassert>
#include <algorithm>
#include "config.h"
bool mountOk = false, failWrite = false, failRead = false, failRename = false;
int formats = 0;
std::map<std::string, std::vector<uint8_t> > files;
InternalFileSystem InternalFS;
uint32_t testFlash[7168];
TypeCfg g_type[ET_COUNT];
const TypeCfg g_typeDefault[ET_COUNT] = {
	{ { 5, 6, 7, 8 }, 0, 0, 1, 0, 1 },
	{ { 5, 6, 7, 8 }, 18, 1, 0, 0, 1 },
	{ { 5, 6, 7, 8 }, 0, 0, 1, 0, 1 },
	{ { 5, 6, 7, 8 }, 0, 0, 1, 0, 1 },
};
uint8_t g_padStickCfg[ET_COUNT][2];
uint8_t g_etype = ET_NONE, g_shortcutFlags = SHORTCUT_ENABLED, g_usbMode = MODE_STEAM;
int applied = 0;
void applyActiveType() { ++applied; btnmapUpdateGestureMask(); }

static const std::vector<uint8_t> &file() { return files["/btnmap.bin"]; }
// the older settings as a fresh install has them
static void defaults()
{
	for (int et = 0; et < ET_COUNT; et++) {
		g_type[et] = TypeCfg{ { 5, 6, 7, 8 }, 0, 0, 1, 0, 1 };
		g_padStickCfg[et][0] = g_padStickCfg[et][1] = 0;
	}
	g_type[ET_SWITCH].qamMap = 18;
	g_type[ET_SWITCH].abSwap = 1;
}
static void forget() // a reboot: nothing of the profiles survives but the file
{
	memset(g_profile, 0, sizeof g_profile);
	memset(g_profileActive, 0xAA, sizeof g_profileActive);
}
static bool same(const MapProfile &a, const MapProfile &b)
{
	return !memcmp(&a, &b, sizeof a);
}

int main()
{
	std::fill(testFlash, testFlash + 7168, 0xFFFFFFFF);
	assert(storageBegin());
	ButtonMap m;
	assert(!btnmapActiveMap(ET_XBOX, &m)); // nothing until loaded

	// first boot: no file, so the profiles come from the older settings and are written
	defaults();
	g_type[ET_DS4].abSwap = 1;
	g_type[ET_DS4].back[0] = 1;
	g_type[ET_XBOX].abSwap = 1;
	g_type[ET_XBOX].back[0] = 1;
	g_padStickCfg[ET_DS5][1] = PS_LEFT;
	btnmapLoad();
	assert(file().size() == BM_LEN_FOR_TEST);
	// the swap exchanges the face pair and, except on the Xbox types, the paddle target that names one
	assert(g_profile[ET_DS4][0].map.target[RS_L4] == 2 && g_profile[ET_XBOX][0].map.target[RS_L4] == 1);
	assert(remapFacesSwapped(g_profile[ET_DS4][0].map) && remapFacesSwapped(g_profile[ET_XBOX][0].map));
	assert(!remapFacesSwapped(g_profile[ET_DS5][0].map));
	assert(remapFacesSwapped(g_profile[ET_SWITCH][0].map) && g_profile[ET_SWITCH][0].map.target[RS_QAM] == 18);
	assert(g_profile[ET_DS5][0].padStick[1] == PS_LEFT);
	for (int et = 0; et < ET_COUNT; et++) {
		assert(g_profileActive[et] == 0);
		for (int i = 1; i < BM_PROFILES; i++)
			assert(same(g_profile[et][i], g_profile[et][0]));
	}
	assert(btnmapActiveMap(ET_DS4, &m) && m.target[RS_L4] == 2);
	// the older settings keep showing what the user chose: the paddle as 1 (A), not the swapped 2
	assert(g_type[ET_DS4].back[0] == 1 && g_type[ET_DS4].abSwap == 1 && g_type[ET_XBOX].back[0] == 1);

	// next boot reads the same thing back
	static MapProfile before[ET_COUNT][BM_PROFILES];
	memcpy(before, g_profile, sizeof before);
	forget();
	btnmapLoad();
	assert(!memcmp(before, g_profile, sizeof before));

	// edits through the older settings change the active profile only, and keep what was set another way
	defaults();
	forget();
	files.clear();
	btnmapLoad();
	g_profile[ET_DS5][0].map.target[RS_LB] = 7; // not expressible in the older settings
	btnmapLegacySet(ET_DS5, 0, 1); // L4 -> A
	assert(g_profile[ET_DS5][0].map.target[RS_L4] == 1 && g_profile[ET_DS5][0].map.target[RS_LB] == 7);
	assert(same(g_profile[ET_DS5][1], g_profile[ET_DS5][2]) && !same(g_profile[ET_DS5][0], g_profile[ET_DS5][1]));
	btnmapLegacySet(ET_DS5, 5, 1); // swap on: the faces trade places and L4 is re-read through it
	assert(remapFacesSwapped(g_profile[ET_DS5][0].map) && g_profile[ET_DS5][0].map.target[RS_L4] == 2);
	assert(g_type[ET_DS5].back[0] == 1 && g_type[ET_DS5].abSwap == 1 && g_profile[ET_DS5][0].map.target[RS_LB] == 7);
	btnmapLegacySet(ET_DS5, 0, 3); // another paddle edit while swapped
	assert(g_profile[ET_DS5][0].map.target[RS_L4] == 4 && g_type[ET_DS5].back[0] == 3);
	btnmapLegacySet(ET_DS5, 4, 2); // QAM -> B, stored as A
	assert(g_profile[ET_DS5][0].map.target[RS_QAM] == 1 && g_type[ET_DS5].qamMap == 2);
	btnmapLegacySet(ET_DS5, 5, 0); // swap off again
	assert(!remapFacesSwapped(g_profile[ET_DS5][0].map) && g_profile[ET_DS5][0].map.target[RS_L4] == 3);
	assert(g_profile[ET_DS5][0].map.target[RS_QAM] == 2 && g_type[ET_DS5].abSwap == 0);
	// out of range edits do nothing
	const MapProfile keep = g_profile[ET_DS5][0];
	btnmapLegacySet(ET_COUNT, 0, 1);
	btnmapLegacySet(ET_DS5, 6, 1);
	assert(same(keep, g_profile[ET_DS5][0]));
	btnmapSetPadStick(ET_DS5, 0, PS_MAX + 1);
	btnmapSetPadStick(ET_DS5, 2, PS_LEFT);
	assert(same(keep, g_profile[ET_DS5][0]));
	btnmapSetPadStick(ET_DS5, 1, PS_RIGHT);
	assert(g_profile[ET_DS5][0].padStick[1] == PS_RIGHT && g_padStickCfg[ET_DS5][1] == PS_RIGHT);

	// a burst of edits is one write, made once the hold has passed since the last of them
	btnmapFlush();
	const std::vector<uint8_t> saved = file();
	btnmapLegacySet(ET_XBOX, 1, 4);
	btnmapTouch(3000);
	btnmapTask(1000);
	btnmapTask(3999);
	assert(file() == saved);
	btnmapLegacySet(ET_XBOX, 2, 4); // another edit restarts the hold
	btnmapTouch(3000);
	btnmapTask(4000);
	btnmapTask(6999);
	assert(file() == saved);
	btnmapTask(7000);
	assert(file() != saved);
	const std::vector<uint8_t> second = file();
	btnmapTask(20000); // nothing left to write
	assert(file() == second);
	btnmapLegacySet(ET_XBOX, 3, 4);
	btnmapFlush(); // saveCfg() flushes without waiting
	assert(file() != second);

	// a file that is not ours, or is out of range, is rebuilt from the older settings
	const std::vector<uint8_t> good = file();
	for (int bad = 0; bad < 6; bad++) {
		std::vector<uint8_t> d = good;
		if (bad == 0) d[0] ^= 1; // magic
		if (bad == 1) d[1] = 4; // version
		if (bad == 2) d[4] = RS_COUNT + 1; // source count
		if (bad == 3) d.pop_back();
		if (bad == 4) d[BM_HDR_FOR_TEST] = BM_PROFILES; // active profile out of range
		if (bad == 5) d[BM_HDR_FOR_TEST + 1 + RS_COUNT] = PS_MAX + 1; // pad setting out of range
		files["/btnmap.bin"] = d;
		defaults();
		forget();
		btnmapLoad();
		assert(g_profile[ET_XBOX][0].map.target[RS_L4] == 5 && g_profileActive[ET_XBOX] == 0);
		assert(file().size() == BM_LEN_FOR_TEST && file()[0] == 0x42);
	}

	// the profile ops reach any profile of a type; out-of-range arguments change nothing
	defaults();
	forget();
	files.clear();
	btnmapLoad();
	btnmapFlush();
	const MapProfile p0 = g_profile[ET_DS4][0];
	assert(btnmapSetEntry(ET_DS4, 1, RS_LB, 20) && g_profile[ET_DS4][1].map.target[RS_LB] == 20);
	assert(btnmapSetEntry(ET_DS4, 1, RS_LPADC, REMAP_CODE_MACRO_BASE + 3) && g_profile[ET_DS4][1].map.target[RS_LPADC] == 131);
	assert(same(p0, g_profile[ET_DS4][0]) && g_type[ET_DS4].back[0] == 5); // not the active profile: nothing moves
	assert(!btnmapSetEntry(ET_COUNT, 0, RS_A, 1) && !btnmapSetEntry(ET_DS4, BM_PROFILES, RS_A, 1) &&
	       !btnmapSetEntry(ET_DS4, 0, RS_COUNT, 1));
	assert(same(p0, g_profile[ET_DS4][0]));
	assert(btnmapSetEntry(ET_DS4, 0, RS_R4, 15) && g_type[ET_DS4].back[1] == 15); // the active one moves the view
	// the Nintendo layout touches the four face entries and nothing else
	assert(btnmapToggleNintendo(ET_DS4, 1) && remapFacesSwapped(g_profile[ET_DS4][1].map));
	assert(g_profile[ET_DS4][1].map.target[RS_LB] == 20 && g_profile[ET_DS4][1].map.target[RS_L4] == 5);
	assert(!btnmapToggleNintendo(ET_DS4, 3));
	// the same op reverts it, and only when all four are exchanged: a half-swapped set is completed, not undone
	assert(btnmapToggleNintendo(ET_DS4, 1) && !remapFacesSwapped(g_profile[ET_DS4][1].map));
	for (int i = 0; i < 4; i++)
		assert(g_profile[ET_DS4][1].map.target[RS_A + i] == i + 1);
	assert(g_profile[ET_DS4][1].map.target[RS_LB] == 20);
	g_profile[ET_DS4][1].map.target[RS_A] = 2;
	g_profile[ET_DS4][1].map.target[RS_B] = 2;
	assert(btnmapToggleNintendo(ET_DS4, 1) && remapFacesSwapped(g_profile[ET_DS4][1].map));
	assert(btnmapToggleNintendo(ET_DS4, 1) && !remapFacesSwapped(g_profile[ET_DS4][1].map));
	assert(btnmapToggleNintendo(ET_DS4, 1)); // swapped again, as the lines after expect
	// the Switch type starts exchanged (its default has the swap on): the same op reverts it, QAM stays on Capture
	assert(btnmapResetProfile(ET_SWITCH, 0) && remapFacesSwapped(g_profile[ET_SWITCH][0].map));
	assert(g_type[ET_SWITCH].abSwap == 1);
	assert(btnmapToggleNintendo(ET_SWITCH, 0) && !remapFacesSwapped(g_profile[ET_SWITCH][0].map));
	assert(g_type[ET_SWITCH].abSwap == 0 && g_profile[ET_SWITCH][0].map.target[RS_QAM] == 18);
	for (int i = 0; i < 4; i++)
		assert(g_profile[ET_SWITCH][0].map.target[RS_A + i] == i + 1);
	assert(btnmapToggleNintendo(ET_SWITCH, 0) && g_type[ET_SWITCH].abSwap == 1);
	// copy, reset (to the type's defaults, not to identity: the Switch type starts swapped with QAM on Capture)
	assert(btnmapCopyProfile(ET_DS4, 1, 2) && same(g_profile[ET_DS4][2], g_profile[ET_DS4][1]));
	assert(!btnmapCopyProfile(ET_DS4, 1, 3) && !btnmapCopyProfile(ET_DS4, 3, 1));
	assert(btnmapSetProfilePadStick(ET_DS4, 2, 0, PS_RIGHT) && g_profile[ET_DS4][2].padStick[0] == PS_RIGHT);
	assert(g_padStickCfg[ET_DS4][0] == 0); // the view follows the active profile
	assert(!btnmapSetProfilePadStick(ET_DS4, 2, 2, PS_LEFT) && !btnmapSetProfilePadStick(ET_DS4, 2, 0, PS_MAX + 1));
	assert(btnmapResetProfile(ET_SWITCH, 2) && remapFacesSwapped(g_profile[ET_SWITCH][2].map));
	assert(g_profile[ET_SWITCH][2].map.target[RS_QAM] == 18 && g_profile[ET_SWITCH][2].map.target[RS_L4] == 5);
	assert(btnmapResetProfile(ET_DS4, 2) && !remapFacesSwapped(g_profile[ET_DS4][2].map) &&
	       g_profile[ET_DS4][2].padStick[0] == PS_OFF && g_profile[ET_DS4][2].map.target[RS_LB] == 5);
	// selecting changes the active profile, and the view with it
	assert(btnmapSelect(ET_DS4, 1) && g_profileActive[ET_DS4] == 1 && g_type[ET_DS4].abSwap == 1);
	assert(btnmapActiveMap(ET_DS4, &m) && m.target[RS_LB] == 20);
	assert(!btnmapSelect(ET_DS4, 3) && g_profileActive[ET_DS4] == 1 && g_profileActive[ET_XBOX] == 0);
	// the legacy settings now edit profile 1
	btnmapLegacySet(ET_DS4, 4, 3);
	assert(g_profile[ET_DS4][1].map.target[RS_QAM] == 4 && g_profile[ET_DS4][0].map.target[RS_QAM] == 0);
	// the dump a panel reads
	uint8_t frame[BM_DUMP_LEN + 1];
	assert(btnmapDump(ET_DS4, frame) == BM_DUMP_LEN && frame[0] == 1 && frame[1] == ET_DS4 && frame[2] == 1);
	assert(frame[3] == BM_PROFILES && frame[4] == RS_COUNT);
	assert(!memcmp(frame + 5 + (RS_COUNT + 2), g_profile[ET_DS4][1].map.target, RS_COUNT) && frame[5 + 2 * (RS_COUNT + 2) - 2 + 0] == 0);
	assert(btnmapDump(BM_LIZARD + 1, frame) == 0); // ET_COUNT is the Lizard profiles
	// all of it survives a reboot
	btnmapFlush();
	static MapProfile snapshot[ET_COUNT][BM_PROFILES];
	memcpy(snapshot, g_profile, sizeof snapshot);
	const uint8_t activeDs4 = g_profileActive[ET_DS4];
	forget();
	btnmapLoad();
	assert(!memcmp(snapshot, g_profile, sizeof snapshot) && g_profileActive[ET_DS4] == activeDs4);

	// the profile switch: the modifier plus the previous / next button, 40 ms, once per hold
	defaults();
	forget();
	files.clear();
	btnmapLoad();
	assert(g_gesture.enabled == 1 && g_gesture.prev == RS_LB && g_gesture.next == RS_RB);
	assert(g_gestureMask == 0); // no emulated type running: the buttons stay the game's
	g_etype = ET_DS5;
	btnmapUpdateGestureMask();
	assert(g_gestureMask == (TB_LB | TB_RB));
	g_shortcutFlags = 0; // the mode shortcuts are off; the gesture does not depend on them
	const uint32_t MOD = CHORD_BACK4;
	int before_applied = applied;
	assert(btnmapGesture(0, MOD | TB_RB, 1000, false) == 0); // timing starts
	assert(btnmapGesture(0, MOD | TB_RB, 1039, false) == 0);
	assert(btnmapGesture(0, MOD | TB_RB, 1040, false) == 2 && g_profileActive[ET_DS5] == 1);
	assert(applied == before_applied + 1 && g_type[ET_DS5].abSwap == 0);
	assert(btnmapGesture(0, MOD | TB_RB, 1100, false) == 0 && btnmapGesture(0, MOD | TB_RB, 5000, false) == 0);
	assert(btnmapGesture(0, MOD, 5010, false) == 0); // released: re-arms
	assert(btnmapGesture(0, MOD | TB_RB, 5020, false) == 0 && btnmapGesture(0, MOD | TB_RB, 5060, false) == 3);
	assert(btnmapGesture(0, MOD, 5070, false) == 0);
	assert(btnmapGesture(0, MOD | TB_RB, 5080, false) == 0 && btnmapGesture(0, MOD | TB_RB, 5120, false) == 1); // wraps
	assert(g_profileActive[ET_DS5] == 0);
	assert(btnmapGesture(0, MOD, 5130, false) == 0);
	assert(btnmapGesture(0, MOD | TB_LB, 5140, false) == 0 && btnmapGesture(0, MOD | TB_LB, 5180, false) == 3); // previous wraps
	assert(g_profileActive[ET_DS5] == 2 && g_profileActive[ET_XBOX] == 0);
	assert(btnmapGesture(0, MOD, 5190, false) == 0);
	// it does nothing without the modifier, with both buttons, while suspended, switched off, or off a profile type
	assert(btnmapGesture(0, TB_RB, 6000, false) == 0 && btnmapGesture(0, TB_RB, 6100, false) == 0);
	assert(btnmapGesture(0, MOD | TB_LB | TB_RB, 6200, false) == 0 && btnmapGesture(0, MOD | TB_LB | TB_RB, 6300, false) == 0);
	assert(btnmapGesture(0, MOD, 6310, false) == 0);
	assert(btnmapGesture(0, MOD | TB_RB, 6320, true) == 0 && btnmapGesture(0, MOD | TB_RB, 6400, true) == 0);
	assert(btnmapGesture(0, MOD, 6410, false) == 0);
	assert(btnmapGesture(NSLOT, MOD | TB_RB, 6500, false) == 0 && btnmapGesture(NSLOT, MOD | TB_RB, 6600, false) == 0);
	g_etype = ET_NONE;
	assert(btnmapGesture(0, MOD | TB_RB, 7000, false) == 0 && btnmapGesture(0, MOD | TB_RB, 7100, false) == 0);
	g_etype = ET_DS5;
	assert(btnmapGesture(0, MOD, 7110, false) == 0);
	// each slot times itself
	assert(btnmapGesture(1, MOD | TB_RB, 8000, false) == 0 && btnmapGesture(2, MOD | TB_LB, 8010, false) == 0);
	assert(btnmapGesture(1, MOD | TB_RB, 8040, false) == 1); // profile 3 -> 1
	assert(btnmapGesture(2, MOD | TB_LB, 8050, false) == 3); // and back to 3 from slot 2
	assert(btnmapGesture(1, MOD, 8060, false) == 0 && btnmapGesture(2, MOD, 8060, false) == 0);
	// the Quick Access modifier works the same way
	g_shortcutFlags = SHORTCUT_QAM;
	assert(btnmapGesture(0, TB_QAM | TB_RB, 9000, false) == 0 && btnmapGesture(0, TB_QAM | TB_RB, 9040, false) == 1);
	assert(btnmapGesture(0, MOD | TB_RB, 9050, false) == 0 && btnmapGesture(0, MOD | TB_RB, 9100, false) == 0); // back four is not it
	assert(btnmapGesture(0, 0, 9110, false) == 0);
	// the choice of buttons: only ones no shortcut uses, and two different ones
	assert(btnmapSetGesture(1, RS_L3, RS_R3) && g_gestureMask == (TB_L3 | TB_R3));
	assert(btnmapSetGesture(1, RS_START, RS_SELECT) && btnmapSetGesture(0, RS_LB, RS_RB) && g_gestureMask == 0);
	assert(!btnmapSetGesture(1, RS_A, RS_RB) && !btnmapSetGesture(1, RS_LB, RS_DUP) && !btnmapSetGesture(1, RS_LB, RS_STEAM));
	assert(!btnmapSetGesture(1, RS_LB, RS_LB) && !btnmapSetGesture(2, RS_LB, RS_RB) && !btnmapSetGesture(1, RS_L2, RS_R2));
	assert(!btnmapSetGesture(1, RS_L4, RS_RB) && !btnmapSetGesture(1, RS_LB, RS_QAM));
	assert(g_gesture.enabled == 0 && g_gesture.prev == RS_LB && g_gesture.next == RS_RB); // refused: unchanged
	assert(btnmapGesture(0, TB_QAM | TB_RB, 9200, false) == 0 && btnmapGesture(0, TB_QAM | TB_RB, 9300, false) == 0); // off
	assert(btnmapSetGesture(1, RS_L3, RS_R3));
	g_shortcutFlags = SHORTCUT_ENABLED;
	assert(btnmapGesture(0, MOD | TB_R3, 9400, false) == 0 && btnmapGesture(0, MOD | TB_R3, 9440, false) == 2);
	assert(btnmapGesture(0, MOD, 9450, false) == 0);
	// a change made on the controller waits for the next one before it is written
	btnmapFlush();
	const std::vector<uint8_t> atRest = file();
	assert(btnmapGesture(0, MOD | TB_L3, 10000, false) == 0 && btnmapGesture(0, MOD | TB_L3, 10040, false) == 1);
	btnmapTask(10040);
	btnmapTask(13039);
	assert(file() == atRest);
	assert(btnmapGesture(0, MOD, 13040, false) == 0);
	assert(btnmapGesture(0, MOD | TB_L3, 13100, false) == 0 && btnmapGesture(0, MOD | TB_L3, 13140, false) == 3);
	btnmapTask(13140); // another change restarts the wait
	btnmapTask(16139);
	assert(file() == atRest);
	btnmapTask(16140);
	assert(file() != atRest);
	// the choice and the active profile survive a reboot; a version 1 file has no gesture; a bad gesture keeps the profiles
	const uint8_t activeNow = g_profileActive[ET_DS5];
	forget();
	g_gesture = { 0, RS_START, RS_SELECT };
	btnmapLoad();
	assert(g_gesture.enabled == 1 && g_gesture.prev == RS_L3 && g_gesture.next == RS_R3 && g_profileActive[ET_DS5] == activeNow);
	{
		std::vector<uint8_t> v1 = file();
		v1.resize(v1.size() - 4);
		v1[1] = 1;
		files["/btnmap.bin"] = v1;
		forget();
		g_gesture = { 0, RS_START, RS_SELECT };
		btnmapLoad();
		assert(g_gesture.enabled == 1 && g_gesture.prev == RS_LB && g_gesture.next == RS_RB && g_profileActive[ET_DS5] == activeNow);
		assert(file() == v1); // read as it is; the next change writes version 3
		assert(btnmapSetGesture(1, RS_LB, RS_RB));
		btnmapFlush();
		std::vector<uint8_t> v3 = file();
		assert(v3.size() == v1.size() + 4 && v3[1] == 3);
		v3[v3.size() - 3] = RS_A; // a gesture button no shortcut may lose
		files["/btnmap.bin"] = v3;
		forget();
		btnmapLoad();
		assert(g_gesture.prev == RS_LB && g_gesture.next == RS_RB && g_profileActive[ET_DS5] == activeNow);
	}
	// the dump carries the gesture after the profiles
	{
		uint8_t frame[BM_DUMP_LEN];
		assert(btnmapDump(ET_DS5, frame) == BM_DUMP_LEN);
		assert(frame[BM_DUMP_LEN - 3] == 1 && frame[BM_DUMP_LEN - 2] == RS_LB && frame[BM_DUMP_LEN - 1] == RS_RB);
	}
	g_etype = ET_NONE;
	g_shortcutFlags = SHORTCUT_ENABLED;

	// Lizard profiles: one binding file each, the active one in btnmap.bin
	{
		defaults();
		forget();
		files.clear();
		btnmapLoad();
		assert(g_lizardActive == 0);
		// first boot: profiles 2 and 3 are written as copies of profile 1, and are never overwritten after
		LizardMap scratch, a, b;
		LizardBinding one = { LZ_OUT_KBD_CHORD, { 0, 0x28, 0, 0, 0, 0, 0 }, TB_A, 0 };
		loadLizardMap(a);
		a.count = 1;
		a.bindings[0] = one;
		saveLizardMap(a);
		seedLizardProfiles(scratch);
		assert(files.count("/lizard_map2.bin") && files["/lizard_map2.bin"] == files["/lizard_map.bin"]);
		assert(files["/lizard_map3.bin"] == files["/lizard_map.bin"]);
		a.bindings[0].outData[1] = 0x29;
		saveLizardProfile(1, a);
		seedLizardProfiles(scratch);
		assert(files["/lizard_map2.bin"] != files["/lizard_map.bin"]);
		loadLizardProfile(1, b);
		assert(b.count == 1 && b.bindings[0].outData[1] == 0x29);
		loadLizardProfile(0, b);
		assert(b.count == 1 && b.bindings[0].outData[1] == 0x28);
		// a profile file that went missing comes back as a copy of profile 1
		files.erase("/lizard_map3.bin");
		loadLizardProfile(2, b);
		assert(b.bindings[0].outData[1] == 0x28 && files.count("/lizard_map3.bin"));

		// outside Lizard mode, selecting stores the choice and leaves the live (default) map alone
		defaultLizardMap();
		const LizardMap live = g_lizardMap;
		assert(btnmapLizardSelect(1) && g_lizardActive == 1 && !btnmapLizardSelect(BM_PROFILES));
		assert(!memcmp(&live, &g_lizardMap, sizeof live));
		btnmapFlush();
		assert(file().size() == BM_LEN_FOR_TEST && file().back() == 1);
		forget();
		g_lizardActive = 0;
		btnmapLoad();
		assert(g_lizardActive == 1);
		// the 0xB0 frame for Lizard is the header and the gesture
		uint8_t lf[BM_DUMP_LEN];
		assert(btnmapDump(BM_LIZARD, lf) == 8 && lf[1] == BM_LIZARD && lf[2] == 1 && lf[3] == BM_PROFILES && lf[4] == 0);
		assert(lf[5] == g_gesture.enabled && lf[6] == g_gesture.prev && lf[7] == g_gesture.next);
		assert(btnmapDump(BM_LIZARD + 1, lf) == 0);
		// in Lizard mode the live map is the active profile, and selecting loads the new one
		g_usbMode = MODE_LIZARD;
		assert(btnmapLizardSelect(0) && g_lizardMap.count == 1 && g_lizardMap.bindings[0].outData[1] == 0x28);
		// copy and reset write the profile's file, through the live map only when it is the running profile
		assert(btnmapLizardCopy(1, 2, scratch) && files["/lizard_map3.bin"] == files["/lizard_map2.bin"]);
		assert(g_lizardMap.bindings[0].outData[1] == 0x28);
		assert(btnmapLizardCopy(2, 0, scratch) && g_lizardMap.bindings[0].outData[1] == 0x29);
		assert(btnmapLizardReset(0, scratch) && g_lizardMap.count == live.count);
		loadLizardProfile(0, b);
		assert(b.count == live.count && !memcmp(b.bindings, live.bindings, b.count * sizeof(LizardBinding)));
		assert(btnmapLizardReset(2, scratch) && g_lizardMap.count == live.count);
		loadLizardProfile(1, b);
		assert(b.count == 1); // untouched
		assert(!btnmapLizardCopy(0, BM_PROFILES, scratch) && !btnmapLizardReset(BM_PROFILES, scratch));

		// the gesture steps the Lizard profile in Lizard mode, and only there
		g_etype = ET_NONE;
		g_shortcutFlags = 0;
		assert(btnmapSetGesture(1, RS_LB, RS_RB) && g_gestureMask == (TB_LB | TB_RB));
		const uint32_t MOD4 = CHORD_BACK4;
		assert(btnmapGesture(0, MOD4 | TB_RB, 20000, false) == 0 && btnmapGesture(0, MOD4 | TB_RB, 20040, false) == 2);
		assert(g_lizardActive == 1 && g_lizardMap.count == 1 && g_lizardMap.bindings[0].outData[1] == 0x29);
		btnmapFlush();
		assert(file().back() == 1);
		assert(btnmapGesture(0, MOD4, 20050, false) == 0);
		assert(btnmapGesture(0, MOD4 | TB_LB, 20060, false) == 0 && btnmapGesture(0, MOD4 | TB_LB, 20100, false) == 1);
		assert(g_lizardActive == 0 && g_lizardMap.count == live.count);
		assert(btnmapGesture(0, MOD4, 20110, false) == 0);
		// Steam mode (seamless lizard) has no profiles: no gesture, and the buttons stay the game's
		g_usbMode = MODE_STEAM;
		btnmapUpdateGestureMask();
		assert(g_gestureMask == 0);
		assert(btnmapGesture(0, MOD4 | TB_RB, 21000, false) == 0 && btnmapGesture(0, MOD4 | TB_RB, 21100, false) == 0);
		assert(g_lizardActive == 0);
		g_shortcutFlags = SHORTCUT_ENABLED;
		// a version 2 file reads with Lizard profile 1
		std::vector<uint8_t> v2 = file();
		g_lizardActive = 2;
		btnmapFlush();
		v2.pop_back();
		v2[1] = 2;
		files["/btnmap.bin"] = v2;
		forget();
		btnmapLoad();
		assert(g_lizardActive == 0 && file() == v2);
		// an out-of-range Lizard profile is not worth the rest
		std::vector<uint8_t> v3 = v2;
		v3[1] = 3;
		v3.push_back(BM_PROFILES);
		files["/btnmap.bin"] = v3;
		g_lizardActive = 2;
		forget();
		btnmapLoad();
		assert(g_lizardActive == 0 && file() == v3);
	}

	// without a mounted filesystem the profiles still come up, and nothing is written
	g_storageState = 0;
	files.clear();
	defaults();
	forget();
	btnmapLoad();
	assert(g_profile[ET_SWITCH][0].map.target[RS_QAM] == 18 && !files.count("/btnmap.bin"));
	btnmapLegacySet(ET_DS4, 0, 1);
	assert(g_profile[ET_DS4][0].map.target[RS_L4] == 1);
}
'''.replace('BM_LEN_FOR_TEST', '(5 + ET_COUNT * (1 + BM_PROFILES * (RS_COUNT + 2)) + 4)').replace('BM_HDR_FOR_TEST', '5')
head = '''#include <stdint.h>
#include <stddef.h>
#include <string.h>
'''
with tempfile.TemporaryDirectory() as td:
    p = Path(td) / 'test.cpp'
    (Path(td) / 'class/hid').mkdir(parents=True)
    (Path(td) / 'class/hid/hid.h').write_text(hid)
    p.write_text(head + storage + remap + lizard + btnmap + test)
    subprocess.run(['g++', '-std=c++11', '-Wall', '-Wextra', '-Werror', '-Wno-unused', '-fsanitize=address,undefined',
                    '-I' + td, '-I' + str(r / 'tests/storage/stubs'), '-I' + str(r / 'OpenPuck'), str(p), '-o', td + '/test'],
                   check=True)
    subprocess.run([td + '/test'], check=True, env={'ASAN_OPTIONS': 'detect_leaks=0'})
print('Button profiles: migration, storage, validation and edits through the older settings')
