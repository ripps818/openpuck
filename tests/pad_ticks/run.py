from pathlib import Path
import subprocess, tempfile
root = Path(__file__).resolve().parents[2]
g = (root/'OpenPuck/gamepad_util.cpp').read_text()
h = (root/'OpenPuck/haptics.h').read_text()
c = (root/'OpenPuck/config.h').read_text()

# the shipped tick generator and the gain / spacing helpers it uses, against stand-ins for the radio and the clock
ticker = g[g.index('// Shortest gap between two ticks'):g.index('void psNeutralCalib(')]
hsides = h[h.index('#define HSIDE_LPAD'):h.index('// PCM haptic stream')]
helpers = c[c.index('// gain in dB of click step'):c.index('// What the puck takes over')]

src = '''#include <cassert>
#include <cstdint>
#include <cstdlib>
#include <vector>
#define NSLOT 4
#define PAD_CLICK_MIN 0
#define PAD_TICK_MAX 4
#define TB_LPADT 0x2000000u
#define TB_RPADT 0x200000u
#define TB_LPADC 0x4000000u
#define TB_RPADC 0x400000u
struct PuckInput { uint32_t buttons; int16_t lpx, lpy, rpx, rpy; };
PuckInput g_in[NSLOT];
uint8_t g_padClick = 11, g_padTick = 0, g_padTickGain = 11;
unsigned long g_now = 1000;
bool g_linkUp = true, g_blocked = false;
unsigned long millis() { return g_now; }
bool hapticLinkUp(uint8_t) { return g_linkUp; }
bool haptic82Blocked(uint8_t) { return g_blocked; }
uint32_t shortcutHostButtons(uint32_t b) { return b; }
struct Pulse { uint8_t side, cmd, gain; uint8_t slot; };
std::vector<Pulse> g_pulses;
bool relayEnqueueFront(uint8_t op, const uint8_t *d, uint8_t n, bool, uint8_t slot)
{
	assert(op == 0x82 && n == 3);
	g_pulses.push_back({ d[0], d[1], d[2], slot });
	return true;
}
''' + hsides + helpers + ticker + '''
static void frame(int slot, uint32_t b, int lx, int ly, int rx, int ry)
{
	g_in[slot].buttons = b; g_in[slot].lpx = lx; g_in[slot].lpy = ly; g_in[slot].rpx = rx; g_in[slot].rpy = ry;
	g_now += 4;
	padTickMove(slot);
}
int main()
{
	// off (level 0): nothing, however far a finger moves
	frame(0, TB_RPADT, 0, 0, 0, 0); frame(0, TB_RPADT, 0, 0, 20000, 0);
	assert(g_pulses.empty());

	// Normal (5500): a swipe along x of 12000 units makes two ticks, on the right pad only, at the tick gain
	g_padTick = 2;
	frame(0, 0, 0, 0, 0, 0);
	frame(0, TB_RPADT, 0, 0, 0, 0);
	for (int x = 1000; x <= 12000; x += 1000) frame(0, TB_RPADT, 0, 0, x, 0);
	assert(g_pulses.size() == 2);
	for (const Pulse &p : g_pulses) assert(p.side == HSIDE_RPAD && p.cmd == 1 && p.gain == 0xF7 && p.slot == 0);

	// the tick strength is its own setting, not the click's
	g_pulses.clear(); g_padClick = 31; g_padTickGain = 31;
	frame(0, 0, 0, 0, 0, 0);
	frame(0, TB_LPADT, 0, 0, 0, 0); frame(0, TB_LPADT, 6000, 0, 0, 0);
	assert(g_pulses.size() == 1 && g_pulses[0].side == HSIDE_LPAD && (int8_t)g_pulses[0].gain == 12);
	g_padClick = 11; g_padTickGain = 11;

	// lifting the finger forgets the position: touching down elsewhere is not travel
	g_pulses.clear();
	frame(0, 0, 0, 0, 0, 0);
	frame(0, TB_RPADT, 0, 0, -20000, 0); frame(0, 0, 0, 0, -20000, 0);
	frame(0, TB_RPADT, 0, 0, 20000, 0);
	assert(g_pulses.empty());

	// a gap in the calls reads as a new touch, not one long swipe
	frame(0, TB_RPADT, 0, 0, 20000, 0); g_now += 500;
	frame(0, TB_RPADT, 0, 0, -20000, 0);
	assert(g_pulses.empty());

	// the narrowest spacing is held to one tick per 12 ms per pad however fast the finger goes
	g_padTick = 4; g_pulses.clear();
	frame(0, 0, 0, 0, 0, 0);
	frame(0, TB_RPADT, 0, 0, 0, 0);
	for (int i = 1; i <= 10; i++) frame(0, TB_RPADT, 0, 0, i * 4000, 0);
	assert(g_pulses.size() >= 3 && g_pulses.size() <= 4); // 40 ms of movement, ticks at least 12 ms apart

	// both pads at once tick separately; a diagonal counts as its true length (about)
	g_padTick = 2; g_pulses.clear(); g_now += 500;
	frame(0, 0, 0, 0, 0, 0);
	frame(0, TB_LPADT | TB_RPADT, 0, 0, 0, 0);
	frame(0, TB_LPADT | TB_RPADT, 4000, 4000, 0, 0);
	assert(g_pulses.size() == 1 && g_pulses[0].side == HSIDE_LPAD); // 4000 + 2000 = 6000 >= 5500, the right pad did not move

	// a pad click holds the ticks back while it is down and for 150 ms after it presses and after it lets go
	g_padTick = 4; g_pulses.clear(); g_now += 500;
	frame(0, 0, 0, 0, 0, 0);
	frame(0, TB_RPADT, 0, 0, 0, 0);
	frame(0, TB_RPADT | TB_RPADC, 0, 0, 3000, 0);   // press: the finger slides
	for (int i = 0; i < 5; i++) frame(0, TB_RPADT | TB_RPADC, 0, 0, 3000 + 3000 * (i + 1), 0);
	assert(g_pulses.empty());
	frame(0, TB_RPADT, 0, 0, 20000, 0);              // let go: still quiet
	frame(0, TB_RPADT, 0, 0, 24000, 0);
	assert(g_pulses.empty());
	g_now += 160;
	frame(0, TB_RPADT, 0, 0, 28000, 0); frame(0, TB_RPADT, 0, 0, 32000, 0);
	assert(g_pulses.size() >= 1);                    // ticking again
	g_padTick = 2;

	// no link, or a blocked haptic channel: no pulses
	g_pulses.clear(); g_linkUp = false;
	frame(0, TB_RPADT, 0, 0, 0, 0); frame(0, TB_RPADT, 0, 0, 20000, 0);
	g_linkUp = true; g_blocked = true; g_now += 500;
	frame(0, TB_RPADT, 0, 0, 0, 0); frame(0, TB_RPADT, 0, 0, 20000, 0);
	assert(g_pulses.empty());
	return 0;
}
'''
with tempfile.TemporaryDirectory() as td:
    p = Path(td)/'test.cpp'
    p.write_text(src)
    subprocess.run(['g++', '-std=c++11', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', str(p), '-o', td + '/test'], check=True)
    subprocess.run([td + '/test'], check=True)
print('Pad movement ticks: spacing, strength, lift-off, gaps, rate cap and link tests passed')
