"""Characterization test for the button-mapping code in every emulated mode.

Compiles the real builder functions (sliced out of the firmware sources, like the other host tests) against
mocks, drives each with every remappable source x paddle/QAM code x A/B swap setting, and compares a digest of
the output with golden.txt. The golden file was recorded from the code as it was BEFORE the shared remap layer,
so a refactor that is meant to change nothing has to leave every digest alone.

  python3 tests/button_map/run.py           check against golden.txt
  python3 tests/button_map/run.py --update  rewrite golden.txt (only for an intended behaviour change)
  python3 tests/button_map/run.py --dump    print every recorded line, to diff two versions of the code
"""
from pathlib import Path
import hashlib, subprocess, sys, tempfile

r = Path(__file__).resolve().parents[2]
src = lambda n: (r / 'OpenPuck' / n).read_text()


def cut(text, a, b=None):
    i = text.index(a)
    return text[i:] if b is None else text[i:text.index(b, i)]


xi, hori, jc = src('mode_xinput.cpp'), src('mode_switch_hori.cpp'), src('mode_switch_pro.cpp')
og, ps3, ps5 = src('mode_xbox_og.cpp'), src('mode_ps3.cpp'), src('mode_ps5.cpp')
hg, gu = src('mode_hidgyro.cpp'), src('gamepad_util.cpp')

head = r'''
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <cassert>
#include "triton.h"
#include "config.h"
#include "gamepad_util.h"
#include "rf_link.h"
#include "usb_mount.h"

// ---- globals the builders read ----
PuckInput g_in[NSLOT];
uint8_t g_abSwap, g_back[4], g_qamMap, g_shortcutFlags, g_swQamSelect = 18, g_padStick[2];
uint8_t g_trigInner = 0, g_trigOuter = 100, g_createAsTouch, g_swGyroLegacy;
bool g_touchpadDisabled;
volatile uint8_t g_battery[NSLOT], g_batteryState[NSLOT];
int8_t g_usbToBond[NSLOT] = { 0, 1, 2, 3 };

// ---- stubs: everything that is not button mapping ----
uint8_t swStick(int16_t, bool) { return 0x80; }
void slotSticks(uint8_t, int16_t *a, int16_t *b, int16_t *c, int16_t *d) { *a = *b = *c = *d = 0; }
uint32_t padDpadButtons(const PuckInput &) { return 0; }
void padStickBlend(uint32_t, int16_t, int16_t, int16_t, int16_t, int16_t *, int16_t *, int16_t *, int16_t *) {}
void padClickEdge(uint8_t, uint32_t) {}
void psImuPack(uint8_t *, const PuckInput &) {}
void steamPadsToTouch(uint32_t, uint16_t, int16_t, int16_t, int16_t, int16_t, uint16_t *a, uint16_t *b, uint16_t *c, uint16_t *d) { *a = *b = *c = *d = 0; }
void touchPackPadsStateful(uint8_t, uint8_t *, bool, bool, uint16_t, uint16_t, uint16_t, uint16_t) {}
uint32_t micros() { return 0; }
#define PS5_TOUCH_H 1
#define DS4_TOUCH_H 1
#define PS5_STATUS_USB 0
#define DS4_STATUS_USB 0
#define SW_ACCEL_DIV 4

// the Xbox mode hands its result to the USB endpoint; capture it instead
static uint16_t xbBtn;
static uint8_t xbLt, xbRt;
static void xinputSend(uint8_t, uint16_t b, uint8_t lt, uint8_t rt, int16_t, int16_t, int16_t, int16_t)
{
	xbBtn = b;
	xbLt = lt;
	xbRt = rt;
}
'''

slices = [
    # shared PlayStation packers: psButtonsFromSteam and the code tables behind it
    (r / 'OpenPuck/remap.cpp').read_text(),
    cut(gu, 'uint32_t psButtonsFromSteam('),
    # Xbox 360
    cut(xi, 'enum {\n\tXB_DUP', '// ===================== XInput custom TinyUSB class driver'),
    cut(xi, 'static void rfXboxGamepad(', '// Right pad -> mouse on a second HID-mouse interface'),
    # Switch HORIPAD
    cut(hori, '// HORIPAD/Switch button bits', '// Dynamic-mount mode: begin() is unused'),
    # Switch Pro
    cut(jc, '#define JC_BTN_Y', '#define JC_BTN_ZL') + '#define JC_BTN_ZL (1u << 23)\n',
    'static inline uint8_t jcBondOf(uint8_t u) { return u; }\nstatic uint8_t g_jcTimer[NSLOT];\n',
    cut(jc, 'static int jcStick12(', 'static void switchProBuild('),
    # Original Xbox
    cut(og, 'enum {\n\tXBOX_OG_DUP', 'struct XboxOgOutputReport'),
    '#pragma pack(pop)\n',
    cut(og, 'static void xboxOgNeutralReport(', '// Wholesale clear'),
    cut(og, 'static void xboxOgBuildReport(', 'static bool xboxOgBondRecent('),
    # PS3
    cut(ps3, 'static void ds3Imu(', '// Neutral input report'),
    # DualSense and DS4
    cut(ps5, '// usbSlot drives the per-HID sequence counter', '// Dynamic-mount mode: begin() is unused'),
    cut(hg, '// usbSlot drives the per-HID counters', '// Dynamic-mount mode: begin() is unused'),
]

SOURCES = [('A', 'TB_A'), ('B', 'TB_B'), ('X', 'TB_X'), ('Y', 'TB_Y'), ('LB', 'TB_LB'), ('RB', 'TB_RB'),
           ('L3', 'TB_L3'), ('R3', 'TB_R3'), ('VIEW', 'TB_VIEW'), ('MENU', 'TB_MENU'), ('STEAM', 'TB_STEAM'),
           ('DUP', 'TB_DUP'), ('DDN', 'TB_DDN'), ('DLF', 'TB_DLF'), ('DRT', 'TB_DRT'), ('L4', 'TB_L4'),
           ('R4', 'TB_R4'), ('L5', 'TB_L5'), ('R5', 'TB_R5'), ('QAM', 'TB_QAM'), ('LPADC', 'TB_LPADC'),
           ('RPADC', 'TB_RPADC'), ('L2', 'TB_L2'), ('R2', 'TB_R2')]
srcs = ',\n'.join(f'\t{{ "{n}", {m} }}' for n, m in SOURCES)

main = r'''
struct Src { const char *name; uint32_t mask; };
static const Src SRC[] = {
''' + srcs + r'''
};
#define NSRC (int)(sizeof SRC / sizeof SRC[0])

// each builder: set up the input for `raw`, run it, print the host-visible button fields
typedef void (*Run)(uint32_t raw);
static uint8_t rep[46], out[64];
static void load(uint32_t raw)
{
	memset(rep, 0, sizeof rep);
	rep[0] = 0x45;
	for (int i = 0; i < 4; i++)
		rep[2 + i] = (uint8_t)(raw >> (8 * i));
	memset(&g_in[0], 0, sizeof g_in[0]);
	g_in[0].buttons = raw;
	memset(out, 0, sizeof out);
}
static void runXbox(uint32_t raw)
{
	load(raw);
	rfXboxGamepad(0, rep);
	printf("btn=%04x lt=%02x rt=%02x", xbBtn, xbLt, xbRt);
}
static void runHori(uint32_t raw)
{
	load(raw);
	switchBuildHoripad(0, out);
	printf("btn=%02x%02x hat=%d", out[1], out[0], out[2]);
}
static void runJc(uint32_t raw)
{
	load(raw);
	jcInputPrefix(0, out);
	printf("btn=%02x%02x%02x", out[4], out[3], out[2]);
}
static void runOg(uint32_t raw)
{
	load(raw);
	XboxOgInputReport rp;
	xboxOgBuildReport(rp, rep);
	printf("btn=%02x a=%02x b=%02x x=%02x y=%02x blk=%02x wht=%02x lt=%02x rt=%02x", rp.buttons, rp.a, rp.b,
	       rp.x, rp.y, rp.black, rp.white, rp.left_trigger, rp.right_trigger);
}
static void runPs3(uint32_t raw)
{
	load(raw);
	ds3Build(0, out);
	printf("sel=%02x face=%02x ps=%02x press=", out[1], out[2], out[3]);
	for (int i = 13; i <= 24; i++)
		printf("%02x", out[i]);
}
static void runPs5(uint32_t raw)
{
	load(raw);
	ps5Build(0, 0, out);
	printf("hat+face=%02x shoulders=%02x misc=%02x", out[7], out[8], out[9]);
}
static void runDs4(uint32_t raw)
{
	load(raw);
	hidGyroBuild(0, 0, out);
	printf("hat+face=%02x shoulders=%02x misc=%02x", out[4], out[5], out[6] & 0x0F);
}
static const struct { const char *name; Run run; bool follow; } BUILDERS[] = {
	{ "xbox", runXbox, false }, { "hori", runHori, true }, { "switchpro", runJc, true },
	{ "xboxog", runOg, false }, { "ps3", runPs3, true },   { "ps5", runPs5, true },
	{ "ds4", runDs4, true },
};

static bool follow; // the Xbox types keep paddle targets absolute under the swap
static void cfg(int swap, int code, uint8_t flags)
{
	g_abSwap = (uint8_t)swap;
	// each paddle gets a different code so the paddle -> code index is exercised too
	for (int i = 0; i < 4; i++)
		g_back[i] = (uint8_t)((code + i) % 21);
	g_qamMap = (uint8_t)code;
	g_shortcutFlags = flags;
	remapLegacyMap(&g_btnMap, g_back, g_qamMap, g_abSwap, follow);
}
static void line(const char *b, int swap, int code, uint8_t flags, uint32_t raw, Run run)
{
	printf("%s sw=%d c=%d f=%u raw=%08x ", b, swap, code, flags, raw);
	run(raw);
	printf("\n");
}
// the map itself: identity by default, any source to any target, and the codes reserved for later
static void selfTest()
{
	ButtonMap m;
	remapDefaultMap(&m);
	g_btnMap = m;
	for (int s = 0; s < NSRC; s++) {
		uint32_t want = SRC[s].mask;
		if (SRC[s].mask == TB_L4)
			want = TB_LB; // the paddles start as LB, RB, L3, R3
		else if (SRC[s].mask == TB_R4)
			want = TB_RB;
		else if (SRC[s].mask == TB_L5)
			want = TB_L3;
		else if (SRC[s].mask == TB_R5)
			want = TB_R3;
		else if (SRC[s].mask == TB_QAM)
			want = 0;
		assert(remapButtons(SRC[s].mask) == want);
	}
	// bits that are not sources pass through untouched
	assert(remapButtons(TB_LPADT | TB_RPADT | TB_TOUCH | TB_MUTE) == (TB_LPADT | TB_RPADT | TB_TOUCH | TB_MUTE));
	// any source to any target, including the new pad-click and trigger-click targets
	m.target[RS_LB] = 1; // A
	m.target[RS_A] = 0; // disabled
	m.target[RS_LPADC] = 6; // RB
	m.target[RS_DUP] = 20; // right trigger
	m.target[RS_R2] = 22; // right pad click
	m.target[RS_SELECT] = 21; // left pad click
	g_btnMap = m;
	assert(remapButtons(TB_LB) == TB_A && remapButtons(TB_A) == 0 && remapButtons(TB_LPADC) == TB_RB);
	assert(remapButtons(TB_DUP) == TB_R2 && remapButtons(TB_R2) == TB_RPADC && remapButtons(TB_MENU) == TB_LPADC);
	// two sources to one target combine; two buttons trading places do not cascade
	m.target[RS_B] = 1;
	m.target[RS_A] = 2;
	g_btnMap = m;
	assert(remapButtons(TB_A | TB_B | TB_LB) == (TB_A | TB_B));
	assert(remapButtons(TB_A) == TB_B && remapButtons(TB_B) == TB_A);
	// Capture has no flag; it comes back beside the word
	bool cap = false;
	m.target[RS_STEAM] = REMAP_CODE_CAPTURE;
	g_btnMap = m;
	assert(remapButtons(TB_STEAM, &cap) == 0 && cap);
	assert(remapButtons(TB_X, &cap) == TB_X && !cap);
	// reserved and macro codes act as none
	m.target[RS_X] = 23;
	m.target[RS_Y] = REMAP_CODE_MACRO_BASE;
	m.target[RS_RB] = 255;
	g_btnMap = m;
	assert(remapButtons(TB_X | TB_Y | TB_RB) == 0);
	// the swap is a map: exchanged in pairs, and the paddle targets follow it unless the type is Xbox
	const uint8_t back[4] = { 1, 2, 3, 5 };
	remapLegacyMap(&m, back, 4, true, true);
	assert(remapFacesSwapped(m) && m.target[RS_A] == 2 && m.target[RS_Y] == 3);
	assert(m.target[RS_L4] == 2 && m.target[RS_R4] == 1 && m.target[RS_L5] == 4 && m.target[RS_R5] == 5);
	assert(m.target[RS_QAM] == 3);
	remapLegacyMap(&m, back, 4, true, false);
	assert(m.target[RS_L4] == 1 && m.target[RS_R4] == 2 && m.target[RS_QAM] == 3);
	remapLegacyMap(&m, back, 4, false, true);
	assert(!remapFacesSwapped(m) && m.target[RS_A] == 1 && m.target[RS_QAM] == 4);
	remapDefaultMap(&m);
	assert(!remapFacesSwapped(m));
}
int main()
{
	selfTest();
	for (const auto &bd : BUILDERS) {
		follow = bd.follow;
		// single source pressed alone, every code and swap setting
		printf("#%s single\n", bd.name);
		for (int swap = 0; swap < 2; swap++)
			for (int code = 0; code < 21; code++)
				for (int s = 0; s < NSRC; s++) {
					cfg(swap, code, SHORTCUT_ENABLED);
					line(bd.name, swap, code, SHORTCUT_ENABLED, SRC[s].mask, bd.run);
				}
		// everything at once (shortcuts off, so nothing is masked), so simultaneous sources combine
		printf("#%s all\n", bd.name);
		uint32_t all = 0;
		for (int s = 0; s < NSRC; s++)
			all |= SRC[s].mask;
		for (int swap = 0; swap < 2; swap++)
			for (int code = 0; code < 21; code++) {
				cfg(swap, code, 0);
				line(bd.name, swap, code, 0, all, bd.run);
			}
		// modifier held (back four, or Quick Access) plus one source: what the shortcut mask hides
		printf("#%s modifier\n", bd.name);
		const uint32_t mods[2] = { CHORD_BACK4, TB_QAM };
		const uint8_t fl[2] = { SHORTCUT_ENABLED, SHORTCUT_ENABLED | SHORTCUT_QAM };
		for (int m = 0; m < 2; m++)
			for (int swap = 0; swap < 2; swap++)
				for (int code = 0; code < 21; code += 5)
					for (int s = 0; s < NSRC; s++) {
						cfg(swap, code, fl[m]);
						line(bd.name, swap, code, fl[m], mods[m] | SRC[s].mask, bd.run);
					}
	}
	// the DualSense also folds Create into a touchpad click when asked
	printf("#ps5 createtouch\n");
	g_createAsTouch = 1;
	follow = true;
	for (int swap = 0; swap < 2; swap++)
		for (int code = 0; code < 21; code++)
			for (int s = 0; s < NSRC; s++) {
				cfg(swap, code, SHORTCUT_ENABLED);
				line("ps5", swap, code, SHORTCUT_ENABLED, SRC[s].mask, runPs5);
			}
	return 0;
}
'''

program = head + '\n'.join(slices) + main


def run_harness():
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / 'test.cpp'
        p.write_text(program)
        subprocess.run(['g++', '-std=c++11', '-Wall', '-Wextra', '-Werror', '-Wno-unused', '-Wno-unused-parameter',
                        '-fsanitize=address,undefined', '-I' + str(r / 'OpenPuck'), str(p), '-o', td + '/test'],
                       check=True)
        return subprocess.run([td + '/test'], check=True, capture_output=True, text=True,
                              env={'ASAN_OPTIONS': 'detect_leaks=0'}).stdout


def digests(dump):
    groups, name = {}, None
    for l in dump.splitlines():
        if l.startswith('#'):
            name = l[1:]
            groups[name] = []
        else:
            groups[name].append(l)
    return {k: (hashlib.sha256('\n'.join(v).encode()).hexdigest()[:16], len(v)) for k, v in groups.items()}


dump = run_harness()
if '--dump' in sys.argv:
    print(dump, end='')
    sys.exit(0)
golden_path = Path(__file__).with_name('golden.txt')
now = digests(dump)
if '--update' in sys.argv:
    golden_path.write_text(''.join(f'{k} {h} {n}\n' for k, (h, n) in now.items()))
    print(f'wrote {golden_path.name}: {len(now)} groups')
    sys.exit(0)
golden = {l.split()[0] + ' ' + l.split()[1]: (l.split()[2], int(l.split()[3])) for l in golden_path.read_text().splitlines()}
bad = [k for k in sorted(set(golden) | set(now)) if golden.get(k) != now.get(k)]
if bad:
    sys.exit('button mapping output changed in: ' + ', '.join(bad) +
             '\n(--dump on both versions of the code and diff them; --update only if the change is intended)')
print(f'Button mapping characterization: {len(now)} groups, every builder matches the recorded output')
