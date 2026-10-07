import { S } from './state.js';
import { $, log } from './util.js';
import { readFrame, send } from './protocol.js';
import { SC2_IDX, SC2_MAT, SC2_POS } from './sc2_mesh.js';

// ---- 3D motion view (Inputs & feedback page) ----
// Polls op 0x2A (status v28) at ~25 Hz while the page is on screen and draws the controller at its current
// orientation, estimated here from the accelerometer and gyro (Mahony filter): the gyro turns the model and the
// accelerometer pulls its tilt back toward gravity, so pitch/roll hold while yaw slowly drifts (Recenter).
// Everything is in the SC2 sensor frame: +x right, +y forward (away from the player), +z up, right-handed --
// the frame SDL's own SC2 driver uses (gamepad_util.h psImuPack); at rest the accel reads +1 g on z.
// The report-0x42 quaternion is only displayed: it is copied straight from the IMU chip, whose axes needn't
// match the accel/gyro frame above.
const ACC_PER_G = 16384, GYRO_PER_DPS = 16.384, POLL_MS = 40;
const KP = 2.0; // accel correction gain of the fallback filter (rad/s per unit of gravity error)

let q = [1, 0, 0, 0], ref = [1, 0, 0, 0], needRecenter = true, lastMs = 0, polling = false, source = "";
let lastSlot = -1;
// "Turn on IMU" in progress: { t0, sends, timer }
let imuWait = null;
const IMU_ON_RESEND_MS = 1000, IMU_ON_GIVEUP_MS = 90000;
// a build that predates op 0x2A drops it and never answers: stop asking after a few misses (until the next
// connection) so the 300 ms read timeouts don't crowd out the status poll
let misses = 0, missDev = null;

const qMul = (a, b) => [
  a[0]*b[0] - a[1]*b[1] - a[2]*b[2] - a[3]*b[3],
  a[0]*b[1] + a[1]*b[0] + a[2]*b[3] - a[3]*b[2],
  a[0]*b[2] - a[1]*b[3] + a[2]*b[0] + a[3]*b[1],
  a[0]*b[3] + a[1]*b[2] - a[2]*b[1] + a[3]*b[0]];
const qConj = a => [a[0], -a[1], -a[2], -a[3]];
const qNorm = a => { const n = Math.hypot(...a) || 1; return a.map(v => v / n); };
// rotate vector v by unit quaternion a
const qRot = (a, v) => qMul(qMul(a, [0, ...v]), qConj(a)).slice(1);

// one motion sample: [ver][slot][up][ax ay az gx gy gz qw qx qy qz] (s16 LE)
function decode(f){
  const s16 = o => { const v = f[o] | (f[o+1] << 8); return v > 32767 ? v - 65536 : v; };
  const v = []; for(let i = 0; i < 10; i++) v.push(s16(3 + i*2));
  return { up: !!f[2], a: v.slice(0, 3), g: v.slice(3, 6), q: v.slice(6, 10) };
}

// the tilt that turns body "up" (the measured gravity direction) onto world up; heading stays arbitrary
function tiltFromAccel(a){
  const n = Math.hypot(...a), u = a.map(v => v / n), c = [u[1], -u[0], 0], s = Math.hypot(...c);
  if(s < 1e-6) return u[2] > 0 ? [1, 0, 0, 0] : [0, 1, 0, 0];
  const h = Math.atan2(s, u[2]) / 2;
  return [Math.cos(h), c[0]/s*Math.sin(h), c[1]/s*Math.sin(h), 0];
}

function update(m){
  const now = performance.now(), dt = lastMs ? Math.min(0.1, (now - lastMs) / 1000) : 0;
  lastMs = now;
  const an = Math.hypot(...m.a);
  if(!m.up) source = "controller not connected";
  else if(!an && !m.g.some(Boolean))
    source = imuWait ? "waiting for the controller to start sending motion data" : "no motion data -- turn on the IMU below";
  else if(needRecenter){
    // first sample: start from the measured tilt instead of converging to it from flat
    q = an ? tiltFromAccel(m.a) : [1, 0, 0, 0];
    recenterNow(); needRecenter = false; source = "accelerometer + gyro";
  } else {
    // gyro in rad/s, plus a correction that turns the estimated "up" toward the measured gravity
    const w = m.g.map(v => v / GYRO_PER_DPS * Math.PI / 180);
    if(an > 0.5 * ACC_PER_G && an < 1.5 * ACC_PER_G){ // only trust accel near 1 g (not while shaking)
      const a = m.a.map(v => v / an), up = qRot(qConj(q), [0, 0, 1]);
      const e = [a[1]*up[2] - a[2]*up[1], a[2]*up[0] - a[0]*up[2], a[0]*up[1] - a[1]*up[0]];
      for(let i = 0; i < 3; i++) w[i] += KP * e[i];
    }
    q = qNorm(qMul(q, [1, w[0]*dt/2, w[1]*dt/2, w[2]*dt/2]));
    source = "accelerometer + gyro";
  }
  const g = v => (v / ACC_PER_G).toFixed(2), d = v => (v / GYRO_PER_DPS).toFixed(0);
  $("#imuSource").textContent = source;
  $("#imuAccel").textContent = m.a.map(g).join("  ") + " g";
  $("#imuGyro").textContent = m.g.map(d).join("  ") + " °/s";
  $("#imuQuat").textContent = m.q.some(Boolean) ? m.q.map(v => (v / 32767).toFixed(2)).join("  ") : "none (report 0x45)";
  // the raw line follows the selected controller too (the status blob's copy is whichever slot was polled last)
  $("#stImu").textContent = `a=(${m.a.join(", ")})  |a|=${Math.round(an)}`;
  draw();
  if(imuWait && m.up && (an || m.g.some(Boolean))) imuOnDone();
}

// The controller can take a long while to start streaming after the IMU-on setting (seen: up to a minute; the
// cause isn't known), so the button keeps re-sending op 0x29 and counts up until the selected controller's
// motion samples arrive, rather than looking like it did nothing.
function imuOnTick(){
  const s = Math.floor((performance.now() - imuWait.t0) / 1000);
  if(!S.dev || s * 1000 >= IMU_ON_GIVEUP_MS){
    log(`IMU on: no motion data after ${s} s (${imuWait.sends} sends)`);
    imuOnEnd(S.dev ? `No motion data after ${s} s. Press again to keep trying.` : "Not connected.");
    return;
  }
  imuWait.sends++;
  send([0x29]);
  $("#imuOn").textContent = `Waiting for motion data... ${s} s`;
}
function imuOnEnd(msg){
  clearInterval(imuWait.timer); imuWait = null;
  $("#imuOn").disabled = false; $("#imuOn").textContent = "Turn on IMU";
  $("#imuOnState").textContent = msg;
}
function imuOnDone(){
  const s = ((performance.now() - imuWait.t0) / 1000).toFixed(1), sends = imuWait.sends;
  imuOnEnd(`Motion data arriving (after ${s} s).`);
  log(`IMU on: motion data after ${s} s (${sends} sends)`);
}

// keep only the heading (rotation about up) out of the reference, so Recenter faces the model forward without
// flattening a controller that's being held tilted
function recenterNow(){
  const fwd = qRot(q, [0, 1, 0]), yaw = Math.atan2(-fwd[0], fwd[1]);
  ref = [Math.cos(-yaw/2), 0, 0, Math.sin(-yaw/2)];
}

// ---- model: Valve's published shell (panel/sc2_mesh.js), drawn with WebGL so the depth buffer sorts it ----
// camera behind and above the player's hands, looking forward and down at the controller (units: cm)
const TILT = -0.6, DIST = 34, NEAR = DIST - 12, FAR = DIST + 12;
const VS = `attribute vec3 p; attribute vec3 n; attribute vec3 c;
uniform mat3 M; uniform vec4 P; varying vec3 vn; varying vec3 vc;
void main(){ vec3 e = M * p; vn = M * n; vc = c; float w = ${DIST.toFixed(1)} + e.z;
  gl_Position = vec4(e.x * P.x, e.y * P.y - 0.1 * w, P.z * w - P.w, w); }`;
// vc is the material one-hot (shell, trackpad, stick cap); taking its largest weight keeps edges sharp
const FS = `precision mediump float; varying vec3 vn; varying vec3 vc;
void main(){ float l = max(0.0, dot(normalize(vn), normalize(vec3(0.3, 0.8, -0.5))));
  vec3 col = vc.y > max(vc.x, vc.z) ? vec3(0.36, 0.61, 0.84) : vc.z > vc.x ? vec3(0.11, 0.13, 0.19) : vec3(0.23, 0.26, 0.34);
  gl_FragColor = vec4(col * (0.45 + 0.9 * l), 1.0); }`;
let gl = null, glProg = null, glCount = 0;

const b64 = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));
function glSetup(cv){
  gl = cv.getContext("webgl", { antialias: true });
  if(!gl) return;
  const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); return o; };
  glProg = gl.createProgram();
  gl.attachShader(glProg, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(glProg, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(glProg); gl.useProgram(glProg);
  const pos = new Int16Array(b64(SC2_POS).buffer), mat = b64(SC2_MAT), idx = new Uint16Array(b64(SC2_IDX).buffer);
  const P = new Float32Array(pos.length), N = new Float32Array(pos.length), C = new Float32Array(pos.length);
  for(let i = 0; i < pos.length; i++) P[i] = pos[i] / 100; // 0.1 mm -> cm
  // smooth normals: sum of the (area-weighted) face normals around each vertex
  for(let t = 0; t < idx.length; t += 3){
    const [a, b, c] = [idx[t]*3, idx[t+1]*3, idx[t+2]*3];
    const u = [P[b]-P[a], P[b+1]-P[a+1], P[b+2]-P[a+2]], v = [P[c]-P[a], P[c+1]-P[a+1], P[c+2]-P[a+2]];
    const f = [u[1]*v[2] - u[2]*v[1], u[2]*v[0] - u[0]*v[2], u[0]*v[1] - u[1]*v[0]];
    for(const k of [a, b, c]) for(let j = 0; j < 3; j++) N[k+j] += f[j];
  }
  // the pads are flattened (tools/sc2_mesh.py): one normal per pad hides the slivers decimation folds over them
  for(const side of [-1, 1]){
    const sum = [0, 0, 0], pad = [];
    mat.forEach((m, i) => { if(m === 1 && Math.sign(P[i*3]) === side){ pad.push(i); for(let j = 0; j < 3; j++) sum[j] += N[i*3+j]; } });
    for(const i of pad) N.set(sum, i*3);
  }
  mat.forEach((m, i) => { C[i*3 + m] = 1; });
  for(const [name, data] of [["p", P], ["n", N], ["c", C]]){
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(glProg, name); gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  glCount = idx.length;
  gl.enable(gl.DEPTH_TEST);
}

function draw(){
  const cv = $("#imuCanvas"); if(!cv) return;
  const W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1;
  if(!W || !H) return; // hidden (page not shown, or firmware without the motion op)
  if(!gl){ glSetup(cv); if(!gl) return; }
  if(cv.width !== Math.round(W*dpr) || cv.height !== Math.round(H*dpr)){
    cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr);
  }
  gl.viewport(0, 0, cv.width, cv.height);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  // body -> world is the rotation r; world (SC2 axes) -> camera (right, up, into screen) tilts about x
  const r = qMul(ref, q), c = Math.cos(TILT), s = Math.sin(TILT), M = new Float32Array(9);
  for(let j = 0; j < 3; j++){
    const w = qRot(r, [j === 0, j === 1, j === 2].map(Number)); // column j: body axis j in world
    M[j*3] = w[0]; M[j*3+1] = w[2]*c - w[1]*s; M[j*3+2] = w[2]*s + w[1]*c;
  }
  const F = Math.min(W, H) * 1.7;
  gl.uniformMatrix3fv(gl.getUniformLocation(glProg, "M"), false, M);
  // perspective onto the old 2D layout (centre at 55% height); depth NEAR..FAR -> -1..1
  gl.uniform4f(gl.getUniformLocation(glProg, "P"), 2*F/W, 2*F/H, (FAR + NEAR) / (FAR - NEAR), 2*FAR*NEAR / (FAR - NEAR));
  gl.drawElements(gl.TRIANGLES, glCount, gl.UNSIGNED_SHORT, 0);
}

async function tick(){
  if(missDev !== S.dev){ missDev = S.dev; misses = 0; }
  if(polling || misses >= 5 || !S.dev || S.isDongle || !S.lastP || S.lastP[0] < 28) return;
  if($("#pgInput").classList.contains("hide") || document.visibilityState !== "visible") return;
  // same pipe owners the status poll yields to; holding inflight makes the status poll wait for us
  if(S.inflight || S.capturing || S.backupBusy || S.flightBusy || S.lizardBusy || S.rfBusy || S.fieldBusy) return;
  // a different controller: start over from its measured tilt
  if(S.g_activeSlot !== lastSlot){ lastSlot = S.g_activeSlot; needRecenter = true; }
  polling = true; S.inflight = true;
  try{
    await send([0x2A, S.g_activeSlot & 0xff]);
    const f = await readFrame(0xAF, 23, 64, 300);
    if(f){ misses = 0; update(decode(f)); } else misses++;
  } finally { S.inflight = false; polling = false; }
}

export function initMotion(){
  $("#imuRecenter").onclick = () => { recenterNow(); draw(); };
  $("#imuOn").onclick = () => {
    if(!S.dev || imuWait) return;
    misses = 0; // a poll that gave up earlier gets another go
    imuWait = { t0: performance.now(), sends: 0, timer: setInterval(imuOnTick, IMU_ON_RESEND_MS) };
    $("#imuOn").disabled = true; $("#imuOnState").textContent = "";
    imuOnTick();
  };
  setInterval(tick, POLL_MS); // tick() skips while the page is hidden or a sample is still in flight
}

// status blob: show the 3D view only on firmware that answers op 0x2A
export function syncMotionCap(p){
  $("#imuView").classList.toggle("hide", p[0] < 28);
  if(p[0] < 28) needRecenter = true;
}
