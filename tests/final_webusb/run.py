from pathlib import Path
import subprocess,tempfile
root=Path(__file__).resolve().parents[2];s=(root/'OpenPuck/webusb_config.cpp').read_text()
a=s.index('\t\t\t\tcase 231:');b=s.index('// Switch Pro gyro mapping',a)
head='''#include <stdint.h>
#include <cassert>
#include "triton.h"
uint8_t g_shortcutFlags=61,g_rumblePresets[3]={5,0,8},g_rumbleSlot=2,g_swQamSelect=18,g_strengthSlots[2]={255,255},g_rumbleStyle=8;
uint16_t g_strengthSteps[2][3]={{200,300,500},{200,300,500}},g_hdPadScale=300,g_rumbleScale=200;
int applied=0,stored=0;void applyActiveType(){++applied;}void rumbleStoreActive(){++stored;}
void field(uint8_t f,uint8_t v){switch(f){
'''
body='''}}int main(){
 // bits 1/2 (the removed profiles / D-pad haptic shortcut behaviors) are dropped; out-of-range flags are refused
 field(240,63);assert(g_shortcutFlags==57);field(240,49);assert(g_shortcutFlags==49);field(240,64);assert(g_shortcutFlags==49);(void)applied;
 // removed settings are ignored: rumble style (39 / 104..107), shortcut presets / steps / slots (241..252)
 stored=0;field(39,5);field(104,5);assert(g_rumbleStyle==8 && stored==0);
 for(int f=241;f<=252;f++){field(f,1);}assert(g_rumblePresets[0]==5 && g_strengthSteps[0][0]==200 && g_rumbleSlot==2);
 field(239,0);assert(g_swQamSelect==0);field(239,18);field(239,21);assert(g_swQamSelect==18);
 for(int i=232;i<=238;i++){field(i,0);}
}'''
with tempfile.TemporaryDirectory() as td:
 p=Path(td)/'test.cpp';p.write_text(head+s[a:b]+body)
 subprocess.run(['g++','-std=c++11','-Wall','-Wextra','-Werror','-fsanitize=address,undefined','-I'+str(root/'OpenPuck'),str(p),'-o',td+'/test'],check=True)
 subprocess.run([td+'/test'],check=True,env={'ASAN_OPTIONS':'detect_leaks=0'})
print('Production final WebUSB field validation and preset tests passed')
