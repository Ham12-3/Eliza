"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Html } from "@react-three/drei";
import * as THREE from "three";
import { buildTrackModel } from "@/lib/track";
import { makeProjection } from "@/lib/projection";
import { groupTrains, deriveSegmentTimes, placeTrains } from "@/lib/interpolation";

const TUBE_R = 32;
const TRAIN_Y = 22;
const TRAIN_SCALE = 1.5;

export default function NetworkSim() {
  const [model, setModel] = useState(null);
  const [proj, setProj] = useState(null);
  const [bounds, setBounds] = useState(null);
  const [stationList, setStationList] = useState([]);
  const flyRef = useRef(null);

  useEffect(() => {
    fetch("/data/track.json")
      .then((r) => r.json())
      .then((json) => {
        const m = buildTrackModel(json);
        const p = makeProjection(json.stations);
        let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
        for (const s of json.stations) {
          const x = p.x(s.lon), z = p.z(s.lat);
          minx = Math.min(minx, x); maxx = Math.max(maxx, x);
          minz = Math.min(minz, z); maxz = Math.max(maxz, z);
        }
        const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2;
        const span = Math.max(maxx - minx, maxz - minz);
        setProj(() => p);
        setModel(m);
        setBounds({ cx, cz, span });
        setStationList([...json.stations].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch((e) => console.error("track load failed", e));
  }, []);

  const { trainsRef, ids, board } = useLiveTrains(model);

  const flyTo = (id) => {
    const s = stationList.find((x) => x.id === id);
    if (!s || !proj) return;
    flyRef.current = { x: proj.x(s.lon), z: proj.z(s.lat) };
  };

  return (
    <>
      <Bar stations={stationList} onFly={flyTo} board={board} stationCount={model?.stations.size ?? 0} />
      <Board board={board} stationCount={model?.stations.size ?? 0} />
      <div className="hint">
        Drag to orbit · scroll to zoom · pick a station to fly to it. The whole line is laid out
        from real station coordinates and OpenStreetMap track; trains move from live TfL predictions.
      </div>
      {!model && <div className="loading">Building network…</div>}

      <div className="scene">
        {bounds && (
          <Canvas
            camera={{ position: [bounds.cx + bounds.span * 0.05, bounds.span * 0.3, bounds.cz + bounds.span * 0.34], fov: 55, near: 1, far: 400000 }}
            gl={{ antialias: true }}
          >
            <color attach="background" args={["#0b0d12"]} />
            <fog attach="fog" args={["#0b0d12", 30000, 130000]} />
            <hemisphereLight args={["#9fb4cc", "#202428", 1.0]} />
            <directionalLight position={[8000, 16000, 6000]} intensity={1.0} />
            <gridHelper args={[bounds.span * 1.6, 60, "#1a2030", "#141a26"]} position={[bounds.cx, 0, bounds.cz]} />
            {model && proj && (
              <>
                <Track model={model} proj={proj} />
                <Stations stations={stationList} proj={proj} />
                <Trains ids={ids} trainsRef={trainsRef} model={model} proj={proj} />
              </>
            )}
            <Rig bounds={bounds} flyRef={flyRef} />
          </Canvas>
        )}
      </div>
    </>
  );
}

// ---- live data hook (same engine as the map) ----
function useLiveTrains(model) {
  const trainsRef = useRef(new Map());
  const [ids, setIds] = useState([]);
  const [board, setBoard] = useState(null);

  useEffect(() => {
    if (!model) return;
    let alive = true;
    async function poll() {
      try {
        const [arr, status] = await Promise.all([
          fetch("/api/arrivals").then((r) => r.json()),
          fetch("/api/status").then((r) => r.json()),
        ]);
        if (!alive) return;
        const { trains } = groupTrains(arr);
        const seg = deriveSegmentTimes(trains, model);
        const { placed, hidden } = placeTrains(trains, model, seg);
        const m = trainsRef.current;
        const seen = new Set();
        for (const t of placed) {
          seen.add(t.id);
          const corridor = model.corridors.find((c) => c.id === t.corridorId);
          if (!corridor) continue;
          let st = m.get(t.id);
          if (!st) st = { corridor, simArc: t.arc, speed: t.speed, meta: t }, m.set(t.id, st);
          else if (st.corridor.id !== corridor.id) { st.corridor = corridor; st.simArc = t.arc; }
          else st.simArc += (t.arc - st.simArc) * 0.4;
          st.speed = t.speed;
          st.meta = t;
        }
        for (const id of [...m.keys()]) if (!seen.has(id)) m.delete(id);
        setIds([...m.keys()]);
        const s = status?.[0]?.lineStatuses?.[0];
        setBoard({ shown: placed.length, hidden, status: s?.statusSeverityDescription || "—" });
      } catch (e) {
        console.error("poll failed", e);
      }
    }
    poll();
    const iv = setInterval(poll, 25000);
    return () => { alive = false; clearInterval(iv); };
  }, [model]);

  return { trainsRef, ids, board };
}

// ---- track tubes ----
function Track({ model, proj }) {
  const geos = useMemo(() => {
    return model.corridors.map((c) => {
      const pts = c.coords.map(([la, lo]) => new THREE.Vector3(proj.x(lo), 6, proj.z(la)));
      const curve = new THREE.CatmullRomCurve3(pts);
      return new THREE.TubeGeometry(curve, Math.min(pts.length, 700), TUBE_R, 6, false);
    });
  }, [model, proj]);
  return (
    <>
      {geos.map((g, i) => (
        <mesh key={i} geometry={g}>
          <meshStandardMaterial color="#bd74e6" emissive="#7b3fb0" emissiveIntensity={1.1} roughness={0.5} />
        </mesh>
      ))}
    </>
  );
}

// ---- stations ----
function Stations({ stations, proj }) {
  return (
    <>
      {stations.map((s) => {
        const x = proj.x(s.lon), z = proj.z(s.lat);
        return (
          <group key={s.id} position={[x, 0, z]}>
            <mesh position={[0, 8, 0]}>
              <boxGeometry args={[200, 16, 80]} />
              <meshStandardMaterial color="#444b56" roughness={0.9} />
            </mesh>
            <mesh position={[0, 48, 0]}>
              <cylinderGeometry args={[46, 46, 80, 16]} />
              <meshStandardMaterial color="#f0f1f3" emissive="#a07fd0" emissiveIntensity={0.7} />
            </mesh>
            <Html position={[0, 200, 0]} center distanceFactor={1600} occlude={false} zIndexRange={[5, 0]}>
              <div className="stn-label">{s.name.replace(" Rail Station", "")}</div>
            </Html>
          </group>
        );
      })}
    </>
  );
}

// ---- trains ----
function Trains({ ids, trainsRef, model, proj }) {
  return (
    <>
      {ids.map((id) => (
        <Train key={id} id={id} trainsRef={trainsRef} model={model} proj={proj} />
      ))}
    </>
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
  return (
    <group ref={ref} scale={TRAIN_SCALE}>
      {[0, 1, 2, 3].map((i) => {
        const carL = 95, gap = 12, x = -i * (carL + gap);
        return (
          <group key={i} position={[x, 0, 0]}>
            <mesh><boxGeometry args={[carL, 30, 38]} /><meshStandardMaterial color="#e8e9ec" roughness={0.45} metalness={0.1} /></mesh>
            <mesh position={[0, 6, 0]}><boxGeometry args={[carL * 0.9, 11, 40]} /><meshStandardMaterial color="#0e1014" roughness={0.2} metalness={0.6} /></mesh>
            <mesh position={[-carL / 3, -1, 0]}><boxGeometry args={[14, 22, 41]} /><meshStandardMaterial color="#6c3fa0" /></mesh>
            <mesh position={[carL / 3, -1, 0]}><boxGeometry args={[14, 22, 41]} /><meshStandardMaterial color="#6c3fa0" /></mesh>
            {i === 0 && (
              <mesh position={[carL / 2 + 10, 0, 0]}><boxGeometry args={[28, 26, 36]} /><meshStandardMaterial color="#16181d" roughness={0.3} metalness={0.4} /></mesh>
            )}
          </group>
        );
      })}
    </group>
  );
}

// ---- camera controls + fly-to + label distance fade ----
function Rig({ bounds, flyRef }) {
  const controls = useRef();
  const { camera } = useThree();
  useFrame(() => {
    // fly-to tween
    if (flyRef.current && controls.current) {
      const { x, z } = flyRef.current;
      const tgt = new THREE.Vector3(x, 40, z);
      const cam = new THREE.Vector3(x + 500, 700, z + 900);
      controls.current.target.lerp(tgt, 0.08);
      camera.position.lerp(cam, 0.08);
      controls.current.update();
      if (camera.position.distanceTo(cam) < 30) flyRef.current = null;
    }
  });
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      maxPolarAngle={Math.PI * 0.49}
      minDistance={200}
      maxDistance={160000}
      target={[bounds.cx, 0, bounds.cz]}
    />
  );
}

// ---- DOM overlay ----
function Bar({ stations, onFly }) {
  const [now, setNow] = useState("--:--");
  useEffect(() => {
    const iv = setInterval(() => setNow(new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })), 1000);
    return () => clearInterval(iv);
  }, []);
  return (
    <header className="bar">
      <div className="brand"><span className="dot" /><h1>Elizabeth line — live 3D simulation</h1></div>
      <label className="picker">
        Fly to
        <select defaultValue="" onChange={(e) => onFly(e.target.value)}>
          <option value="">—</option>
          {stations.map((s) => (
            <option key={s.id} value={s.id}>{s.name.replace(" Rail Station", "")}</option>
          ))}
        </select>
      </label>
      <div className="spacer" />
      <div className="clock">{now}</div>
      <a className="navlink" href="/photoreal">photoreal ↗</a>
    </header>
  );
}

function Board({ board, stationCount }) {
  return (
    <aside className="board">
      <div className="board-title">Network</div>
      <div className="row"><span>Status</span><span className="v">{board?.status ?? "…"}</span></div>
      <div className="row"><span>Trains moving</span><span className="v">{board?.shown ?? 0}</span></div>
      <div className="row"><span>Too far to place</span><span className="v">{board?.hidden ?? 0}</span></div>
      <div className="row"><span>Stations</span><span className="v">{stationCount}</span></div>
    </aside>
  );
}
