from pathlib import Path
import subprocess,tempfile
root=Path(__file__).resolve().parents[2];s=(root/'OpenPuck/webusb_config.cpp').read_text()
a=s.index('\t\t\t\tcase 231:');b=s.index('// Switch Pro gyro mapping',a)
head='''#include <stdint.h>
#include <cassert>
#include "triton.h"
struct {uint8_t enabled=0,chord[7]={};}g_swProfiles;
uint8_t g_shortcutFlags=61,g_rumblePresets[3]={5,0,8},g_rumbleSlot=2,g_swQamSelect=18,g_strengthSlots[2]={255,255},g_rumbleStyle=8;
uint16_t g_strengthSteps[2][3]={{200,300,500},{200,300,500}},g_hdPadScale=300,g_rumbleScale=200;
int applied=0;void applyActiveType(){++applied;}
void field(uint8_t f,uint8_t v){switch(f){
'''
body='''}}int main(){
 field(240,63);assert(g_swProfiles.enabled && applied==1);for(int i=0;i<7;i++)assert(g_swProfiles.chord[i]==i+1);
 g_swProfiles.chord[0]=0;field(240,55);assert(g_swProfiles.chord[0]==0);field(240,53);assert(!g_swProfiles.enabled);field(240,55);assert(g_swProfiles.chord[0]==0);
 field(241,6);assert(g_rumblePresets[0]==6);field(241,7);assert(g_rumblePresets[0]==6);field(241,255);assert(g_rumblePresets[0]==6);
 field(242,8);field(39,8);field(250,1);assert(g_rumbleSlot==1);field(242,0);assert(g_rumbleSlot==255);
 field(244,0);field(246,250);assert(g_strengthSteps[0][0]==0 && g_strengthSteps[0][2]==500);field(247,0);assert(g_strengthSteps[1][0]==200);field(247,5);assert(g_strengthSteps[1][0]==10);
 field(245,150);field(251,1);assert(g_strengthSlots[0]==1);field(245,100);assert(g_strengthSlots[0]==255);field(251,1);assert(g_strengthSlots[0]==255);
 field(239,0);assert(g_swQamSelect==0);field(239,18);field(239,21);assert(g_swQamSelect==18);
 for(int i=232;i<=238;i++){field(i,0);}field(39,7);assert(g_rumbleStyle==8);
}'''
with tempfile.TemporaryDirectory() as td:
 p=Path(td)/'test.cpp';p.write_text(head+s[a:b]+body)
 subprocess.run(['g++','-std=c++11','-Wall','-Wextra','-Werror','-fsanitize=address,undefined','-I'+str(root/'OpenPuck'),str(p),'-o',td+'/test'],check=True)
 subprocess.run([td+'/test'],check=True,env={'ASAN_OPTIONS':'detect_leaks=0'})
print('Production final WebUSB field validation and preset tests passed')
