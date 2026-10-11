from pathlib import Path
import subprocess, tempfile
root = Path(__file__).resolve().parents[2]
cfg_h = (root/'OpenPuck/config.h').read_text()
cfg_c = (root/'OpenPuck/config.cpp').read_text()
web = (root/'OpenPuck/webusb_config.cpp').read_text()

# the shipped table, setter and load loop, and the WebUSB field and blob code, spliced into one harness
consts = cfg_h[cfg_h.index('enum { HAP_KNEE'):cfg_h.index('extern uint8_t g_typeHaptic')]
table = cfg_c[cfg_c.index('uint8_t g_typeHaptic[HAP_COUNT]'):cfg_c.index('bool typeHapticSet(')]
helpers = cfg_h[cfg_h.index('// the s8 gain_db byte'):cfg_h.index('// 1 = the active DualSense profile maps Create')]
setter = cfg_c[cfg_c.index('bool typeHapticSet('):]
setter = setter[:setter.index('\n}\n') + 3]
load = cfg_c[cfg_c.index('\t// per-type haptic settings; one missing'):cfg_c.index('\tif (c.swDpadHaptics <= 1)')]
field = web[web.index('\t\t\t\tif (f >= 120 && f < 120 + 4 * HAP_COUNT) {'):web.index('\t\t\t\t// fields 190..229 were')]
blob = web[web.index('\tfor (uint8_t et = 0; et < ET_COUNT; et++) {\n\t\tp[212 + et]'):web.index('\t// CRITICAL: usb_web.write()')]

src = '''#include <cassert>
#include <cstdint>
#include <cstring>
#define ET_XBOX 0
#define ET_SWITCH 1
#define ET_DS4 2
#define ET_DS5 3
#define ET_COUNT 4
#define AUDIO_STYLE_RUMBLE 0
#define AUDIO_STYLE_TONE 1
#define AUDIO_STYLE_SPLIT 2
#define AUDIO_STYLE_WAVE 3
uint8_t g_hapticLimitKnee = 70, g_audioHapticStyle = 3, g_padClickAtten = 9, g_padTick = 0;
uint16_t g_typeRumbleScale[ET_COUNT] = {};
int applied = 0, saved = 0;
bool g_blobRequest = false;
void applyActiveType() { ++applied; }
void saveCfg() { ++saved; }
''' + consts + table + helpers + setter + '''
struct Cfg { uint8_t typeHaptic[HAP_COUNT][ET_COUNT]; };
static void load(const Cfg &c)
{
''' + load + '''}
// returns whether the field was taken by the per-type range (the real code continues the receive loop)
static bool field(uint8_t f, uint8_t v)
{
	uint8_t buf[8] = {};
	int n = 3, need = 3;
	bool handled = true;
	do {
''' + field + '''		handled = false;
	} while (0);
	return handled;
}
static void blobFill(uint8_t *p)
{
''' + blob + '''}
int main()
{
	// defaults: Switch on tones, the rest on wave; 70% limiter, -9 dB click, ticks left to the controller
	for (int et = 0; et < ET_COUNT; et++) {
		assert(g_typeHaptic[HAP_KNEE][et] == 70 && g_typeHaptic[HAP_CLICK][et] == 9 && g_typeHaptic[HAP_TICK][et] == 0);
		assert(g_typeHaptic[HAP_STYLE][et] == (et == ET_SWITCH ? AUDIO_STYLE_TONE : AUDIO_STYLE_WAVE));
	}
	// the setter takes in-range values for the types that have the setting, and refreshes the live copies
	applied = 0;
	assert(typeHapticSet(HAP_KNEE, ET_SWITCH, 50) && typeHapticSet(HAP_KNEE, ET_DS5, 100) && g_typeHaptic[HAP_KNEE][ET_SWITCH] == 50 && applied == 2);
	assert(typeHapticSet(HAP_STYLE, ET_DS5, AUDIO_STYLE_SPLIT) && g_typeHaptic[HAP_STYLE][ET_DS5] == AUDIO_STYLE_SPLIT);
	assert(typeHapticSet(HAP_CLICK, ET_XBOX, 1) && typeHapticSet(HAP_CLICK, ET_DS4, 30) && typeHapticSet(HAP_TICK, ET_XBOX, 4));
	// ...and refuses the rest without touching anything
	applied = 0;
	assert(!typeHapticSet(HAP_KNEE, ET_XBOX, 70) && !typeHapticSet(HAP_KNEE, ET_DS4, 70) && !typeHapticSet(HAP_STYLE, ET_XBOX, 1));
	assert(!typeHapticSet(HAP_KNEE, ET_SWITCH, 49) && !typeHapticSet(HAP_KNEE, ET_SWITCH, 101));
	assert(!typeHapticSet(HAP_STYLE, ET_SWITCH, 4) && !typeHapticSet(HAP_CLICK, ET_SWITCH, 0) && !typeHapticSet(HAP_CLICK, ET_SWITCH, 31) && !typeHapticSet(HAP_TICK, ET_SWITCH, 5));
	assert(!typeHapticSet(HAP_COUNT, ET_SWITCH, 1) && !typeHapticSet(HAP_KNEE, ET_COUNT, 70));
	assert(applied == 0 && g_typeHaptic[HAP_KNEE][ET_XBOX] == 70 && g_typeHaptic[HAP_STYLE][ET_SWITCH] == AUDIO_STYLE_TONE);

	// a v29 file has none of the grid (0xFF): the limiter and the DualSense style come from the shared values
	// the older file kept, everything else keeps its default
	Cfg old; memset(&old, 255, sizeof old);
	g_hapticLimitKnee = 85; g_audioHapticStyle = AUDIO_STYLE_TONE;
	for (int k = 0; k < HAP_COUNT; k++) for (int et = 0; et < ET_COUNT; et++) g_typeHaptic[k][et] = 0;
	g_typeHaptic[HAP_STYLE][ET_SWITCH] = AUDIO_STYLE_TONE; g_typeHaptic[HAP_STYLE][ET_XBOX] = AUDIO_STYLE_WAVE;
	g_typeHaptic[HAP_STYLE][ET_DS4] = AUDIO_STYLE_WAVE; g_typeHaptic[HAP_CLICK][ET_SWITCH] = 9; g_typeHaptic[HAP_CLICK][ET_DS5] = 9;
	load(old);
	assert(g_typeHaptic[HAP_KNEE][ET_SWITCH] == 85 && g_typeHaptic[HAP_KNEE][ET_DS5] == 85);
	assert(g_typeHaptic[HAP_STYLE][ET_DS5] == AUDIO_STYLE_TONE && g_typeHaptic[HAP_STYLE][ET_SWITCH] == AUDIO_STYLE_TONE);
	assert(g_typeHaptic[HAP_CLICK][ET_SWITCH] == 9 && g_typeHaptic[HAP_TICK][ET_SWITCH] == 0);
	// a saved grid wins, value by value; an out-of-range entry falls back
	Cfg saved_cfg = old;
	saved_cfg.typeHaptic[HAP_KNEE][ET_SWITCH] = 60; saved_cfg.typeHaptic[HAP_STYLE][ET_SWITCH] = AUDIO_STYLE_RUMBLE;
	saved_cfg.typeHaptic[HAP_CLICK][ET_DS4] = 20; saved_cfg.typeHaptic[HAP_TICK][ET_XBOX] = 3; saved_cfg.typeHaptic[HAP_TICK][ET_DS4] = 9;
	load(saved_cfg);
	assert(g_typeHaptic[HAP_KNEE][ET_SWITCH] == 60 && g_typeHaptic[HAP_STYLE][ET_SWITCH] == AUDIO_STYLE_RUMBLE);
	assert(g_typeHaptic[HAP_CLICK][ET_DS4] == 20 && g_typeHaptic[HAP_TICK][ET_XBOX] == 3 && g_typeHaptic[HAP_TICK][ET_DS4] == 0);

	// WebUSB field 120 + 4 * setting + type reaches the setter (and saves); anything outside the range is left alone
	saved = 0; g_blobRequest = false;
	assert(field(120 + 4 * HAP_STYLE + ET_DS5, AUDIO_STYLE_SPLIT) && g_typeHaptic[HAP_STYLE][ET_DS5] == AUDIO_STYLE_SPLIT && saved == 1 && g_blobRequest);
	assert(field(120 + 4 * HAP_CLICK + ET_XBOX, 12) && g_typeHaptic[HAP_CLICK][ET_XBOX] == 12);
	assert(field(120 + 4 * HAP_TICK + ET_DS4, 2) && g_typeHaptic[HAP_TICK][ET_DS4] == 2);
	uint8_t xboxKnee = g_typeHaptic[HAP_KNEE][ET_XBOX];
	assert(field(120 + 4 * HAP_KNEE + ET_XBOX, 90) && g_typeHaptic[HAP_KNEE][ET_XBOX] == xboxKnee); // that type has no limiter
	assert(!field(119, 1) && !field(120 + 4 * HAP_COUNT, 1));

	// the click pulse's gain byte: the strength every type has always had is 0xF7, and no valid strength is gain byte 0
	// (the legacy haptic stop)
	g_padClickAtten = PAD_CLICK_ATTEN_DEFAULT; assert(padClickGain() == 0xF7);
	for (int a = PAD_CLICK_ATTEN_MIN; a <= PAD_CLICK_ATTEN_MAX; a++) { g_padClickAtten = (uint8_t)a; assert(padClickGain() != 0 && (int8_t)padClickGain() == -a); }
	// a movement-tick level is written once per connect episode, again when it changes, and never for 0 (leave the controller's)
	uint8_t landed = 0xFF;
	assert(!padTickDue(0, &landed) && landed == 0xFF);
	assert(padTickDue(2, &landed) && landed == 2 && !padTickDue(2, &landed));
	assert(padTickDue(3, &landed) && landed == 3);
	assert(!padTickDue(0, &landed) && landed == 3);
	landed = 0xFF; assert(padTickDue(3, &landed));

	// the status blob carries the grid from byte 216, setting-major
	uint8_t p[232]; memset(p, 0xEE, sizeof p);
	for (int k = 0; k < HAP_COUNT; k++) for (int et = 0; et < ET_COUNT; et++) g_typeHaptic[k][et] = (uint8_t)(10 * k + et);
	blobFill(p);
	for (int k = 0; k < HAP_COUNT; k++) for (int et = 0; et < ET_COUNT; et++) assert(p[216 + 4 * k + et] == 10 * k + et);
	assert(p[231] == 33 && p[211] == 0xEE); // the last byte of the grid; the strength bytes below it are not part of it
	return 0;
}
'''
with tempfile.TemporaryDirectory() as td:
    f = Path(td)/'test.cpp'
    f.write_text(src)
    subprocess.run(['g++', '-std=c++11', '-g', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', str(f), '-o', td+'/test'], check=True)
    subprocess.run([td+'/test'], check=True, env={'ASAN_OPTIONS': 'detect_leaks=0'})
print('Per-type haptic settings: defaults, limits, v29 migration, WebUSB fields and status blob tests passed')
