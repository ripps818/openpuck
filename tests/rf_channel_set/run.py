from pathlib import Path
import subprocess,tempfile
r=Path(__file__).resolve().parents[2]
h=(r/'OpenPuck/rf_link.h').read_text();s=(r/'OpenPuck/rf_link.cpp').read_text()
def cut(src,a,b):
 i=src.index(a);return src[i:src.index(b,i)]
# The real candidate/mask helpers and journal code, over a RAM stand-in for the two flash pages.
code='\n'.join([
 cut(h,'// Recovery channel candidates','enum RfChannelDesignation'),
 'uint64_t g_rfChannelMask = RF_CHANNEL_MASK_DEFAULT;',
 cut(s,'// 4 = one row per candidate channel,','// Ambient RSSI is diagnostic'),
 cut(s,'struct RfChannelJournalRecord {','// Current-boot evidence.'),
 cut(s,'static int rfRecoveryChannelIndex','static bool rfRecoveryTargetFailed(uint8_t ch)\n{'),
 'static void rfChannelJournalCheckSoftDevice() {}',
 'static uintptr_t rfChannelJournalFlashUsedEnd() { return 0; }',
 cut(s,'static uint32_t rfChannelJournalCrc32','static void rfChannelJournalCheckSoftDevice()'),
 cut(s,'static int16_t rfChannelJournalFindFreeSlot()','static bool rfChannelJournalStartWrite()'),
])
head='''#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <cassert>
alignas(4096) static uint8_t g_rfChannelJournalGuard[8192];
#define RF_CHANNEL_JOURNAL_PAGE_BYTES 4096u
#define RF_CHANNEL_JOURNAL_PAGE_COUNT 2u
#define RF_CHANNEL_JOURNAL_BASE ((uintptr_t)g_rfChannelJournalGuard)
'''
test='''
static uint8_t *v2At(uint16_t slot){ return g_rfChannelJournalGuard+(slot/39)*4096u+(slot%39)*104u; }
static void putV2(uint16_t slot,uint32_t seq,uint8_t base){
 RfChannelJournalRecordV2 rec;memset(&rec,0,sizeof rec);
 rec.magic=RF_CHANNEL_JOURNAL_MAGIC;rec.sequence=seq;rec.format=2;rec.poolCount=14;rec.orderCounter=base;
 for(int i=0;i<14;i++){rec.worstPct[i]=(uint8_t)(base+i);rec.meanPct[i]=(uint8_t)(base+i+1);rec.confidence[i]=(uint8_t)(i%16);
  rec.trials[i]=(uint8_t)(i+1);rec.penalty[i]=(uint8_t)(i%11);rec.recentOrder[i]=(uint8_t)(base+2*i);}
 rec.crc32=rfChannelJournalCrc32(&rec,offsetof(RfChannelJournalRecordV2,crc32));rec.commit=RF_CHANNEL_JOURNAL_COMMIT;
 memcpy(v2At(slot),&rec,sizeof rec);
}
static void reload(){
 g_channelHistoryPersistentLoaded=false;g_channelHistoryPersistentDirty=false;g_channelJournalSequence=0;
 g_channelJournalLatestSlot=-1;g_channelJournalV2Page=0xFFu;g_channelHistoryPersistentOrderCounter=0;
 memset(g_channelHistoryPersistentWorstPct,0,sizeof g_channelHistoryPersistentWorstPct);
 memset(g_channelHistoryPersistentMeanPct,0,sizeof g_channelHistoryPersistentMeanPct);
 memset(g_channelHistoryPersistentConfidence,0,sizeof g_channelHistoryPersistentConfidence);
 memset(g_channelHistoryPersistentTrials,0,sizeof g_channelHistoryPersistentTrials);
 memset(g_channelHistoryPersistentPenalty,0,sizeof g_channelHistoryPersistentPenalty);
 memset(g_channelHistoryPersistentRecentOrder,0,sizeof g_channelHistoryPersistentRecentOrder);
 rfChannelJournalLoad();
}
static void checkMigrated(uint8_t base){
 for(int i=0;i<14;i++){
  const int idx=(g_channelJournalV2Pool[i]-4)/2;
  assert(g_channelHistoryPersistentWorstPct[idx]==base+i&&g_channelHistoryPersistentMeanPct[idx]==base+i+1);
  assert(g_channelHistoryPersistentConfidence[idx]==i%16&&g_channelHistoryPersistentTrials[idx]==i+1);
  assert(g_channelHistoryPersistentPenalty[idx]==i%11&&g_channelHistoryPersistentRecentOrder[idx]==base+2*i);
 }
 for(int ch=4;ch<=80;ch+=2){
  bool pool=false;for(int i=0;i<14;i++)pool|=g_channelJournalV2Pool[i]==ch;
  if(!pool)assert(!g_channelHistoryPersistentTrials[(ch-4)/2]);
 }
}
struct Hist{uint8_t w[RF_RECOVERY_CHANNEL_COUNT],m[RF_RECOVERY_CHANNEL_COUNT],c[RF_RECOVERY_CHANNEL_COUNT],t[RF_RECOVERY_CHANNEL_COUNT],p[RF_RECOVERY_CHANNEL_COUNT],r[RF_RECOVERY_CHANNEL_COUNT],order;};
static void snap(Hist &h){
 memcpy(h.w,g_channelHistoryPersistentWorstPct,sizeof h.w);memcpy(h.m,g_channelHistoryPersistentMeanPct,sizeof h.m);
 memcpy(h.c,g_channelHistoryPersistentConfidence,sizeof h.c);memcpy(h.t,g_channelHistoryPersistentTrials,sizeof h.t);
 memcpy(h.p,g_channelHistoryPersistentPenalty,sizeof h.p);memcpy(h.r,g_channelHistoryPersistentRecentOrder,sizeof h.r);
 h.order=g_channelHistoryPersistentOrderCounter;
}
// A plain (format 3) record with four explored channels, the way the earlier nightly wrote it.
static void putV3(uint16_t slot,uint32_t seq){
 RfChannelJournalRecord r;memset(&r,0,sizeof r);
 r.magic=RF_CHANNEL_JOURNAL_MAGIC;r.sequence=seq;r.format=3;r.poolCount=RF_RECOVERY_CHANNEL_COUNT;r.orderCounter=21;
 const int ex[]={0,5,17,38};
 for(int i:ex){r.worstPct[i]=(uint8_t)(90-i);r.meanPct[i]=(uint8_t)(95-i);r.confidence[i]=(uint8_t)(i%16);
  r.trials[i]=(uint8_t)(i+3);r.penalty[i]=(uint8_t)(i%11);r.recentOrder[i]=(uint8_t)(10+i);}
 r.crc32=rfChannelJournalCrc32(&r,offsetof(RfChannelJournalRecord,crc32));r.commit=RF_CHANNEL_JOURNAL_COMMIT;
 memcpy((void *)rfChannelJournalSlotAddress(slot),&r,sizeof r);
}
// Program a record the way the writer does: every word that is not the erased value, in order.
static void program(uint16_t slot,const RfChannelJournalRecord &r,int stopBefore){
 uint32_t *dst=(uint32_t *)rfChannelJournalSlotAddress(slot);const uint32_t *src=(const uint32_t *)&r;
 for(int i=0;i<stopBefore;i++)if(src[i]!=0xFFFFFFFFu)dst[i]=src[i];
}
int main(){
 // Masks: the default is the old 14-channel pool; a cfg.bin from before the field reads 0xFF and is rejected.
 assert(RF_CHANNEL_MASK_DEFAULT==0x5F05288380ull);
 assert(!rfChannelMaskValid(0)&&rfChannelMaskValid(RF_CHANNEL_MASK_ALL)&&!rfChannelMaskValid(0xFFFFFFFFFFull));
 assert(rfChannelMaskValid(RF_CHANNEL_BIT(80))&&!rfChannelMaskValid(RF_CHANNEL_MASK_ALL+1));
 g_rfChannelMask=RF_CHANNEL_MASK_DEFAULT;
 assert(rfRecoveryChannelEnabled(18)&&rfRecoveryChannelEnabled(80)&&!rfRecoveryChannelEnabled(4));
 const int off[]={0,2,3,19,81,82,100,255};for(int ch:off)assert(!rfRecoveryChannelEnabled((uint8_t)ch));
 assert(rfRecoveryDefaultChannel()==18);
 g_rfChannelMask=RF_CHANNEL_BIT(60)|RF_CHANNEL_BIT(40);assert(rfRecoveryDefaultChannel()==40);
 g_rfChannelMask=RF_CHANNEL_MASK_ALL;for(int ch=4;ch<=80;ch+=2)assert(rfRecoveryChannelEnabled((uint8_t)ch));

 // Empty journal: nothing loads, nothing to rewrite.
 memset(g_rfChannelJournalGuard,0xFF,sizeof g_rfChannelJournalGuard);reload();
 assert(!g_channelHistoryPersistentDirty&&g_channelJournalLatestSlot<0&&g_channelJournalFreeSlot==0);

 // v2 journal: page 0 full (39 records), the newest two in page 1. The newest is imported row by row onto
 // the candidate index and marked dirty, and its page is kept until a format-4 record supersedes it.
 for(uint16_t k=0;k<39;k++)putV2(k,100+k,(uint8_t)k);
 putV2(39,200,7);putV2(40,201,9);
 static uint8_t before[8192];memcpy(before,g_rfChannelJournalGuard,sizeof before);
 reload();
 assert(g_channelJournalSequence==201&&g_channelHistoryPersistentDirty&&g_channelJournalV2Page==1);
 assert(g_channelJournalLatestSlot<0&&g_channelHistoryPersistentOrderCounter==9);checkMigrated(9);
 // a format-3/4 reader never takes a v2 record, even where the strides line up (v2 slot 32 = v4 slot 13)
 RfChannelJournalRecord v3;RfChannelJournalRecordV2 v2;
 assert(rfChannelJournalReadValidV2(32,&v2)&&!rfChannelJournalReadValid(13,&v3)&&!rfChannelJournalReadValid(0,&v3));
 // The first free format-4 slot is clear of every v2 byte: page 0 is full, page 1 holds 208 bytes.
 assert(g_channelJournalFreeSlot==17);
 rfChannelJournalBuildRecord(&v3);
 memcpy((void *)rfChannelJournalSlotAddress((uint16_t)g_channelJournalFreeSlot),&v3,sizeof v3);
 assert(!memcmp(before,g_rfChannelJournalGuard,4096+208));

 // Next boot: the format-4 record wins, the history is unchanged and no longer dirty, v2 data stays intact.
 reload();
 assert(g_channelJournalSequence==202&&!g_channelHistoryPersistentDirty&&g_channelJournalV2Page==0xFFu);
 assert(g_channelJournalLatestSlot==17);checkMigrated(9);
 int v2Valid=0;for(uint16_t k=0;k<78;k++)v2Valid+=rfChannelJournalReadValidV2(k,&v2);
 assert(v2Valid==41);

 // A torn format-4 write (commit word never programmed) is ignored and the v2 history imports again.
 memset(g_rfChannelJournalGuard,0xFF,sizeof g_rfChannelJournalGuard);putV2(0,50,3);reload();
 rfChannelJournalBuildRecord(&v3);v3.commit=0xFFFFFFFFu;
 memcpy((void *)rfChannelJournalSlotAddress((uint16_t)g_channelJournalFreeSlot),&v3,sizeof v3);
 reload();assert(g_channelJournalSequence==50&&g_channelHistoryPersistentDirty&&g_channelJournalV2Page==0);checkMigrated(3);

 // Format 3 (rows stored plain) is converted, not dropped: it loads unchanged and is marked dirty.
 memset(g_rfChannelJournalGuard,0xFF,sizeof g_rfChannelJournalGuard);reload();
 putV3(0,10);putV3(1,11);reload();
 Hist h3;snap(h3);
 assert(g_channelJournalSequence==11&&g_channelJournalLatestSlot==1&&g_channelHistoryPersistentDirty&&g_channelJournalFreeSlot==2);
 assert(h3.order==21&&h3.t[5]==8&&h3.w[5]==85&&h3.t[1]==0&&h3.w[1]==0&&h3.t[38]==41);
 // The rewrite is format 4 with the rows inverted, so unexplored rows leave most words erased...
 RfChannelJournalRecord v4;rfChannelJournalBuildRecord(&v4);
 assert(v4.format==4&&v4.sequence==12&&v4.worstPct[1]==0xFF&&v4.worstPct[5]==(uint8_t)~85);
 int erased=0;for(int i=0;i<64;i++)erased+=((const uint32_t *)&v4)[i]==0xFFFFFFFFu;
 assert(erased>=30&&((const uint32_t *)&v4)[63]==RF_CHANNEL_JOURNAL_COMMIT);
 // ...and the writer's skip passes over exactly those, still programming the commit word last.
 g_channelJournalJob=v4;g_channelJournalJobWord=0;
 int programmed=0,last=-1;
 for(;;){rfChannelJournalSkipErasedWords();if(g_channelJournalJobWord>=64)break;last=g_channelJournalJobWord;programmed++;g_channelJournalJobWord++;}
 assert(programmed==64-erased&&last==63);
 // That record loads back identical, wins over its format-3 predecessors and clears the dirty flag.
 program((uint16_t)g_channelJournalFreeSlot,v4,64);reload();
 Hist h4;snap(h4);
 assert(!memcmp(&h3,&h4,sizeof h3)&&!g_channelHistoryPersistentDirty&&g_channelJournalSequence==12&&g_channelJournalLatestSlot==2);
 // A torn format-4 write (commit never programmed) falls back to the intact format-3 record.
 memset(g_rfChannelJournalGuard,0xFF,sizeof g_rfChannelJournalGuard);reload();
 putV3(0,10);reload();rfChannelJournalBuildRecord(&v4);program((uint16_t)g_channelJournalFreeSlot,v4,63);reload();
 snap(h4);assert(!memcmp(&h3,&h4,sizeof h3)&&g_channelJournalSequence==10&&g_channelHistoryPersistentDirty);
}
'''
with tempfile.TemporaryDirectory() as td:
 p=Path(td)/'test.cpp';p.write_text(head+code+test)
 subprocess.run(['g++','-std=c++11','-Wall','-Wextra','-Werror','-Wno-unused','-fsanitize=address,undefined',str(p),'-o',td+'/test'],check=True)
 subprocess.run([td+'/test'],check=True,env={'ASAN_OPTIONS':'detect_leaks=0'})
print('RF channel set: mask helpers, v2 import, format-3 conversion and format-4 journal tests passed')
