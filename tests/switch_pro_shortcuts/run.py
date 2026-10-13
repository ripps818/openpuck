from pathlib import Path
import subprocess, tempfile
root=Path(__file__).resolve().parents[2]
s=(root/'OpenPuck/config.cpp').read_text()
a=s.index('void captureFeedbackChord(');b=s.index('\nvoid applyActiveType()',a)
hh=(root/'OpenPuck/haptics.h').read_text();hside=hh[hh.index('#define HSIDE_LPAD'):hh.index('// PCM haptic stream')]
ch=(root/'OpenPuck/config.h').read_text();clickgain=ch[ch.index('// gain in dB of click step'):ch.index('// the s8 gain_db byte of a 0x82 movement tick')]
head='''#include <stdint.h>
#include <cassert>
#include <initializer_list>
#include "triton.h"
#define NSLOT 4
#define MODE_SW_PRO 4
uint8_t g_padClick=26;
uint8_t g_usbMode=MODE_SW_PRO,g_shortcutFlags=63;
uint32_t g_gestureMask=0;
uint8_t g_rumbleStyle=8;
uint16_t g_hdPadScale=100,g_rumbleScale=200;
int confirmations=0;uint8_t confirmationSlot=0;
void hapticShortcutFeedback(uint8_t slot,uint8_t count){confirmations=count;confirmationSlot=slot;}
#define RUMBLE_STYLE_MAX 8
#define RUMBLE_STYLE_HD 8
int applied=0;
void applyActiveType(){++applied;}
#define ET_COUNT 4
#define ET_NONE 0xFF
#define RUMBLE_SCALE_MIN 10u
#define RUMBLE_SCALE_MAX 500u
#define RUMBLE_SCALE_PCT 200u
const uint16_t g_typeRumbleScaleDefault[ET_COUNT]={200,100,200,200};
uint8_t g_etype=1;uint16_t g_typeRumbleScale[ET_COUNT]={};
uint8_t etypeForMode(uint8_t m){return m==MODE_SW_PRO?1:ET_NONE;}
'''
head += '#include <cstring>\n#define PS_DPAD_TOUCH 3\n#define PS_DPAD_CLICK 4\nuint8_t g_padStick[2]={};\n'
u=(root/'OpenPuck/gamepad_util.cpp').read_text()
ua=u.index('static bool padIsDpad(');ub=u.index('\nvoid slotSticks(',ua)

head += '''uint8_t g_dpadClick=1,g_padHaptics=1,g_qamSelect=18,g_typeQamSelect[4]={0,0,0,0};\n#define QAM_SELECT_MAX 20\n#define ET_SWITCH 1\n#define PAD_HAPTICS_OFF 0\nPuckInput g_in[NSLOT];\nuint32_t padDpadBits(uint32_t,int16_t,int16_t,int16_t,int16_t);\nstatic inline uint32_t padDpadButtons(const PuckInput &in){return padDpadBits(in.buttons,in.lpx,in.lpy,in.rpx,in.rpy);}\n
bool blocked=false;
int pulses=0;
uint8_t emittedSide=0, emittedBond=0;
bool haptic82Blocked(int){return blocked;}
bool relayEnqueueFront(uint8_t rid,const uint8_t *p,uint8_t n,bool haptic,uint8_t slot){
 assert(rid==0x82 && n==3 && haptic && p[1]==2 && p[2]==0x07);
 ++pulses;emittedSide=p[0];emittedBond=slot;return true;
}
'''
ta=s.index('\tif (c.hdPadScale2 <= 250)');tb=s.index('\t// resolve the active emulated type',ta)
head += 'struct Tail {uint8_t hdPadScale2,reservedRumbleStyles[2],reservedWaveform,reservedWavePresets[2],reservedWaveThird,reservedWaveSlot,swQamSelect,shortcutFlags,reservedShortcutRumble[12],reservedTypeRumbleStyle[4],typeRumbleScale2[4],typeQamSelect[4];};\nvoid loadTail(Tail c){\n'+s[ta:tb]+'}\n'
body='''int main(){
 Tail old;memset(&old,255,sizeof old);loadTail(old);assert(g_shortcutFlags==SHORTCUT_ENABLED); // fork default: back-4 modifier
 // a file without per-type strength gives each type its own default: the Switch starts at 100%
 assert(g_typeRumbleScale[0]==200 && g_typeRumbleScale[1]==100 && g_typeRumbleScale[2]==200 && g_typeRumbleScale[3]==200);
 // ...unless the legacy global strength was changed, which seeds every type
 g_rumbleScale=300;loadTail(old);for(int et=0;et<ET_COUNT;et++)assert(g_typeRumbleScale[et]==300);
 g_rumbleScale=200;
 Tail typed=old;typed.typeRumbleScale2[0]=50;typed.typeRumbleScale2[1]=75;typed.typeRumbleScale2[2]=1;
 g_rumbleScale=200;loadTail(typed);
 assert(g_typeRumbleScale[0]==100 && g_typeRumbleScale[1]==150 && g_typeRumbleScale[2]==200 && g_typeRumbleScale[3]==200); // invalid -> default
 // Quick Access + Select target per type: the Switch keeps its old byte (or the screenshot default), others none
 // no target for anyone by default; a file from when the Switch-only shortcut was on keeps its target
 assert(g_typeQamSelect[0]==0 && g_typeQamSelect[1]==0 && g_typeQamSelect[2]==0 && g_typeQamSelect[3]==0);
 {Tail q=old;q.swQamSelect=7;loadTail(q);assert(g_typeQamSelect[1]==0);                                  // its switch was off
  q.shortcutFlags=57;loadTail(q);assert(g_typeQamSelect[1]==7 && g_typeQamSelect[3]==0);               // on: the Switch keeps 7
  q.swQamSelect=255;g_typeQamSelect[1]=0;loadTail(q);assert(g_typeQamSelect[1]==18);                   // on, no target saved: screenshot
  q.typeQamSelect[3]=9;q.typeQamSelect[1]=4;q.typeQamSelect[2]=21;loadTail(q);assert(g_typeQamSelect[3]==9 && g_typeQamSelect[1]==4 && g_typeQamSelect[2]==0);
  g_typeQamSelect[1]=0;g_typeQamSelect[3]=0;}
 // bits 1/2 (ex profiles / D-pad haptic shortcuts) are dropped from saved flags
 Tail savedTail=old;savedTail.hdPadScale2=150;savedTail.shortcutFlags=62;
 loadTail(savedTail);assert(g_hdPadScale==300 && g_shortcutFlags==56);
 assert(!shortcutHeld(TB_QAM|TB_A));assert(shortcutHeld(CHORD_BACK4|TB_A));assert(shortcutHostButtons(CHORD_BACK4|TB_A)==0);
 g_shortcutFlags=63;assert(shortcutHostButtons(TB_QAM|TB_A|TB_L4)==TB_L4);
 g_shortcutFlags=0;assert(shortcutHostButtons(TB_QAM|TB_A)==(TB_QAM|TB_A));
 g_shortcutFlags=57;g_usbMode=MODE_SW_PRO;
 int prior=confirmations;captureFeedbackChord(0,0);captureFeedbackChord(0,TB_QAM|TB_MENU);assert(confirmations==1);confirmations=4;captureFeedbackChord(0,TB_QAM|TB_MENU);assert(confirmations==4);captureFeedbackChord(0,0);captureFeedbackChord(0,TB_QAM|TB_MENU);assert(confirmations==1);(void)prior;
 // the chord works in every mode that has a target, and does nothing without one
 g_shortcutFlags=0;g_usbMode=0;g_qamSelect=10;captureFeedbackChord(0,0);confirmations=0;captureFeedbackChord(0,TB_QAM|TB_MENU);assert(confirmations==1);
 g_qamSelect=0;captureFeedbackChord(0,0);confirmations=0;captureFeedbackChord(0,TB_QAM|TB_MENU);assert(confirmations==0);
 {uint32_t held=TB_QAM|TB_MENU;assert(!qamSelectShortcut(0,held) && held==(TB_QAM|TB_MENU));}
 g_qamSelect=18;g_usbMode=MODE_SW_PRO;g_shortcutFlags=57;
 uint32_t buttons=TB_QAM|TB_MENU;assert(qamSelectShortcut(0,buttons) && !(buttons&TB_MENU));buttons=TB_MENU;assert(!qamSelectShortcut(0,buttons) && !buttons);buttons=0;qamSelectShortcut(0,buttons);buttons=TB_MENU;assert(!qamSelectShortcut(0,buttons) && buttons==TB_MENU);
 PuckInput in={};g_padStick[0]=3;
 in.buttons=TB_LPADT;in.lpx=20000;assert(padDpadButtons(in)==TB_DRT);
 in.lpx=-20000;assert(padDpadButtons(in)==TB_DLF);
 in.lpx=0;in.lpy=20000;assert(padDpadButtons(in)==TB_DUP);
 in.lpy=-20000;assert(padDpadButtons(in)==TB_DDN);
 in.lpx=20000;in.lpy=20000;assert(padDpadButtons(in)==(TB_DUP|TB_DRT));
 in.lpx=1000;in.lpy=1000;assert(!padDpadButtons(in));
 in.lpx=20000;in.buttons=0;assert(!padDpadButtons(in));
 in.buttons=TB_LPADT;g_padStick[0]=4;assert(!padDpadButtons(in));
 in.buttons|=TB_LPADC;assert(padDpadButtons(in)==TB_DRT);
 in.buttons|=TB_QAM;assert(!padDpadButtons(in));
 g_padStick[0]=1;in.buttons=TB_LPADT;assert(!padDpadButtons(in));
 g_padStick[0]=0;g_padStick[1]=3;in.buttons=TB_RPADT;in.rpx=-20000;assert(padDpadButtons(in)==TB_DLF);
 in.rpx=-32768;in.rpy=-32768;assert(padDpadButtons(in)==(TB_DLF|TB_DDN));
 g_padStick[0]=3;in.buttons|=TB_LPADT;in.lpx=20000;in.lpy=0;in.rpy=0;assert(!padDpadButtons(in));
 // D-pad click feedback (every type now): a pulse per click on a D-pad pad, only with Trackpad haptics off
 auto fb=[](uint32_t b){g_in[3].buttons=b;padDpadClickFeedback(3);};
 g_padStick[0]=3;g_padStick[1]=4;g_padHaptics=0;
 fb(TB_LPADT|TB_LPADC);assert(pulses==1 && emittedSide==HSIDE_LPAD && emittedBond==3);
 fb(TB_LPADT|TB_LPADC);assert(pulses==1);
 fb(0);fb(TB_RPADT|TB_RPADC);assert(pulses==2 && emittedSide==HSIDE_RPAD);
 fb(0);fb(TB_LPADT|TB_LPADC|TB_RPADT|TB_RPADC);assert(pulses==3 && emittedSide==HSIDE_PADS);
 fb(0);g_dpadClick=0;fb(TB_LPADT|TB_LPADC);assert(pulses==3);
 // a disabled pad (5, past the D-pad modes) is neither a D-pad nor a click pulse
 g_dpadClick=1;g_padStick[0]=g_padStick[1]=5;in.buttons=TB_LPADT|TB_LPADC|TB_RPADT|TB_RPADC;in.lpx=20000;in.rpx=20000;assert(!padDpadButtons(in));
 fb(0);fb(TB_LPADT|TB_LPADC|TB_RPADT|TB_RPADC);assert(pulses==3);
 g_padStick[0]=3;g_padStick[1]=4;
 fb(0);blocked=true;fb(TB_LPADT|TB_LPADC);assert(pulses==3);
 blocked=false;fb(0);fb(TB_LPADT|TB_LPADC);assert(pulses==4);
 fb(0);fb(TB_LPADT|TB_LPADC|TB_QAM);assert(pulses==4);
 // Trackpad haptics on already pulses every click: no second pulse
 fb(0);g_padHaptics=1;fb(TB_LPADT|TB_LPADC);assert(pulses==4);
 g_padHaptics=0;fb(0);g_padStick[0]=1;fb(TB_LPADT|TB_LPADC);assert(pulses==4);
 // padDpadApply: D-pad bits added; D-pad-on-click spends its click, D-pad-on-touch and other pads keep theirs
 g_padStick[0]=4;g_padStick[1]=0;
 assert(padDpadApply(TB_LPADT|TB_LPADC|TB_RPADC,20000,0,0,0)==(TB_LPADT|TB_DRT|TB_RPADC));
 g_padStick[0]=3;
 assert(padDpadApply(TB_LPADT|TB_LPADC,20000,0,0,0)==(TB_LPADT|TB_LPADC|TB_DRT));
 g_padStick[0]=4;assert(padDpadApply(TB_LPADT,20000,0,0,0)==TB_LPADT);
 // a pulse each time the direction changes, without lifting the finger; none for staying put
 g_padStick[0]=3;g_padStick[1]=0;g_padHaptics=0;g_dpadClick=1;blocked=false;
 g_in[3]=PuckInput();fb(0);int base=pulses;
 g_in[3].lpx=20000;fb(TB_LPADT);assert(pulses==base+1 && emittedSide==HSIDE_LPAD);   // touching down into right
 g_in[3].lpx=21000;fb(TB_LPADT);assert(pulses==base+1);                              // same direction
 g_in[3].lpy=-20000;g_in[3].lpx=0;fb(TB_LPADT);assert(pulses==base+2);               // right -> down
 g_in[3].lpx=20000;fb(TB_LPADT);assert(pulses==base+3);                              // down -> down-right
 g_in[3].lpx=500;g_in[3].lpy=500;fb(TB_LPADT);assert(pulses==base+3);                // back to the centre: nothing
 g_in[3].lpx=-20000;g_in[3].lpy=0;fb(TB_LPADT);assert(pulses==base+4);               // centre -> left
 g_dpadClick=0;g_in[3].lpx=20000;fb(TB_LPADT);assert(pulses==base+4);                // setting off
 g_dpadClick=1;g_padHaptics=1;g_in[3].lpx=-20000;fb(TB_LPADT);assert(pulses==base+5);// still plays with Trackpad haptics on
 g_padStick[0]=1;g_in[3].lpx=20000;fb(TB_LPADT);assert(pulses==base+5);              // not a D-pad pad
 // D-pad on click: the click is the first pulse (Trackpad haptics off), a slide then pulses per direction
 g_padStick[0]=0;g_padStick[1]=4;g_padHaptics=0;g_in[3]=PuckInput();fb(0);base=pulses;
 g_in[3].rpx=20000;fb(TB_RPADT);assert(pulses==base);                                // touched, not clicked
 fb(TB_RPADT|TB_RPADC);assert(pulses==base+1 && emittedSide==HSIDE_RPAD);            // the click alone, once
 g_in[3].rpy=20000;fb(TB_RPADT|TB_RPADC);assert(pulses==base+2);                     // right -> up-right
 fb(TB_RPADT|TB_RPADC);assert(pulses==base+2);
 g_padHaptics=1;fb(0);g_in[3].rpy=0;fb(TB_RPADT|TB_RPADC);assert(pulses==base+2);    // Trackpad haptics on: the click is its own
 g_in[3].rpy=20000;fb(TB_RPADT|TB_RPADC);assert(pulses==base+3);
}'''
with tempfile.TemporaryDirectory() as td:
 p=Path(td)/'test.cpp';p.write_text(head+hside+clickgain+s[a:b]+u[ua:ub]+body)
 subprocess.run(['g++','-std=c++11','-Wall','-Wextra','-Werror','-fsanitize=address,undefined','-I'+str(root/'OpenPuck'),str(p),'-o',td+'/test'],check=True)
 subprocess.run([td+'/test'],check=True,env={'ASAN_OPTIONS':'detect_leaks=0'})
print('Shortcut flags, Switch Pro capture, trackpad D-pad and click feedback tests passed')
