// Mutable state shared across modules (an imported binding can't be reassigned, so it lives on one object).
// State used by a single module stays a module-local `let` there.
export const S = {
  // WebUSB device + endpoints
  dev:null, epIn:0, epOut:0,
  // Pipe owners: each pauses the status-blob poll while it holds the shared bulk endpoint.
  polling:false, capturing:false, backupBusy:false, flightBusy:false, lizardBusy:false, rfBusy:false,
  inflight:false, fieldBusy:false,
  // A ReversePuck CONTROLLER dongle (28DE:1302) speaks a REDUCED subset of this protocol: no status blob /
  // lizard / config, just a paired-pucks list (0xAC) plus the identical firmware-update + DFU ops. When true,
  // the panel shows the controller UI (manage paired pucks + flash) and skips every puck-only poll.
  isDongle:false,
  lastP:null, // most recent status-blob payload (config source for Export)
  lastSw:null, // most recent 0xAE Switch Pro / HD rumble / shortcut frame (blob v23+)
  // Stability test: armed = active across reconnects; stabStart = ms of the current run; stabLastRun = last
  // completed run {secs} (ended by a reset). Kept in-page so it survives the device reset (not a page refresh).
  stabArmed:false, stabStart:0, stabLastRun:null,
  // Running hang log: one entry per reset (persists in-page across the device reset; a page refresh clears it).
  // pendingHang is set at disconnect and enriched with reason/PC/stack from the first blob after reconnect.
  hangLog:[], pendingHang:null,
  lizardBindings:[],   // [{outType, od:[7], trig, hold}]
  lizardLoaded:false,  // one-shot: the lizard map is fetched lazily, only once the connected puck proves it speaks v16+
  lizardLoadDue:false, // set by applyBlob, run by startPolling between polls
  tabInited:false,
  // Mapping profiles (status v30+, panel/profiles.js): per type {active, maps[], pads[]} from the 0xB0 frame, the
  // profile each type's page is editing, the types still to be fetched, and the puck-wide profile-switch gesture.
  profiles:[null,null,null,null,null], lizardProfileMaps:null, profileSel:[], profileLoadDue:new Set(), gesture:null,
  // RF recovery / journal status
  rfCapable:false, rfLastRefresh:0, rfHopPending:false, rfHandoffActive:false, rfBuilderActive:false,
  rfSurveyRunning:false, rfSurveyPending:false,
  // per-slot tab state
  g_activeSlot:0,
  g_slotData:[], // [{up, battery, rssi}] indexed by slot 0..3, only set for bonded slots
};
