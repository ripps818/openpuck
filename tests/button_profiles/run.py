"""Button-mapping profiles: the stored profiles, the migration from the older per-type settings, and edits through
those settings. Compiles the real storage.cpp, remap.cpp and btnmap.cpp over a RAM stand-in for the filesystem."""
from pathlib import Path
import subprocess, tempfile

r = Path(__file__).resolve().parents[2]
storage = (r / 'OpenPuck/storage.cpp').read_text().replace('0xED000', '(uintptr_t)testFlash')
remap = (r / 'OpenPuck/remap.cpp').read_text()
btnmap = (r / 'OpenPuck/btnmap.cpp').read_text()
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
uint8_t g_padStickCfg[ET_COUNT][2];

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
		if (bad == 1) d[1] = 2; // version
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
'''.replace('BM_LEN_FOR_TEST', '(5 + ET_COUNT * (1 + BM_PROFILES * (RS_COUNT + 2)))').replace('BM_HDR_FOR_TEST', '5')
head = '''#include <stdint.h>
#include <stddef.h>
#include <string.h>
'''
with tempfile.TemporaryDirectory() as td:
    p = Path(td) / 'test.cpp'
    p.write_text(head + storage + remap + btnmap + test)
    subprocess.run(['g++', '-std=c++11', '-Wall', '-Wextra', '-Werror', '-Wno-unused', '-fsanitize=address,undefined',
                    '-I' + str(r / 'tests/storage/stubs'), '-I' + str(r / 'OpenPuck'), str(p), '-o', td + '/test'],
                   check=True)
    subprocess.run([td + '/test'], check=True, env={'ASAN_OPTIONS': 'detect_leaks=0'})
print('Button profiles: migration, storage, validation and edits through the older settings')
