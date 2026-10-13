from pathlib import Path
import subprocess, tempfile
root = Path(__file__).resolve().parents[2]
ps5 = (root/'OpenPuck/mode_ps5.cpp').read_text()

# the shipped effect parser and status reporter, checked against a trace from a real DualSense
code = ps5[ps5.index('struct TrigFx {'):ps5.index('static uint16_t ps5GetCommon(')]

src = '''#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#define NSLOT 4
#define HSIDE_LPAD 0
#define HSIDE_RPAD 1
#define HSIDE_LGRIP 3
#define HSIDE_RGRIP 4
#define TRIG_HAPTICS_PADS 1
#define TRIG_HAPTICS_GRIPS 2
uint8_t g_trigHaptics = TRIG_HAPTICS_PADS;
unsigned long g_now;
unsigned long millis() { return g_now; }
bool hapticLinkUp(int) { return true; }
bool haptic82Blocked(int) { return false; }
// what reached the relay: report id, side byte, script / gain
struct Sent { uint8_t rid, side, b1, b2; } sent[64];
int nsent;
bool relayEnqueueFront(uint8_t rid, const uint8_t *p, uint8_t, bool, int)
{
	sent[nsent++] = { rid, p[0], p[1], p[2] };
	return true;
}
''' + code + r'''
// one input report at trigger value v: the status byte and the feel it plays
static uint8_t feel(TrigFx *t, uint8_t trig, uint8_t v)
{
	uint8_t r = trigReport(t, v);
	g_now += 20;
	trigFeel(0, trig, t, r, v);
	return r;
}
static int count(uint8_t rid, uint8_t script)
{
	int n = 0;
	for (int i = 0; i < nsent; i++)
		n += sent[i].rid == rid && sent[i].b1 == script;
	return n;
}
static uint8_t at(TrigFx *t, uint8_t v) { return trigReport(t, v); }
int main()
{
	TrigFx t = {};
	// no effect ever set: what a real pad reports idle
	assert(at(&t, 0) == 0x09 && at(&t, 255) == 0x09);

	// official Weapon, start zone 4, end zone 7, strength 8 (real trace: 0x25 90 00 07)
	const uint8_t weapon[11] = { 0x25, 0x90, 0x00, 0x07 };
	trigSet(&t, weapon);
	assert(t.kind == 2);
	assert(at(&t, 0) == 0x04);
	assert(at(&t, 118) >> 4 == 0);
	assert(at(&t, 121) == 0x14);
	assert(at(&t, 209) >> 4 == 1);
	assert(at(&t, 229) >> 4 == 2);
	assert(at(&t, 255) == 0x29);
	// status 2 holds on the way back out until the trigger leaves the zone
	assert(at(&t, 129) >> 4 == 2);
	assert(at(&t, 112) >> 4 == 0);
	assert(at(&t, 0) == 0x04);
	// a full pull fires even with the end in zone 8
	const uint8_t weapon8[11] = { 0x25, 0x04, 0x01, 0x07 };
	trigSet(&t, weapon8);
	assert(at(&t, 200) >> 4 == 1 && at(&t, 255) >> 4 == 2);

	// official Feedback over zones 3-9 (real trace: rests in zone 3, status 1 under load)
	const uint8_t feedback[11] = { 0x21, 0xF8, 0x03, 0x40, 0x92, 0x24, 0x09 };
	trigSet(&t, feedback);
	assert(t.kind == 1);
	assert(at(&t, 0) == 0x03);
	assert(at(&t, 200) >> 4 == 1);
	assert(at(&t, 255) == 0x19);

	// Vibration reports effect 3; Off (0x05) goes back to idle
	const uint8_t vib[11] = { 0x26, 0xFF, 0x03, 0x6D, 0xDB, 0xB6, 0x2D, 0, 0, 0x1E };
	trigSet(&t, vib);
	assert(t.kind == 3 && at(&t, 0) == 0x00);
	const uint8_t off[11] = { 0x05 };
	trigSet(&t, off);
	assert(t.kind == 0 && at(&t, 255) == 0x09);

	// Simple_Weapon uses raw positions
	const uint8_t simple[11] = { 0x02, 0x60, 0xB0, 0xFF };
	trigSet(&t, simple);
	assert(at(&t, 0x50) >> 4 == 0 && at(&t, 0x70) >> 4 == 1 && at(&t, 0xC0) >> 4 == 2);

	// Feel: a weapon pull on R2 ticks every 12 counts on the right trackpad, then snaps once; a game re-sending
	// the same effect every frame neither replays it nor drops the latched snap
	TrigFx w = {};
	trigSet(&w, weapon);
	nsent = 0;
	for (int v = 0; v <= 255; v += 5) {
		feel(&w, 0, (uint8_t)v);
		trigSet(&w, weapon);
	}
	// zone 119..227 in steps of 5: the entry tick at 120, then 135, 150, ... 225
	assert(count(0x82, 0x02) == 1 && count(0x82, 0x01) == 8);
	// the pads' snap at force 8: click +6 dB, tone burst at full gain (sent as -1 dB, never 0)
	assert(count(0x83, (uint8_t)-1) == 1);
	for (int i = 0; i < nsent; i++)
		assert(sent[i].rid != 0x82 || sent[i].b1 != 0x02 || sent[i].b2 == 6);
	// ticks stay above the trackpad ticks' -9 dB; no gain byte is ever 0, the legacy haptic stop
	for (int i = 0; i < nsent; i++)
		assert(sent[i].rid != 0x82 || (sent[i].b2 && (int8_t)sent[i].b2 > -9));
	for (int f = 1; f <= 8; f++)
		assert(trigGain(TRIG_TICK_DB(f)) && trigGain(TRIG_SNAP_DB(f)) && (int8_t)trigGain(TRIG_TICK_DB(f)) > -9);
	for (int i = 0; i < nsent; i++)
		assert(sent[i].side == HSIDE_RPAD);
	int before = nsent;
	for (int v = 255; v >= 0; v -= 5)
		feel(&w, 0, (uint8_t)v);
	assert(nsent == before);
	// held under load: silent
	feel(&w, 0, 180);
	before = nsent;
	for (int i = 0; i < 50; i++)
		feel(&w, 0, 180);
	assert(nsent == before);

	// L2 feedback on both actuator sets: every tick goes to the left trackpad and the left grip
	g_trigHaptics = TRIG_HAPTICS_PADS | TRIG_HAPTICS_GRIPS;
	TrigFx f = {};
	trigSet(&f, feedback);
	nsent = 0;
	for (int v = 0; v <= 255; v += 5)
		feel(&f, 1, (uint8_t)v);
	assert(nsent > 0 && nsent % 2 == 0 && count(0x82, 0x02) == 0);
	for (int i = 0; i < nsent; i++)
		assert(sent[i].side == (i % 2 ? HSIDE_LGRIP : HSIDE_LPAD));
	// a weapon on both sets: the grips' snap stays at the shared level, the pads' is louder
	TrigFx w2 = {};
	trigSet(&w2, weapon);
	nsent = 0;
	for (int v = 0; v <= 255; v += 5)
		feel(&w2, 0, (uint8_t)v);
	int padSnap = 0, gripSnap = 0;
	for (int i = 0; i < nsent; i++) {
		if (sent[i].rid == 0x82 && sent[i].b1 == 0x02)
			(sent[i].side == HSIDE_RPAD ? padSnap : gripSnap) = (int8_t)sent[i].b2;
		if (sent[i].rid == 0x83)
			assert((int8_t)sent[i].b1 == (sent[i].side == HSIDE_RPAD ? -1 : -6));
	}
	assert(padSnap == 6 && gripSnap == 2);

	// vibration: a tone while pressed in its zone, cut on release; off plays nothing
	g_trigHaptics = TRIG_HAPTICS_PADS;
	TrigFx vb = {};
	trigSet(&vb, vib);
	nsent = 0;
	g_now = 1000;
	feel(&vb, 0, 0);
	assert(nsent == 0);
	feel(&vb, 0, 100);
	assert(nsent == 1 && sent[0].rid == 0x83 && sent[0].side == HSIDE_RPAD);
	feel(&vb, 0, 0);
	assert(nsent == 2 && sent[1].rid == 0x83 && (int8_t)sent[1].b1 == -128);
	g_trigHaptics = 0;
	nsent = 0;
	feel(&vb, 0, 100);
	trigSet(&w, weapon);
	for (int v = 0; v <= 255; v += 5)
		feel(&w, 0, (uint8_t)v);
	assert(nsent == 0);
	puts("trigger_fx ok");
}
'''
with tempfile.TemporaryDirectory() as d:
    c = Path(d)/'t.cpp'
    c.write_text(src)
    subprocess.run(['g++', '-std=c++17', '-Wall', '-Werror', '-Wno-unused-variable', '-o', str(Path(d)/'t'), str(c)], check=True)
    subprocess.run([str(Path(d)/'t')], check=True)
