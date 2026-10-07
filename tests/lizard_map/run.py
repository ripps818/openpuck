from pathlib import Path
import subprocess, tempfile
r=Path(__file__).resolve().parents[2]
storage=(r/'OpenPuck/storage.cpp').read_text().replace('0xED000','(uintptr_t)testFlash')
lizard=(r/'OpenPuck/lizard_map.cpp').read_text()
# the default map uses a handful of TinyUSB keycodes; the values only need to be distinct here
hid='#pragma once\n'+''.join(f'#define HID_KEY_{k} {0x40+i}\n' for i,k in enumerate(
 'ARROW_DOWN ARROW_LEFT ARROW_RIGHT ARROW_UP DELETE ENTER ESCAPE O PAGE_DOWN PAGE_UP TAB'.split()))
test='''
#include <cassert>
#include <algorithm>
bool mountOk=false,failWrite=false,failRead=false,failRename=false;
int formats=0;
std::map<std::string,std::vector<uint8_t>> files;
InternalFileSystem InternalFS;
uint32_t testFlash[7168];
static bool same(const LizardMap &a,const LizardMap &b){
 return a.count==b.count && !memcmp(a.bindings,b.bindings,a.count*sizeof(LizardBinding));
}
int main(){
 std::fill(testFlash,testFlash+7168,0xFFFFFFFF);assert(storageBegin());
 // a non-lizard mode boots with the built-in defaults live
 defaultLizardMap();const LizardMap defaults=g_lizardMap;assert(defaults.count>0);
 // the editor's copy: no saved map yet, so it gets the defaults and they are persisted
 LizardMap edit;loadLizardMap(edit);assert(same(edit,defaults));assert(files.count("/lizard_map.bin"));
 // editing and saving the copy changes the saved map but never the live one
 edit.count=1;edit.bindings[0]=LizardBinding{LZ_OUT_KBD_CHORD,{0,0x28,0,0,0,0,0},LZ_BTN_RSTICK_UP,0x80000u};
 saveLizardMap(edit);assert(same(g_lizardMap,defaults));
 LizardMap back;loadLizardMap(back);assert(same(back,edit));
 // resetting the copy to defaults leaves the live map alone too
 g_lizardMap.count=3;defaultLizardMap(edit);assert(g_lizardMap.count==3);assert(same(edit,defaults));
 // the default argument still targets the live map (Lizard mode boot path)
 saveLizardMap(back);loadLizardMap();assert(same(g_lizardMap,back));
 defaultLizardMap();assert(same(g_lizardMap,defaults));
}
'''
with tempfile.TemporaryDirectory() as td:
 (Path(td)/'class/hid').mkdir(parents=True);(Path(td)/'class/hid/hid.h').write_text(hid)
 p=Path(td)/'test.cpp';p.write_text(storage+lizard+test)
 subprocess.run(['g++','-std=c++11','-Wall','-Wextra','-Werror','-fsanitize=address,undefined','-I'+td,'-I'+str(r/'tests/storage/stubs'),'-I'+str(r/'OpenPuck'),str(p),'-o',td+'/test'],check=True)
 subprocess.run([td+'/test'],check=True,env={'ASAN_OPTIONS':'detect_leaks=0'})
print('Lizard map: the editor copy loads, saves and resets without touching the live map')
