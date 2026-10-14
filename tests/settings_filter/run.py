"""The host's settings writes are relayed to the controller through filterSettingsRelay: the IMU mode is always
dropped, and in pure Lizard mode so is the lizard/pad-haptics switch (id9), which the puck lands itself."""
from pathlib import Path
import subprocess, tempfile

r = Path(__file__).resolve().parents[2]
src = (r / 'OpenPuck/puck_hid.cpp').read_text()
fn = src[src.index('static uint8_t filterSettingsRelay('):]
fn = fn[:fn.index('\n}\n') + 3]

test = r'''
#include <cassert>
#include <cstdint>
#include <cstring>
#define RELAY_CMD_MAXP 60
#define SETTING_IMU_MODE 48
#define SETTING_LIZARD_MODE 9
#define SETTING_LED_BRIGHTNESS 45
#define MODE_STEAM 0
#define MODE_LIZARD 3
#define MODE_XBOX 1
static uint8_t g_usbMode = MODE_STEAM;
''' + fn + r'''
static uint8_t run(const uint8_t *in, uint16_t n, uint8_t *out)
{
	return filterSettingsRelay(in, n, out);
}
int main()
{
	uint8_t out[RELAY_CMD_MAXP];
	// Steam's lizard-off heartbeat: id9=0 alone, then with another setting after it
	const uint8_t liz[3] = { SETTING_LIZARD_MODE, 0, 0 };
	const uint8_t mix[9] = { SETTING_LED_BRIGHTNESS, 50, 0, SETTING_LIZARD_MODE, 0, 0, SETTING_IMU_MODE, 7, 0 };
	// Steam mode relays id9 (Steam owns the controller there); only the IMU mode is dropped
	g_usbMode = MODE_STEAM;
	assert(run(liz, 3, out) == 3 && !memcmp(out, liz, 3));
	assert(run(mix, 9, out) == 6 && out[0] == SETTING_LED_BRIGHTNESS && out[3] == SETTING_LIZARD_MODE);
	// pure Lizard drops it, and keeps the settings around it
	g_usbMode = MODE_LIZARD;
	assert(run(liz, 3, out) == 0);
	assert(run(mix, 9, out) == 3 && out[0] == SETTING_LED_BRIGHTNESS && out[1] == 50);
	// emulated modes are untouched too, and a truncated trailing tuple is still ignored
	g_usbMode = MODE_XBOX;
	assert(run(liz, 3, out) == 3);
	assert(run(liz, 2, out) == 0);
	return 0;
}
'''
with tempfile.TemporaryDirectory() as td:
    p = Path(td) / 'test.cpp'
    p.write_text(test)
    subprocess.run(['g++', '-std=c++11', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', str(p), '-o', td + '/test'], check=True)
    subprocess.run([td + '/test'], check=True, env={'ASAN_OPTIONS': 'detect_leaks=0'})
print('Settings relay filter: the IMU mode is dropped everywhere, id9 also in pure Lizard')
