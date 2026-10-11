from pathlib import Path
import subprocess, tempfile
root = Path(__file__).resolve().parents[2]
cfg_h = (root/'OpenPuck/config.h').read_text()
cfg_c = (root/'OpenPuck/config.cpp').read_text()
web = (root/'OpenPuck/webusb_config.cpp').read_text()

# the real helpers and limits, straight from config.h
helpers = cfg_h[cfg_h.index('#define PAD_CLICK_ATTEN_MIN'):cfg_h.index('extern uint8_t g_padClickCfg')]
helpers += cfg_h[cfg_h.index('// the s8 gain_db byte'):cfg_h.index('// 1 = host rumble relay on')]
# the shipped loadCfg() and WebUSB field code, spliced into harnesses
load = cfg_c[cfg_c.index('\t// trackpad haptic strength:'):cfg_c.index('\tif (c.swDpadHaptics <= 1)')]
fields = web[web.index('\t\t\t\tcase 117:'):web.index('\t\t\t\t// Trigger deadzone / full-press point')]

head = '''#include <cassert>
#include <cstdint>
#include <cstring>
#define ET_COUNT 4
uint8_t g_padClickAtten = 9, g_padTick = 0;
uint8_t g_padClickCfg[ET_COUNT] = { 9, 9, 9, 9 }, g_padTickCfg[ET_COUNT] = {};
int applied = 0;
void applyActiveType() { ++applied; }
''' + helpers + '''
struct Cfg { uint8_t padClickAtten[ET_COUNT], padTick[ET_COUNT]; };
static void load(const Cfg &c)
{
''' + load + '''}
static void field(uint8_t f, uint8_t v)
{
	switch (f) {
''' + fields + '''	}
}
'''

body = '''
int main()
{
	// the strength every type has always had is 0xF7; the ends of the range stay clear of gain byte 0
	g_padClickAtten = PAD_CLICK_ATTEN_DEFAULT;
	assert(padClickGain() == 0xF7);
	g_padClickAtten = PAD_CLICK_ATTEN_MIN;
	assert(padClickGain() == 0xFF);
	g_padClickAtten = PAD_CLICK_ATTEN_MAX;
	assert(padClickGain() == 0xE2);
	for (int a = PAD_CLICK_ATTEN_MIN; a <= PAD_CLICK_ATTEN_MAX; a++) {
		g_padClickAtten = a;
		assert(padClickGain() != 0 && (int8_t)padClickGain() == -a);
	}

	// a tick level is written once per connect episode, again when it changes, never for "leave it alone"
	uint8_t landed = 0xFF;
	assert(!padTickDue(0, &landed) && landed == 0xFF);
	assert(padTickDue(3, &landed) && landed == 3);
	assert(!padTickDue(3, &landed));
	assert(padTickDue(1, &landed) && landed == 1);
	assert(!padTickDue(0, &landed) && landed == 1);
	landed = 0xFF; // controller reconnected
	assert(padTickDue(1, &landed));

	// an older cfg.bin leaves the 0xFF fill: every type keeps the defaults
	Cfg c;
	memset(&c, 0xFF, sizeof c);
	load(c);
	for (int et = 0; et < ET_COUNT; et++)
		assert(g_padClickCfg[et] == PAD_CLICK_ATTEN_DEFAULT && g_padTickCfg[et] == PAD_TICK_DEFAULT);
	// saved values load per type; out-of-range ones are dropped without touching the others
	Cfg d = { { 1, 30, 0, 31 }, { 4, 0, 5, 2 } };
	load(d);
	assert(g_padClickCfg[0] == 1 && g_padClickCfg[1] == 30);
	assert(g_padClickCfg[2] == PAD_CLICK_ATTEN_DEFAULT && g_padClickCfg[3] == PAD_CLICK_ATTEN_DEFAULT);
	assert(g_padTickCfg[0] == 4 && g_padTickCfg[1] == 0 && g_padTickCfg[2] == 0 && g_padTickCfg[3] == 2);

	// WebUSB fields 117..120 click, 121..124 tick: in range they set that type and refresh the live mirrors
	applied = 0;
	field(118, 20);
	assert(g_padClickCfg[1] == 20 && applied == 1);
	field(124, 4);
	assert(g_padTickCfg[3] == 4 && applied == 2);
	// out of range is ignored (0 is the stop byte, 31 is past the table, tick 5 is no level)
	field(117, 0);
	field(117, 31);
	field(119, 255);
	field(121, 5);
	field(123, 255);
	assert(g_padClickCfg[0] == 1 && g_padClickCfg[2] == PAD_CLICK_ATTEN_DEFAULT);
	assert(g_padTickCfg[0] == 4 && g_padTickCfg[2] == 0 && applied == 2);
	// each field edits only its own type
	field(119, 5);
	assert(g_padClickCfg[0] == 1 && g_padClickCfg[1] == 20 && g_padClickCfg[2] == 5 && g_padClickCfg[3] == PAD_CLICK_ATTEN_DEFAULT);
}
'''

with tempfile.TemporaryDirectory() as td:
    p = Path(td)/'test.cpp'
    p.write_text(head + body)
    subprocess.run(['g++', '-std=c++11', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', str(p), '-o', td + '/test'], check=True)
    subprocess.run([td + '/test'], check=True, env={'ASAN_OPTIONS': 'detect_leaks=0'})
print('Trackpad click / tick strength tests passed')
