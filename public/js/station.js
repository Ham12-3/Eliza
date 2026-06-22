// First-person Elizabeth line station view (Three.js).
//
// A ground-level, representative train-shed: platforms, arched glazed canopy,
// track, and a Class 345 train that arrives / dwells / departs in time with the
// live TfL arrival predictions for the selected station.
//
// Data: /data/track.json (station list) + /api/arrivals (live predictions).

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// ---- layout constants (metres) ----
const NEAR_TRACK_Z = 1.7;
const FAR_TRACK_Z = -1.7;
const GAUGE = 1.435;
const PLAT_H = 1.0;
const PLAT_A = [2.6, 8]; // camera-side platform z-range
const PLAT_B = [-8, -2.6];
const STOP_X = 0; // where the train front halts
const CAR_LEN = 22;
const CAR_W = 2.78;
const NCARS = 9;
const TRAIN_LEN = NCARS * (CAR_LEN + 0.6);

// ---- materials ----
const M = {
  body: new THREE.MeshStandardMaterial({ color: 0xe8e9ec, roughness: 0.45, metalness: 0.1 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.6, metalness: 0.2 }),
  glassWin: new THREE.MeshStandardMaterial({ color: 0x0d0f14, roughness: 0.15, metalness: 0.7 }),
  door: new THREE.MeshStandardMaterial({ color: 0x6c3fa0, roughness: 0.5, metalness: 0.1 }),
  roof: new THREE.MeshStandardMaterial({ color: 0xc6c9cf, roughness: 0.6, metalness: 0.2 }),
  cab: new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.3, metalness: 0.4 }),
  noseTrim: new THREE.MeshStandardMaterial({ color: 0x6c3fa0, roughness: 0.5 }),
  rail: new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.35, metalness: 0.85 }),
  sleeper: new THREE.MeshStandardMaterial({ color: 0x3b3d42, roughness: 0.9 }),
  ballast: new THREE.MeshStandardMaterial({ color: 0x303236, roughness: 1 }),
  plat: new THREE.MeshStandardMaterial({ color: 0x596069, roughness: 0.95 }),
  platWall: new THREE.MeshStandardMaterial({ color: 0x3f444b, roughness: 1 }),
  edge: new THREE.MeshStandardMaterial({ color: 0xd9b400, roughness: 0.6 }),
  tactile: new THREE.MeshStandardMaterial({ color: 0x8a6d22, roughness: 1 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x474c55, roughness: 0.5, metalness: 0.6 }),
  glass: new THREE.MeshStandardMaterial({
    color: 0xaecbe0, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.14, side: THREE.DoubleSide,
  }),
  wheel: new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.5, metalness: 0.6 }),
};

let renderer, scene, camera, controls, clock;
let trainGroup = null; // active train Group
const trainAnim = { phase: "idle", t: 0, info: null };
let stations = [];
let selected = null;
let arrivals = [];
let queue = []; // upcoming arrivals to animate

init();

function init() {
  const host = document.getElementById("scene");
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fb2c4);
  scene.fog = new THREE.Fog(0x9fb2c4, 90, 320);

  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
  camera.position.set(26, 2.6, 5.4);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(-6, 2.4, 0.6);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495; // don't dip below the ground
  controls.minDistance = 4;
  controls.maxDistance = 120;

  addLights();
  buildGround();
  buildTrack(NEAR_TRACK_Z);
  buildTrack(FAR_TRACK_Z);
  buildPlatform(PLAT_A, NEAR_TRACK_Z, +1);
  buildPlatform(PLAT_B, FAR_TRACK_Z, -1);
  buildCanopy();

  // park a train at the platform so the scene is populated immediately
  trainGroup = buildTrain();
  trainGroup.position.x = STOP_X;
  trainAnim.phase = "dwell";
  trainAnim.t = 18;

  clock = new THREE.Clock();
  addEventListener("resize", onResize);
  loadData();
  animate();
  document.getElementById("loading").classList.add("hidden");
}

function addLights() {
  scene.add(new THREE.HemisphereLight(0xcfe0ef, 0x40444a, 0.85));
  const sun = new THREE.DirectionalLight(0xfff4e6, 1.15);
  sun.position.set(40, 70, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = 80;
  sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
  sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
  sun.shadow.camera.far = 200;
  sun.shadow.bias = -0.0003;
  scene.add(sun);
}

function box(w, h, d, mat, x, y, z, parent) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  (parent || scene).add(m);
  return m;
}

function buildGround() {
  const g = new THREE.Mesh(new THREE.PlaneGeometry(800, 400), M.ballast);
  g.rotation.x = -Math.PI / 2;
  g.position.y = 0;
  g.receiveShadow = true;
  scene.add(g);
}

function buildTrack(zc) {
  // ballast bed
  box(260, 0.25, 3.2, M.ballast, 0, 0.12, zc);
  // rails
  box(260, 0.16, 0.1, M.rail, 0, 0.28, zc - GAUGE / 2);
  box(260, 0.16, 0.1, M.rail, 0, 0.28, zc + GAUGE / 2);
  // sleepers every 2 m (instanced for perf)
  const geo = new THREE.BoxGeometry(0.26, 0.12, 2.6);
  const inst = new THREE.InstancedMesh(geo, M.sleeper, 130);
  const mtx = new THREE.Matrix4();
  let i = 0;
  for (let x = -128; x <= 128; x += 2) {
    mtx.makeTranslation(x, 0.2, zc);
    inst.setMatrixAt(i++, mtx);
  }
  inst.count = i;
  inst.receiveShadow = true;
  scene.add(inst);
}

function buildPlatform([z0, z1], trackZ, side) {
  const depth = z1 - z0;
  const cz = (z0 + z1) / 2;
  // platform body
  box(260, PLAT_H, depth, M.platWall, 0, PLAT_H / 2, cz);
  // surface
  const surf = box(260, 0.06, depth, M.plat, 0, PLAT_H + 0.03, cz);
  surf.receiveShadow = true;
  // edge nearest the track
  const edgeZ = side > 0 ? z0 : z1;
  box(260, 0.07, 0.18, M.edge, 0, PLAT_H + 0.05, edgeZ + side * 0.12);
  box(260, 0.05, 0.55, M.tactile, 0, PLAT_H + 0.05, edgeZ + side * 0.5);
  // a row of platform lamps
  for (let x = -100; x <= 100; x += 20) {
    box(0.18, 3.0, 0.18, M.steel, x, PLAT_H + 1.5, cz, scene);
  }
}

// ---- arched glazed train shed ----
function archY(z, halfW, apex, spring) {
  const t = Math.min(Math.abs(z) / halfW, 1);
  return spring + (apex - spring) * Math.cos((t * Math.PI) / 2);
}

function buildCanopy() {
  const halfW = 9;
  const apex = 11;
  const spring = 4.5;
  const ribXs = [];
  for (let x = -90; x <= 90; x += 7.5) ribXs.push(x);

  // sample points across the arch
  const sampleRib = (x) => {
    const pts = [];
    for (let z = -halfW; z <= halfW; z += halfW / 12) pts.push(new THREE.Vector3(x, archY(z, halfW, apex, spring), z));
    return pts;
  };

  const ribGeoTubes = [];
  for (const x of ribXs) {
    const curve = new THREE.CatmullRomCurve3(sampleRib(x));
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.18, 8, false), M.steel);
    tube.castShadow = true;
    scene.add(tube);
    ribGeoTubes.push(sampleRib(x));
    // columns at the arch feet
    for (const z of [-halfW, halfW]) {
      const h = archY(z, halfW, apex, spring);
      box(0.4, h, 0.4, M.steel, x, h / 2, z);
    }
  }

  // glazing strips between consecutive ribs
  for (let r = 0; r < ribGeoTubes.length - 1; r++) {
    const a = ribGeoTubes[r], b = ribGeoTubes[r + 1];
    const positions = [];
    for (let i = 0; i < a.length - 1; i++) {
      const p0 = a[i], p1 = a[i + 1], q0 = b[i], q1 = b[i + 1];
      positions.push(p0.x, p0.y, p0.z, q0.x, q0.y, q0.z, p1.x, p1.y, p1.z);
      positions.push(p1.x, p1.y, p1.z, q0.x, q0.y, q0.z, q1.x, q1.y, q1.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.computeVertexNormals();
    scene.add(new THREE.Mesh(g, M.glass));
  }

  // longitudinal purlins
  for (let k = 0; k <= 12; k += 2) {
    const z = -halfW + (k / 12) * 2 * halfW;
    const y = archY(z, halfW, apex, spring);
    box(190, 0.1, 0.1, M.steel, 0, y, z);
  }
}

// ---- Class 345 train ----
function buildCab(dir) {
  // streamlined side profile, flat back (x=0, joins the body) tapering to a
  // rounded nose at x≈3 (points outward), extruded across the car width.
  const s = new THREE.Shape();
  s.moveTo(0.0, 0.55);
  s.lineTo(0.0, 3.6);
  s.lineTo(1.1, 3.6);
  s.quadraticCurveTo(2.1, 3.45, 2.7, 2.8);
  s.quadraticCurveTo(3.05, 2.1, 3.0, 1.4);
  s.quadraticCurveTo(2.95, 0.7, 2.6, 0.55);
  s.lineTo(0.0, 0.55);
  const geo = new THREE.ExtrudeGeometry(s, { depth: CAR_W, bevelEnabled: false });
  geo.translate(0, 0, -CAR_W / 2);
  const cab = new THREE.Mesh(geo, M.cab);
  cab.castShadow = true;
  const g = new THREE.Group();
  g.add(cab);
  // windscreen + purple trim near the nose
  const ws = box(0.06, 1.0, CAR_W * 0.82, M.glassWin, 1.9, 2.95, 0, g);
  ws.rotation.z = -0.5;
  box(0.7, 0.2, CAR_W, M.noseTrim, 2.5, 0.72, 0, g);
  g.scale.x = dir; // +1 points nose toward +x, -1 toward -x
  return g;
}

function buildCar(isLead, isTail) {
  const g = new THREE.Group();
  const L = CAR_LEN;
  // underframe / skirt
  box(L, 0.5, CAR_W, M.dark, 0, 1.1, 0, g);
  // body
  box(L, 2.4, CAR_W, M.body, 0, 2.55, 0, g);
  // continuous window band (slightly proud)
  box(L * 0.9, 0.95, CAR_W + 0.04, M.glassWin, 0, 2.95, 0, g);
  // window mullions
  for (let x = -L / 2 + 2; x <= L / 2 - 2; x += 2.6) box(0.12, 0.95, CAR_W + 0.06, M.body, x, 2.95, 0, g);
  // doors (purple), both sides
  for (const dx of [-L / 3, 0, L / 3]) {
    box(1.3, 2.0, CAR_W + 0.05, M.door, dx, 2.35, 0, g);
  }
  // roof
  box(L * 0.98, 0.35, CAR_W - 0.25, M.roof, 0, 3.95, 0, g);
  // AC / equipment on roof
  box(3, 0.3, 1.6, M.dark, L * 0.2, 4.2, 0, g);
  box(2, 0.25, 1.4, M.dark, -L * 0.25, 4.15, 0, g);
  // bogies + wheels
  for (const bx of [-L / 2 + 3.5, L / 2 - 3.5]) {
    box(2.6, 0.5, 2.2, M.dark, bx, 0.75, 0, g);
    for (const wx of [bx - 0.9, bx + 0.9]) {
      for (const wz of [-GAUGE / 2, GAUGE / 2]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.18, 16), M.wheel);
        w.rotation.x = Math.PI / 2;
        w.position.set(wx, 0.45, wz);
        g.add(w);
      }
    }
  }
  // cab on the outer end of lead/tail cars
  if (isLead) g.add(positionCab(buildCab(1), L / 2));
  if (isTail) g.add(positionCab(buildCab(-1), -L / 2));
  return g;
}

function positionCab(cab, x) {
  cab.position.x = x;
  return cab;
}

function buildTrain() {
  const t = new THREE.Group();
  for (let i = 0; i < NCARS; i++) {
    const car = buildCar(i === 0, i === NCARS - 1);
    car.position.x = -i * (CAR_LEN + 0.6); // lead car (i=0) at the front (+x), rest recede into -x
    t.add(car);
  }
  t.position.z = NEAR_TRACK_Z;
  t.position.y = 0;
  scene.add(t);
  return t;
}

// ---- live data + arrival animation ----
// Normalise station names so the arrivals feed (which suffixes " Rail Station",
// prefixes "London", etc.) matches the route station list (which uses HUB ids
// for central interchanges, so id matching alone fails).
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\brail station\b/g, "")
    .replace(/\blondon\b/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]/g, "");

async function loadData() {
  try {
    const track = await (await fetch("/data/track.json")).json();
    stations = track.stations.sort((a, b) => a.name.localeCompare(b.name));
    const all = await (await fetch("/api/arrivals")).json();
    const withData = new Set(all.map((a) => norm(a.stationName)));

    const sel = document.getElementById("station-select");
    sel.innerHTML = stations
      .map((s) => {
        const has = withData.has(norm(s.name));
        return `<option value="${s.id}">${s.name.replace(" Rail Station", "")}${has ? "" : " (no live data)"}</option>`;
      })
      .join("");

    // default to a station that actually has live arrivals (Paddington if possible)
    const hasArr = (s) => withData.has(norm(s.name));
    const def =
      stations.find((s) => hasArr(s) && /paddington/i.test(s.name)) ||
      stations.find((s) => hasArr(s)) ||
      stations[0];
    sel.value = def.id;
    selected = def;
    sel.onchange = () => {
      selected = stations.find((s) => s.id === sel.value);
      queue = [];
      refreshArrivals();
    };
    applyArrivals(all);
    setInterval(refreshArrivals, 25000);
  } catch (e) {
    console.error("station data load failed", e);
  }
}

async function refreshArrivals() {
  try {
    applyArrivals(await (await fetch("/api/arrivals")).json());
  } catch (e) {
    console.error("arrivals failed", e);
  }
}

function applyArrivals(all) {
  const t = norm(selected.name);
  arrivals = all
    .filter((a) => norm(a.stationName) === t || a.naptanId === selected.id)
    .sort((a, b) => a.timeToStation - b.timeToStation);
  renderBoard();
  queue = arrivals.slice(0, 6).map((a) => ({ eta: a.timeToStation, destination: a.destinationName, platform: a.platformName }));
}

function renderBoard() {
  const el = document.getElementById("board-rows");
  if (!arrivals.length) {
    el.innerHTML = `<div class="muted">No predicted arrivals right now.</div>`;
    return;
  }
  el.innerHTML = arrivals
    .slice(0, 8)
    .map((a) => {
      const m = a.timeToStation < 60 ? `${a.timeToStation}s` : `${Math.round(a.timeToStation / 60)} min`;
      return `<div class="row"><span class="dest">${esc((a.destinationName || "—").replace(" Rail Station", ""))}</span><span class="eta">${m}</span></div>`;
    })
    .join("");
}

// timing of the visible train
const APPROACH_S = 12;
const DWELL_S = 22;
const DEPART_S = 8;
const X_FAR = -150;
const X_OUT = 160;

function updateTrain(dt) {
  // decrement live etas
  for (const q of queue) q.eta -= dt;

  if (trainAnim.phase === "idle") {
    const due = queue.find((q) => q.eta <= APPROACH_S);
    if (due) {
      queue = queue.filter((q) => q !== due);
      if (!trainGroup) trainGroup = buildTrain();
      trainGroup.visible = true;
      trainAnim.phase = "approach";
      trainAnim.t = Math.max(due.eta, 0.5); // seconds until it should reach the stop
      trainAnim.total = trainAnim.t;
      trainAnim.info = due;
      setNowServing(due);
    } else if (trainGroup) {
      trainGroup.visible = false;
    }
    return;
  }

  if (trainAnim.phase === "approach") {
    trainAnim.t -= dt;
    const k = 1 - Math.max(trainAnim.t, 0) / trainAnim.total; // 0..1
    const ease = 1 - Math.pow(1 - k, 2); // decelerate into platform
    trainGroup.position.x = X_FAR + (STOP_X - X_FAR) * ease;
    if (trainAnim.t <= 0) {
      trainAnim.phase = "dwell";
      trainAnim.t = DWELL_S;
    }
    return;
  }

  if (trainAnim.phase === "dwell") {
    trainAnim.t -= dt;
    if (trainAnim.t <= 0) {
      trainAnim.phase = "depart";
      trainAnim.t = DEPART_S;
    }
    return;
  }

  if (trainAnim.phase === "depart") {
    trainAnim.t -= dt;
    const k = 1 - Math.max(trainAnim.t, 0) / DEPART_S;
    const ease = Math.pow(k, 2); // accelerate away
    trainGroup.position.x = STOP_X + (X_OUT - STOP_X) * ease;
    if (trainAnim.t <= 0) {
      trainAnim.phase = "idle";
      trainGroup.visible = false;
    }
  }
}

function setNowServing(info) {
  const el = document.getElementById("board");
  let n = el.querySelector(".serving");
  if (!n) {
    n = document.createElement("div");
    n.className = "serving";
    n.style.cssText = "padding:8px 13px;border-top:1px solid #2a2f36;font-size:12px;color:#c98aff";
    el.appendChild(n);
  }
  n.textContent = `Arriving: ${(info.destination || "").replace(" Rail Station", "")}`;
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  updateTrain(dt);
  controls.update();
  // clock display
  const el = document.getElementById("clock");
  if (el) {
    const d = new Date();
    el.textContent = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  renderer.render(scene, camera);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
