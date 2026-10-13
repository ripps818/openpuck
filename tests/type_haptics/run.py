from pathlib import Path
import subprocess, tempfile
root = Path(__file__).resolve().parents[2]
cfg_h = (root/'OpenPuck/config.h').read_text()
cfg_c = (root/'OpenPuck/config.cpp').read_text()
web = (root/'OpenPuck/webusb_config.cpp').read_text()

# the shipped table, setter and load loop, and the WebUSB field and blob code, spliced into one harness
consts = cfg_h[cfg_h.index('enum {\n\tHAP_KNEE'):cfg_h.index('extern uint8_t g_typeHaptic')]
table = cfg_c[cfg_c.index('uint8_t g_typeHaptic[HAP_COUNT]'):cfg_c.index('bool typeHapticSet(')]
helpers = cfg_h[cfg_h.index('// gain in dB of click step'):cfg_h.index('// 1 = the active DualSense profile maps Create')]
setter = cfg_c[cfg_c.index('bool typeHapticSet('):]
setter = setter[:setter.index('\n}\n') + 3]
load = cfg_c[cfg_c.index('\t// per-type haptic settings; one missing'):cfg_c.index('\tif (c.hdPadScale2 <= 250)')]
load += cfg_c[cfg_c.index('\tfor (uint8_t et = 0; et < ET_COUNT; et++) {\n\t\tif (c.typeQamSelect'):cfg_c.index('\t// bits 1 and 2 were')]
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
uint8_t g_hapticLift = 1;
#define QAM_SELECT_MAX 20
uint8_t g_typeQamSelect[ET_COUNT] = { 0, 0, 0, 0 };
#define SHORTCUT_CAPTURE 16u
uint8_t g_hapticLimitKnee = 70, g_audioHapticStyle = 3, g_padClick = 26, g_padTick = 0, g_padTickGain = 11;
uint16_t g_typeRumbleScale[ET_COUNT] = {};
int applied = 0, saved = 0;
bool g_blobRequest = false;
void applyActiveType() { ++applied; }
void saveCfg() { ++saved; }
void saveCfgSoon() { ++saved; }
''' + consts + table + helpers + setter + '''
struct Cfg { uint8_t typeHaptic[HAP_COUNT][ET_COUNT]; uint8_t swDpadHaptics, swQamSelect, shortcutFlags, typeQamSelect[ET_COUNT]; };
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
	// defaults: every type on wave; 85% limiter, -9 dB click, ticks left to the controller
	for (int et = 0; et < ET_COUNT; et++) {
		assert(g_typeHaptic[HAP_KNEE][et] == 85 && g_typeHaptic[HAP_CLICK][et] == 26 && g_typeHaptic[HAP_TICK][et] == 0 && g_typeHaptic[HAP_TICKGAIN][et] == 11);
		assert(g_typeHaptic[HAP_STYLE][et] == AUDIO_STYLE_WAVE && g_typeHaptic[HAP_LIFT][et] == 1);
	}
	// soft boost: 0..4 on the Switch and DualSense only
	assert(typeHapticSet(HAP_LIFT, ET_SWITCH, 0) && typeHapticSet(HAP_LIFT, ET_DS5, 4) && !typeHapticSet(HAP_LIFT, ET_DS5, 5) && !typeHapticSet(HAP_LIFT, ET_XBOX, 2));
	typeHapticSet(HAP_LIFT, ET_SWITCH, 1); typeHapticSet(HAP_LIFT, ET_DS5, 1);
	// trigger haptics: off / trackpads / grips / both, DualSense only, trackpads by default
	assert(g_typeHaptic[HAP_TRIG][ET_DS5] == TRIG_HAPTICS_PADS && typeHapticSet(HAP_TRIG, ET_DS5, TRIG_HAPTICS_BOTH) && !typeHapticSet(HAP_TRIG, ET_DS5, 4) && !typeHapticSet(HAP_TRIG, ET_SWITCH, 1));
	typeHapticSet(HAP_TRIG, ET_DS5, TRIG_HAPTICS_PADS);
	// D-pad click feedback: on/off for every type, on by default
	for (int et = 0; et < ET_COUNT; et++) assert(g_typeHaptic[HAP_DPAD][et] == 1 && typeHapticSet(HAP_DPAD, (uint8_t)et, 0) && !typeHapticSet(HAP_DPAD, (uint8_t)et, 2) && typeHapticSet(HAP_DPAD, (uint8_t)et, 1));
	// the setter takes in-range values for the types that have the setting, and refreshes the live copies
	applied = 0;
	assert(typeHapticSet(HAP_KNEE, ET_SWITCH, 50) && typeHapticSet(HAP_KNEE, ET_DS5, 100) && g_typeHaptic[HAP_KNEE][ET_SWITCH] == 50 && applied == 2);
	assert(typeHapticSet(HAP_STYLE, ET_DS5, AUDIO_STYLE_SPLIT) && g_typeHaptic[HAP_STYLE][ET_DS5] == AUDIO_STYLE_SPLIT);
	assert(typeHapticSet(HAP_CLICK, ET_XBOX, 0) && typeHapticSet(HAP_CLICK, ET_DS4, 31) && typeHapticSet(HAP_TICK, ET_XBOX, 4) && typeHapticSet(HAP_TICKGAIN, ET_SWITCH, 31));
	// ...and refuses the rest without touching anything
	applied = 0;
	assert(!typeHapticSet(HAP_KNEE, ET_XBOX, 70) && !typeHapticSet(HAP_KNEE, ET_DS4, 70) && !typeHapticSet(HAP_STYLE, ET_XBOX, 1));
	assert(!typeHapticSet(HAP_KNEE, ET_SWITCH, 49) && !typeHapticSet(HAP_KNEE, ET_SWITCH, 101));
	assert(!typeHapticSet(HAP_STYLE, ET_SWITCH, 4) && !typeHapticSet(HAP_CLICK, ET_SWITCH, 32) && !typeHapticSet(HAP_CLICK, ET_SWITCH, 255) && !typeHapticSet(HAP_TICK, ET_SWITCH, 5) && !typeHapticSet(HAP_TICKGAIN, ET_SWITCH, 32));
	assert(!typeHapticSet(HAP_COUNT, ET_SWITCH, 1) && !typeHapticSet(HAP_KNEE, ET_COUNT, 70));
	assert(applied == 0 && g_typeHaptic[HAP_KNEE][ET_XBOX] == 85 && g_typeHaptic[HAP_STYLE][ET_SWITCH] == AUDIO_STYLE_WAVE);

	// a v29 file has none of the grid (0xFF): the limiter and the DualSense style come from the shared values
	// the older file kept, everything else keeps its default
	Cfg old; memset(&old, 255, sizeof old);
	g_hapticLimitKnee = 85; g_audioHapticStyle = AUDIO_STYLE_TONE;
	for (int k = 0; k < HAP_COUNT; k++) for (int et = 0; et < ET_COUNT; et++) g_typeHaptic[k][et] = 0;
	g_typeHaptic[HAP_STYLE][ET_SWITCH] = AUDIO_STYLE_WAVE; g_typeHaptic[HAP_STYLE][ET_XBOX] = AUDIO_STYLE_WAVE;
	g_typeHaptic[HAP_STYLE][ET_DS4] = AUDIO_STYLE_WAVE; g_typeHaptic[HAP_CLICK][ET_SWITCH] = 26; g_typeHaptic[HAP_CLICK][ET_DS5] = 26;
	load(old);
	assert(g_typeHaptic[HAP_KNEE][ET_SWITCH] == 85 && g_typeHaptic[HAP_KNEE][ET_DS5] == 85);
	assert(g_typeHaptic[HAP_STYLE][ET_DS5] == AUDIO_STYLE_TONE && g_typeHaptic[HAP_STYLE][ET_SWITCH] == AUDIO_STYLE_WAVE);
	assert(g_typeHaptic[HAP_CLICK][ET_SWITCH] == 26 && g_typeHaptic[HAP_TICK][ET_SWITCH] == 0);
	// D-pad click feedback: the Switch's starts from the old Switch-only byte when it holds a value
	Cfg dpadOld = old; dpadOld.swDpadHaptics = 1; g_typeHaptic[HAP_DPAD][ET_SWITCH] = 0; load(dpadOld);
	assert(g_typeHaptic[HAP_DPAD][ET_SWITCH] == 1);
	dpadOld.swDpadHaptics = 0; load(dpadOld); assert(g_typeHaptic[HAP_DPAD][ET_SWITCH] == 0);
	dpadOld.typeHaptic[HAP_DPAD][ET_SWITCH] = 1; load(dpadOld); assert(g_typeHaptic[HAP_DPAD][ET_SWITCH] == 1);
	// Quick Access + Select target: none by default; the Switch keeps the old Switch-only byte when its switch was on; a saved
	// per-type value wins and an out-of-range one is ignored
	Cfg qs = old; qs.swQamSelect = 9; qs.shortcutFlags = 41; g_typeQamSelect[1] = 0; load(qs); assert(g_typeQamSelect[ET_SWITCH] == 0); // its enable switch was off
	qs.shortcutFlags = 57; load(qs); assert(g_typeQamSelect[ET_SWITCH] == 9 && g_typeQamSelect[ET_XBOX] == 0);
	qs.swQamSelect = 0xFF; g_typeQamSelect[1] = 0; load(qs); assert(g_typeQamSelect[ET_SWITCH] == 18);
	qs.swQamSelect = 9;
	qs.typeQamSelect[ET_DS5] = 10; qs.typeQamSelect[ET_SWITCH] = 4; load(qs); assert(g_typeQamSelect[ET_DS5] == 10 && g_typeQamSelect[ET_SWITCH] == 4);
	qs.typeQamSelect[ET_DS5] = 21; g_typeQamSelect[ET_DS5] = 0; load(qs); assert(g_typeQamSelect[ET_DS5] == 0);
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
	assert(!field(119, 1) && !field(152 + ET_COUNT, 1));
	// field 152 + type is the Quick Access + Select target
	saved = 0; assert(field(152 + ET_DS5, 10) && g_typeQamSelect[ET_DS5] == 10 && saved == 1);
	assert(field(152 + ET_XBOX, 99) && g_typeQamSelect[ET_XBOX] == 0 && field(152 + ET_XBOX, 20) && g_typeQamSelect[ET_XBOX] == 20);
	g_typeQamSelect[ET_XBOX] = 0; g_typeQamSelect[ET_DS5] = 0;

	// the click pulse's gain byte: the default is +7 dB, and no valid strength is gain byte 0
	// (the legacy haptic stop)
	g_padClick = PAD_CLICK_DEFAULT; assert(padClickGain() == 0x07);
	assert(padClickGainDb(0) == -20 && padClickGainDb(19) == -1 && padClickGainDb(20) == 1 && padClickGainDb(31) == 12);
	for (int a = PAD_CLICK_MIN; a <= PAD_CLICK_MAX; a++) { g_padClick = (uint8_t)a; assert(padClickGain() != 0 && (int8_t)padClickGain() == padClickGainDb((uint8_t)a)); }
	assert(padTickSpacing(1) == 11000 && padTickSpacing(2) == 5500 && padTickSpacing(4) == 1500);
	g_padTickGain = PAD_TICKGAIN_DEFAULT; assert(padTickGain() == 0xF7);
	g_padTickGain = 31; assert((int8_t)padTickGain() == 12);
	// the controller's own ticks are pushed out of reach once when the puck plays them, and handed back when it stops
	uint8_t landed = 0xFF;
	assert(padTickCtrlDue(0, &landed) == PAD_CTRL_GIVE && landed == 0 && padTickCtrlDue(0, &landed) == PAD_CTRL_NONE);
	assert(padTickCtrlDue(2, &landed) == PAD_CTRL_TAKE && landed == 1 && padTickCtrlDue(3, &landed) == PAD_CTRL_NONE);
	assert(padTickCtrlDue(0, &landed) == PAD_CTRL_GIVE && landed == 0 && padTickCtrlDue(0, &landed) == PAD_CTRL_NONE);
	landed = 0xFF; assert(padTickCtrlDue(2, &landed) == PAD_CTRL_TAKE);

	// the status blob carries the grid from byte 216, setting-major
	uint8_t p[252]; memset(p, 0xEE, sizeof p);
	for (int k = 0; k < HAP_COUNT; k++) for (int et = 0; et < ET_COUNT; et++) g_typeHaptic[k][et] = (uint8_t)(10 * k + et);
	blobFill(p);
	for (int k = 0; k < HAP_COUNT; k++) for (int et = 0; et < ET_COUNT; et++) assert(p[216 + 4 * k + et] == 10 * k + et);
	assert(p[247] == 73 && p[211] == 0xEE); // the last byte of the grid; the strength bytes below it are not part of it
	// the Quick Access + Select targets follow the grid, one byte per type
	for (int et = 0; et < ET_COUNT; et++) g_typeQamSelect[et] = (uint8_t)(5 + et);
	blobFill(p);
	for (int et = 0; et < ET_COUNT; et++) assert(p[248 + et] == 5 + et);
	return 0;
}
'''
with tempfile.TemporaryDirectory() as td:
    f = Path(td)/'test.cpp'
    f.write_text(src)
    subprocess.run(['g++', '-std=c++11', '-g', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', str(f), '-o', td+'/test'], check=True)
    subprocess.run([td+'/test'], check=True, env={'ASAN_OPTIONS': 'detect_leaks=0'})
print('Per-type haptic settings: defaults, limits, v29 migration, WebUSB fields and status blob tests passed')
