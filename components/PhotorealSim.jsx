"use client";

// Photorealistic mode: Google Photorealistic 3D Tiles (real textured 3D London)
// with the live, calculated trains overlaid on the real track via an
// East-North-Up frame. Requires NEXT_PUBLIC_GOOGLE_MAPS_API_KEY (Map Tiles API
// + billing). Falls back to a setup card when the key is absent.

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { TilesRenderer, TilesPlugin, GlobeControls, TilesAttributionOverlay, EastNorthUpFrame } from "3d-tiles-renderer/r3f";
import { GoogleCloudAuthPlugin } from "3d-tiles-renderer/plugins";
import { buildTrackModel } from "@/lib/track";
import { makeProjection } from "@/lib/projection";
import { groupTrains, deriveSegmentTimes, placeTrains } from "@/lib/interpolation";

const KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
const DEG = Math.PI / 180;
const TUBE_R = 4;          // metres (real scale now — we're on the real globe)
const TRAIN_Y = 6;         // metres above the ENU frame origin
const FRAME_HEIGHT = 95;   // lift the overlay above rooftops so it reads on the city
                           // (central Elizabeth line is really in tunnels; this is a
                           // visible "data layer" above the photoreal ground)
// Where to point the opening shot: the City of London (dense towers, on the line).
const TARGET = { lat: 51.5155, lon: -0.0865 };

// WGS84 ECEF for a sensible initial camera over the network.
function ecef(latDeg, lonDeg, h) {
  const a = 6378137, e2 = 0.00669437999;
  const lat = latDeg * DEG, lon = lonDeg * DEG;
  const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [
    (N + h) * Math.cos(lat) * Math.cos(lon),
    (N + h) * Math.cos(lat) * Math.sin(lon),
    (N * (1 - e2) + h) * Math.sin(lat),
  ];
}

export default function PhotorealSim() {
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!KEY) return;
    fetch("/data/track.json")
      .then((r) => r.json())
      .then((json) => {
        let lat = 0, lon = 0;
        for (const s of json.stations) { lat += s.lat; lon += s.lon; }
        lat /= json.stations.length; lon /= json.stations.length;
        setData({ model: buildTrackModel(json), proj: makeProjection(json.stations), stations: json.stations, lat, lon });
      })
      .catch((e) => console.error("track load failed", e));
  }, []);

  if (!KEY) return <KeyGate />;
  if (!data) {
    return (
      <>
        <Header />
        <div className="loading">Loading photoreal London…</div>
      </>
    );
  }

  // Opening shot: above the City looking straight down (nadir). lookAt(0,0,0)
  // is Earth-centre, i.e. straight down from directly overhead. Tilt with drag.
  const cam = ecef(TARGET.lat, TARGET.lon, 950);

  return (
    <>
      <Header />
      <div className="scene">
        <Canvas
          camera={{ position: cam, near: 1, far: 1e9, fov: 60 }}
          gl={{ antialias: true, logarithmicDepthBuffer: true }}
          onCreated={({ camera }) => camera.lookAt(0, 0, 0)}
        >
          <hemisphereLight args={["#cfe0ef", "#33373d", 1.1]} />
          <directionalLight position={ecef(data?.lat ?? 51.5, data?.lon ?? -0.1, 200000)} intensity={1.2} />
          <TilesRenderer key={KEY}>
            <TilesPlugin plugin={GoogleCloudAuthPlugin} args={{ apiToken: KEY, autoRefreshToken: true }} />
            <GlobeControls enableDamping />
            <TilesAttributionOverlay />
            {data && (
              <EastNorthUpFrame lat={data.lat * DEG} lon={data.lon * DEG} height={FRAME_HEIGHT}>
                {/* our scene is Y-up; ENU is Z-up, so rotate +90° about X */}
                <group rotation={[Math.PI / 2, 0, 0]}>
                  <Overlay data={data} />
                </group>
              </EastNorthUpFrame>
            )}
          </TilesRenderer>
        </Canvas>
      </div>
    </>
  );
}

// ---- the live overlay (track + stations + moving trains), real scale ----
function Overlay({ data }) {
  const { model, proj, stations } = data;
  const { trainsRef, ids } = useLiveTrains(model);
  return (
    <>
      {model.corridors.map((c, i) => (
        <TrackTube key={i} corridor={c} proj={proj} />
      ))}
      {stations.map((s) => (
        <mesh key={s.id} position={[proj.x(s.lon), 18, proj.z(s.lat)]}>
          <cylinderGeometry args={[3, 3, 36, 8]} />
          <meshStandardMaterial color="#e6e8ea" emissive="#a07fd0" emissiveIntensity={0.5} />
        </mesh>
      ))}
      {ids.map((id) => (
        <Train key={id} id={id} trainsRef={trainsRef} model={model} proj={proj} />
      ))}
    </>
  );
}

function TrackTube({ corridor, proj }) {
  const geo = useMemo(() => {
    const pts = corridor.coords.map(([la, lo]) => new THREE.Vector3(proj.x(lo), 2, proj.z(la)));
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.min(pts.length, 700), TUBE_R, 6, false);
  }, [corridor, proj]);
  return (
    <mesh geometry={geo}>
      <meshStandardMaterial color="#bd74e6" emissive="#7b3fb0" emissiveIntensity={0.9} roughness={0.5} />
    </mesh>
  );
}

function Train({ id, trainsRef, model, proj }) {
  const ref = useRef();
  useFrame((_, dt) => {
    const st = trainsRef.current.get(id);
    if (!st || !ref.current) return;
    st.simArc += st.speed * Math.min(dt, 0.1);
    const p = model.posAt(st.corridor, st.simArc);
    ref.current.position.set(proj.x(p.lon), TRAIN_Y, proj.z(p.lat));
    ref.current.rotation.y = ((90 - p.bearing) * Math.PI) / 180;
  });
  const carL = 22, gap = 1.5;
  // exaggerated a little so trains read as moving markers from city-overview height
  return (
    <group ref={ref} scale={3}>
      {[0, 1, 2, 3].map((i) => {
        const x = -i * (carL + gap);
        return (
          <group key={i} position={[x, 0, 0]}>
            <mesh><boxGeometry args={[carL, 3.7, 2.8]} /><meshStandardMaterial color="#e8e9ec" roughness={0.45} metalness={0.1} /></mesh>
            <mesh position={[0, 0.8, 0]}><boxGeometry args={[carL * 0.9, 1.2, 2.84]} /><meshStandardMaterial color="#0e1014" roughness={0.2} metalness={0.6} /></mesh>
            <mesh position={[-carL / 3, -0.1, 0]}><boxGeometry args={[1.4, 2.4, 2.86]} /><meshStandardMaterial color="#6c3fa0" /></mesh>
            <mesh position={[carL / 3, -0.1, 0]}><boxGeometry args={[1.4, 2.4, 2.86]} /><meshStandardMaterial color="#6c3fa0" /></mesh>
            {i === 0 && <mesh position={[carL / 2 + 1, 0, 0]}><boxGeometry args={[2.6, 3.2, 2.7]} /><meshStandardMaterial color="#16181d" roughness={0.3} metalness={0.4} /></mesh>}
          </group>
        );
      })}
    </group>
  );
}

function useLiveTrains(model) {
  const trainsRef = useRef(new Map());
  const [ids, setIds] = useState([]);
  useEffect(() => {
    if (!model) return;
    let alive = true;
    async function poll() {
      try {
        const arr = await (await fetch("/api/arrivals")).json();
        if (!alive) return;
        const { trains } = groupTrains(arr);
        const seg = deriveSegmentTimes(trains, model);
        const { placed } = placeTrains(trains, model, seg);
        const m = trainsRef.current;
        const seen = new Set();
        for (const t of placed) {
          seen.add(t.id);
          const corridor = model.corridors.find((c) => c.id === t.corridorId);
          if (!corridor) continue;
          let st = m.get(t.id);
          if (!st) st = { corridor, simArc: t.arc, speed: t.speed }, m.set(t.id, st);
          else if (st.corridor.id !== corridor.id) { st.corridor = corridor; st.simArc = t.arc; }
          else st.simArc += (t.arc - st.simArc) * 0.4;
          st.speed = t.speed;
        }
        for (const id of [...m.keys()]) if (!seen.has(id)) m.delete(id);
        setIds([...m.keys()]);
      } catch (e) { console.error("poll failed", e); }
    }
    poll();
    const iv = setInterval(poll, 25000);
    return () => { alive = false; clearInterval(iv); };
  }, [model]);
  return { trainsRef, ids };
}

function Header() {
  return (
    <header className="bar">
      <div className="brand"><span className="dot" /><h1>Elizabeth line — photoreal (beta)</h1></div>
      <div className="spacer" />
      <a className="navlink" href="/">← network view</a>
    </header>
  );
}

function KeyGate() {
  return (
    <div className="loading" style={{ flexDirection: "column", gap: 14, textAlign: "center", padding: 24 }}>
      <div style={{ fontSize: 18, color: "#e6e8ea", fontWeight: 600 }}>Photorealistic 3D needs a Google Maps key</div>
      <div style={{ maxWidth: 560, lineHeight: 1.5 }}>
        Create an API key in Google Cloud Console with the <b>Map Tiles API</b> enabled and billing on,
        then add it to <code>.env.local</code> as:
        <pre style={{ background: "#1b1f24", padding: "10px 12px", borderRadius: 8, marginTop: 10, color: "#c98aff", overflow: "auto" }}>
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=your_key_here</pre>
        Restart <code>npm run dev</code> and reload. Restrict the key by HTTP referrer (it ships to the browser).
      </div>
      <a className="navlink" href="/" style={{ marginTop: 8 }}>← back to the network view</a>
    </div>
  );
}
