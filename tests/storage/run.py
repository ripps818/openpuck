from pathlib import Path
import gzip,subprocess,tempfile
r=Path(__file__).resolve().parents[2]
s=(r/'OpenPuck/storage.cpp').read_text().replace('0xED000','(uintptr_t)testFlash')
healthy=gzip.decompress((r/'tests/lfs_check/healthy.bin.gz').read_bytes())
healthyArr='static const uint8_t healthyImage[]={'+','.join(str(b) for b in healthy)+'};\n'
test='''
#include <cassert>
#include <algorithm>
bool mountOk=false,failWrite=false,failRead=false,failRename=false;
int formats=0,erases=0;
std::map<std::string,std::vector<uint8_t>> files;
InternalFileSystem InternalFS;
uint32_t testFlash[7168];
int main(){
 // flash LittleFS could not walk is erased and initialized
 std::fill(testFlash,testFlash+7168,0xFFFFFFFF);testFlash[100]=0;
 assert(storageBegin());assert(erases==7);assert(formats==1);assert(g_storageState==4);
 assert(std::all_of(testFlash,testFlash+7168,[](uint32_t w){return w==0xFFFFFFFF;}));
 // blank flash is initialized, a mounted one is left alone
 mountOk=false;erases=0;formats=0;
 assert(storageBegin());assert(erases==0);assert(formats==1);assert(g_storageState==2);
 assert(storageBegin());assert(formats==1);assert(g_storageState==1);
 // a sound image that does not mount keeps its data
 memcpy(testFlash,healthyImage,sizeof healthyImage);mountOk=false;formats=0;
 assert(!storageBegin());assert(erases==0);assert(formats==0);assert(g_storageState==0);
 assert(memcmp(testFlash,healthyImage,sizeof healthyImage)==0);
 mountOk=true;assert(storageBegin());assert(g_storageState==1);assert(erases==0);
 const uint8_t old[]={1,2,3};const uint8_t next[]={8,9,10,11};
 files["/cfg.bin"]={old,old+3};
 failWrite=true;assert(!storageWriteFile("/cfg.bin","/cfg.tmp",next,4));
 assert(files["/cfg.bin"]==std::vector<uint8_t>(old,old+3));assert(g_storageState==3);
 failWrite=false;failRead=true;assert(!storageWriteFile("/cfg.bin","/cfg.tmp",next,4));
 assert(files["/cfg.bin"]==std::vector<uint8_t>(old,old+3));
 failRead=false;failRename=true;assert(!storageWriteFile("/cfg.bin","/cfg.tmp",next,4));
 assert(files["/cfg.bin"]==std::vector<uint8_t>(old,old+3));
 failRename=false;assert(storageWriteFile("/cfg.bin","/cfg.tmp",next,4));
 assert(files["/cfg.bin"]==std::vector<uint8_t>(next,next+4));assert(g_storageState==1);
 files["/bonds.bin"]={old,old+3};failWrite=true;
 assert(!storageWriteFile("/bonds.bin","/bonds.tmp",next,4));
 assert(files["/bonds.bin"]==std::vector<uint8_t>(old,old+3));
 // a new file exists (empty) before its rename, so the rename replaces an entry instead of adding one
 failWrite=false;failRename=true;assert(!files.count("/lizard_map3.bin"));
 assert(!storageWriteFile("/lizard_map3.bin","/lizard.tmp",next,4));
 assert(files.count("/lizard_map3.bin")&&files["/lizard_map3.bin"].empty());
 failRename=false;assert(storageWriteFile("/lizard_map3.bin","/lizard.tmp",next,4));
 assert(files["/lizard_map3.bin"]==std::vector<uint8_t>(next,next+4));
}
'''
with tempfile.TemporaryDirectory() as td:
 p=Path(td)/'test.cpp';p.write_text(s+healthyArr+test)
 subprocess.run(['g++','-std=c++11','-Wall','-Wextra','-Werror','-fsanitize=address,undefined','-I'+str(r/'tests/storage/stubs'),'-I'+str(r/'OpenPuck'),str(p),str(r/'OpenPuck/lfs_check.cpp'),'-o',td+'/test'],check=True)
 subprocess.run([td+'/test'],check=True,env={'ASAN_OPTIONS':'detect_leaks=0'})
print('Storage mount, corruption repair and interrupted-save tests passed')
