from pathlib import Path
import subprocess, tempfile
root=Path(__file__).resolve().parents[2]
s=(root/'OpenPuck/config.cpp').read_text()
a=s.index('void captureFeedbackChord(');b=s.index('\nvoid applyActiveType()',a)
hh=(root/'OpenPuck/haptics.h').read_text();hside=hh[hh.index('#define HSIDE_LPAD'):hh.index('// PCM haptic stream')]
head='''#include <stdint.h>
#include <cassert>
#include <initializer_list>
#include "triton.h"
#define NSLOT 4
#define MODE_SW_PRO 4
uint8_t g_usbMode=MODE_SW_PRO,g_shortcutFlags=63;
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
uint8_t g_etype=1;uint16_t g_typeRumbleScale[ET_COUNT]={};
uint8_t etypeForMode(uint8_t m){return m==MODE_SW_PRO?1:ET_NONE;}
'''
head += '#include <cstring>\n#define PS_DPAD_TOUCH 3\n#define PS_DPAD_CLICK 4\nuint8_t g_padStick[2]={};\n'
u=(root/'OpenPuck/gamepad_util.cpp').read_text()
ua=u.index('uint32_t padDpadButtons(');ub=u.index('\nvoid slotSticks(',ua)

m=(root/'OpenPuck/mode_switch_pro.cpp').read_text()
ha=m.index('static void swDpadClickFeedback(');hb=m.index('\nvoid SwitchProController::task()',ha)
head += '''uint8_t g_swDpadHaptics=1,g_padHaptics=1,g_swQamSelect=18;
bool blocked=false;
int pulses=0;
uint8_t emittedSide=0, emittedBond=0;
bool haptic82Blocked(int){return blocked;}
bool relayEnqueueFront(uint8_t rid,const uint8_t *p,uint8_t n,bool haptic,uint8_t slot){
 assert(rid==0x82 && n==3 && haptic && p[1]==2 && p[2]==0xF7);
 ++pulses;emittedSide=p[0];emittedBond=slot;return true;
}
'''
ta=s.index('\tif (c.hdPadScale2 <= 250)');tb=s.index('\t// resolve the active emulated type',ta)
head += 'struct Tail {uint8_t hdPadScale2,reservedRumbleStyles[2],reservedWaveform,reservedWavePresets[2],reservedWaveThird,reservedWaveSlot,swQamSelect,shortcutFlags,reservedShortcutRumble[12],reservedTypeRumbleStyle[4],typeRumbleScale2[4];};\nvoid loadTail(Tail c){\n'+s[ta:tb]+'}\n'
body='''int main(){
 Tail old;memset(&old,255,sizeof old);loadTail(old);assert(g_shortcutFlags==SHORTCUT_ENABLED); // fork default: back-4 modifier
 // a file without per-type strength seeds every type from the legacy global strength
 for(int et=0;et<ET_COUNT;et++)assert(g_typeRumbleScale[et]==200);
 Tail typed=old;typed.typeRumbleScale2[0]=50;typed.typeRumbleScale2[1]=75;typed.typeRumbleScale2[2]=1;
 g_rumbleScale=200;loadTail(typed);
 assert(g_typeRumbleScale[0]==100 && g_typeRumbleScale[1]==150 && g_typeRumbleScale[2]==200); // invalid -> global
 // bits 1/2 (ex profiles / D-pad haptic shortcuts) are dropped from saved flags
 Tail savedTail=old;savedTail.hdPadScale2=150;savedTail.shortcutFlags=62;
 loadTail(savedTail);assert(g_hdPadScale==300 && g_shortcutFlags==56);
 assert(!shortcutHeld(TB_QAM|TB_A));assert(shortcutHeld(CHORD_BACK4|TB_A));assert(shortcutHostButtons(CHORD_BACK4|TB_A)==0);
 g_shortcutFlags=63;assert(shortcutHostButtons(TB_QAM|TB_A|TB_L4)==TB_L4);
 g_shortcutFlags=0;assert(shortcutHostButtons(TB_QAM|TB_A)==(TB_QAM|TB_A));
 g_shortcutFlags=57;g_usbMode=MODE_SW_PRO;
 int prior=confirmations;captureFeedbackChord(0,0);captureFeedbackChord(0,TB_QAM|TB_MENU);assert(confirmations==1);confirmations=4;captureFeedbackChord(0,TB_QAM|TB_MENU);assert(confirmations==4);captureFeedbackChord(0,0);captureFeedbackChord(0,TB_QAM|TB_MENU);assert(confirmations==1);(void)prior;
 uint32_t buttons=TB_QAM|TB_MENU;assert(switchSelectShortcut(0,buttons) && !(buttons&TB_MENU));buttons=TB_MENU;assert(!switchSelectShortcut(0,buttons) && !buttons);buttons=0;switchSelectShortcut(0,buttons);buttons=TB_MENU;assert(!switchSelectShortcut(0,buttons) && buttons==TB_MENU);
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
 g_padStick[0]=3;g_padStick[1]=4;
 swDpadClickFeedback(3,TB_LPADT|TB_LPADC);assert(pulses==1 && emittedSide==HSIDE_LPAD && emittedBond==3);
 swDpadClickFeedback(3,TB_LPADT|TB_LPADC);assert(pulses==1);
 swDpadClickFeedback(3,0);swDpadClickFeedback(3,TB_RPADT|TB_RPADC);assert(pulses==2 && emittedSide==HSIDE_RPAD);
 swDpadClickFeedback(3,0);swDpadClickFeedback(3,TB_LPADT|TB_LPADC|TB_RPADT|TB_RPADC);assert(pulses==3 && emittedSide==HSIDE_PADS);
 swDpadClickFeedback(3,0);g_swDpadHaptics=0;swDpadClickFeedback(3,TB_LPADT|TB_LPADC);assert(pulses==3);
 g_swDpadHaptics=1;swDpadClickFeedback(3,TB_LPADT|TB_LPADC);assert(pulses==3);
 swDpadClickFeedback(3,0);blocked=true;swDpadClickFeedback(3,TB_LPADT|TB_LPADC);assert(pulses==3);
 blocked=false;swDpadClickFeedback(3,0);swDpadClickFeedback(3,TB_LPADT|TB_LPADC);assert(pulses==4);
 swDpadClickFeedback(3,0);swDpadClickFeedback(3,TB_LPADT|TB_LPADC|TB_QAM);assert(pulses==4);
 swDpadClickFeedback(3,0);g_padHaptics=0;swDpadClickFeedback(3,TB_LPADT|TB_LPADC);assert(pulses==5);
 g_padHaptics=1;swDpadClickFeedback(3,0);g_padStick[0]=1;swDpadClickFeedback(3,TB_LPADT|TB_LPADC);assert(pulses==5);
}'''
with tempfile.TemporaryDirectory() as td:
 p=Path(td)/'test.cpp';p.write_text(head+hside+s[a:b]+u[ua:ub]+m[ha:hb]+body)
 subprocess.run(['g++','-std=c++11','-Wall','-Wextra','-Werror','-fsanitize=address,undefined','-I'+str(root/'OpenPuck'),str(p),'-o',td+'/test'],check=True)
 subprocess.run([td+'/test'],check=True,env={'ASAN_OPTIONS':'detect_leaks=0'})
print('Shortcut flags, Switch Pro capture, trackpad D-pad and click feedback tests passed')
