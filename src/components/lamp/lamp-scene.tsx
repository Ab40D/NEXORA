"use client";

/**
 * The SE7ENX pendant lamp — built from primitives (no external model/HDR
 * downloads). Driven entirely by `LampView` from application state.
 */
import { Environment, Lightformer } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { LampView } from "@/lib/state/selectors";

export interface LampSceneProps {
  view: LampView;
  lowPower: boolean;
  reducedMotion: boolean;
  onToggle?: () => void;
  interactive: boolean;
  onContextLost?: () => void;
}

const WARM = new THREE.Color("#ffc98a");
const WARM_HOT = new THREE.Color("#fff1dc");
const OFF_GLASS = new THREE.Color("#b8c6d6");
const CYAN = new THREE.Color("#38d9f5");
const AMBER = new THREE.Color("#f5b84b");

/**
 * Opal-glass globe: fresnel-shaded so it reads as a glass volume.
 * OFF: dark glass with soft rim reflections. ON: warm inner glow, brighter at
 * the centre (where the bulb sits) and falling off towards the rim.
 */
const globeVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const globeFragment = /* glsl */ `
  uniform float uGlow;
  uniform vec3 uWarm;
  uniform vec3 uRim;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float facing = clamp(dot(normalize(vNormal), normalize(vView)), 0.0, 1.0);
    float rim = pow(1.0 - facing, 2.6);
    float core = pow(facing, 1.6);
    vec3 glow = uWarm * uGlow * (0.42 + 1.05 * core);
    vec3 col = glow + uRim * rim * (0.55 - 0.35 * uGlow);
    float alpha = clamp(0.05 + rim * 0.55 + uGlow * (0.55 + 0.35 * core), 0.0, 1.0);
    gl_FragColor = vec4(col, alpha);
  }
`;

function useRadialTexture(inner: string, outer: string) {
  return useMemo(() => {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, inner);
    g.addColorStop(0.35, inner.replace(/[\d.]+\)$/, "0.35)"));
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, [inner, outer]);
}

function Pendant({ view, lowPower, reducedMotion, onToggle, interactive }: Omit<LampSceneProps, "onContextLost">) {
  const group = useRef<THREE.Group>(null);
  const glass = useRef<THREE.MeshPhysicalMaterial>(null);
  const bulbGlass = useRef<THREE.MeshStandardMaterial>(null);
  const globeMat = useRef<THREE.ShaderMaterial>(null);
  const filament = useRef<THREE.MeshBasicMaterial>(null);
  const light = useRef<THREE.PointLight>(null);
  const halo = useRef<THREE.Sprite>(null);
  const pool = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const ringMat = useRef<THREE.MeshBasicMaterial>(null);
  const accent = useRef<THREE.MeshStandardMaterial>(null);
  const glow = useRef(view.intensity);
  const invalidate = useThree((s) => s.invalidate);

  const globeUniforms = useMemo(
    () => ({ uGlow: { value: 0 }, uWarm: { value: new THREE.Color("#ffc78a") }, uRim: { value: new THREE.Color("#9fd8ff") } }),
    [],
  );
  const haloTex = useRadialTexture("rgba(255,214,160,1)", "rgba(255,214,160,0)");
  const poolTex = useRadialTexture("rgba(255,205,150,0.9)", "rgba(255,205,150,0)");

  // Wake the render loop on every state change (frameloop="demand" on low-power devices).
  useEffect(() => {
    invalidate();
  }, [view, invalidate]);

  const shadeProfile = useMemo(() => {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      // slim conical metal cap flaring into the globe collar
      pts.push(new THREE.Vector2(0.07 + Math.pow(t, 2.2) * 0.17, 0.32 - t * 0.32));
    }
    return pts;
  }, []);

  useFrame((state, delta) => {
    const target = view.lit ? view.intensity : 0;
    const lambda = reducedMotion ? 30 : 5;
    glow.current = THREE.MathUtils.damp(glow.current, target, lambda, Math.min(delta, 0.1));
    const g = glow.current;
    const unverified = view.certainty === "assumed" || view.certainty === "observed" || view.certainty === "stale";

    if (light.current) light.current.intensity = g * (lowPower ? 18 : 26);
    const glowUniform = globeMat.current?.uniforms.uGlow;
    if (glowUniform) glowUniform.value = g * (unverified ? 0.75 : 1);
    if (filament.current) filament.current.color.setRGB(0.12 + g * 4.2, 0.07 + g * 2.6, 0.04 + g * 1.1);
    if (bulbGlass.current) {
      bulbGlass.current.emissive.copy(WARM_HOT);
      bulbGlass.current.emissiveIntensity = g * 0.9;
    }
    if (glass.current) {
      glass.current.color.copy(OFF_GLASS).lerp(WARM, g * 0.6);
      glass.current.opacity = 0.16 + g * 0.08;
    }
    if (halo.current) {
      const m = halo.current.material as THREE.SpriteMaterial;
      m.opacity = g * (unverified ? 0.35 : 0.62);
      const s = 2.6 + g * 1.6;
      halo.current.scale.set(s, s, 1);
    }
    if (pool.current) (pool.current.material as THREE.MeshBasicMaterial).opacity = g * (unverified ? 0.35 : 0.7);
    if (accent.current) accent.current.emissiveIntensity = 0.6 + (1 - g) * 0.8;

    // requested-state ring
    if (ring.current && ringMat.current) {
      const show = view.pending !== null || view.feedbackMissing;
      const t = state.clock.elapsedTime;
      const pulse = reducedMotion ? 0.8 : 0.45 + 0.4 * Math.sin(t * 4);
      ringMat.current.color.copy(view.feedbackMissing ? AMBER : CYAN);
      ringMat.current.opacity = THREE.MathUtils.damp(ringMat.current.opacity, show ? pulse : 0, 8, Math.min(delta, 0.1));
      ring.current.rotation.z += reducedMotion ? 0 : delta * 0.8;
    }

    if (group.current && !reducedMotion && !lowPower) {
      const t = state.clock.elapsedTime;
      group.current.rotation.z = Math.sin(t * 0.55) * 0.018;
      group.current.rotation.x = Math.sin(t * 0.4 + 1) * 0.01;
    }

    const settling = Math.abs(glow.current - target) > 0.002 || (ringMat.current?.opacity ?? 0) > 0.01;
    if (settling) invalidate();
  });

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (interactive) onToggle?.();
  };
  const setCursor = (c: string) => () => {
    if (interactive) document.body.style.cursor = c;
  };

  return (
    <group ref={group} position={[0, 1.62, 0]}>
      {/* ceiling canopy */}
      <mesh position={[0, 0.62, 0]}>
        <cylinderGeometry args={[0.26, 0.28, 0.06, 48]} />
        <meshStandardMaterial color="#1a2029" metalness={0.85} roughness={0.35} />
      </mesh>
      {/* cord */}
      <mesh position={[0, -0.05, 0]}>
        <cylinderGeometry args={[0.009, 0.009, 1.32, 12]} />
        <meshStandardMaterial color="#0d1015" roughness={0.6} />
      </mesh>

      <group position={[0, -1.15, 0]} onClick={handleClick} onPointerOver={setCursor("pointer")} onPointerOut={setCursor("auto")}>
        {/* metal cap */}
        <mesh position={[0, 0.5, 0]}>
          <latheGeometry args={[shadeProfile, 64]} />
          <meshStandardMaterial color="#20262f" metalness={0.92} roughness={0.28} side={THREE.DoubleSide} />
        </mesh>
        {/* cyan accent band (SE7ENX signature) */}
        <mesh position={[0, 0.66, 0]}>
          <torusGeometry args={[0.078, 0.008, 12, 64]} />
          <meshStandardMaterial ref={accent} color="#0b2a33" emissive={CYAN} emissiveIntensity={1} toneMapped={false} />
        </mesh>

        {/* glass globe */}
        <mesh position={[0, -0.02, 0]}>
          <sphereGeometry args={[0.56, lowPower ? 40 : 72, lowPower ? 28 : 48]} />
          <meshPhysicalMaterial
            ref={glass}
            color={OFF_GLASS}
            roughness={0.08}
            metalness={0}
            clearcoat={1}
            clearcoatRoughness={0.05}
            transparent
            opacity={0.25}
            envMapIntensity={1.4}
            depthWrite={false}
          />
        </mesh>
        {/* opal glow layer (fresnel shader) */}
        <mesh position={[0, -0.02, 0]} renderOrder={2}>
          <sphereGeometry args={[0.545, lowPower ? 40 : 72, lowPower ? 28 : 48]} />
          <shaderMaterial
            ref={globeMat}
            vertexShader={globeVertex}
            fragmentShader={globeFragment}
            uniforms={globeUniforms}
            transparent
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>

        {/* LED filament bulb */}
        <group position={[0, 0.06, 0]}>
          <mesh position={[0, 0.2, 0]}>
            <cylinderGeometry args={[0.035, 0.045, 0.1, 24]} />
            <meshStandardMaterial color="#2b313a" metalness={0.9} roughness={0.3} />
          </mesh>
          <mesh scale={[1, 1.35, 1]} renderOrder={1}>
            <sphereGeometry args={[0.105, 32, 24]} />
            <meshStandardMaterial ref={bulbGlass} color="#3a4350" transparent opacity={0.35} roughness={0.15} depthWrite={false} emissive={WARM_HOT} emissiveIntensity={0} />
          </mesh>
          <mesh rotation={[0, 0, 0]}>
            <torusKnotGeometry args={[0.042, 0.005, 120, 8, 2, 7]} />
            <meshBasicMaterial ref={filament} color="#331a0a" toneMapped={false} />
          </mesh>
        </group>
        <pointLight ref={light} position={[0, -0.05, 0]} color="#ffd2a1" intensity={0} distance={14} decay={2} />

        {/* soft halo */}
        <sprite ref={halo} position={[0, -0.02, 0.05]} scale={[2.6, 2.6, 1]}>
          <spriteMaterial map={haloTex} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
        </sprite>

        {/* requested-state ring */}
        <mesh ref={ring} position={[0, -0.02, 0]}>
          <torusGeometry args={[0.74, 0.008, 8, 128, Math.PI * 1.6]} />
          <meshBasicMaterial ref={ringMat} color={CYAN} transparent opacity={0} toneMapped={false} depthWrite={false} />
        </mesh>
      </group>

      {/* light pool on the floor */}
      <mesh ref={pool} position={[0, -3.34, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[5.5, 5.5]} />
        <meshBasicMaterial map={poolTex} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>
    </group>
  );
}

function Floor() {
  return (
    <mesh position={[0, -1.73, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <circleGeometry args={[9, 64]} />
      <meshStandardMaterial color="#0c1016" roughness={0.75} metalness={0.2} />
    </mesh>
  );
}

/**
 * Frames the lamp so the globe sits below the state label: lower on portrait
 * screens, with subtle pointer parallax on capable desktop devices.
 */
function CameraRig({ parallax }: { parallax: boolean }) {
  const size = useThree((s) => s.size);
  const get = useThree((s) => s.get);
  const aspect = size.width / Math.max(1, size.height);
  const lookY = aspect < 0.85 ? 0.82 : aspect < 1.15 ? 0.7 : 0.6;
  const distance = aspect < 0.85 ? 5.4 : 4.7;
  useEffect(() => {
    const { camera, invalidate } = get();
    camera.position.set(0, lookY + 0.05, distance);
    camera.lookAt(0, lookY, 0);
    invalidate();
  }, [get, lookY, distance]);
  useFrame((state, delta) => {
    if (!parallax) return;
    const { camera, pointer } = state;
    camera.position.x = THREE.MathUtils.damp(camera.position.x, pointer.x * 0.3, 2, delta);
    camera.position.y = THREE.MathUtils.damp(camera.position.y, lookY + 0.05 + pointer.y * 0.12, 2, delta);
    camera.lookAt(0, lookY, 0);
  });
  return null;
}

export default function LampScene(props: LampSceneProps) {
  const { lowPower, reducedMotion, onContextLost } = props;
  const bloom = !lowPower;
  return (
    <Canvas
      dpr={lowPower ? [1, 1.5] : [1, 2]}
      camera={{ position: [0, 0.3, 4.7], fov: 34, near: 0.1, far: 40 }}
      gl={{ antialias: !lowPower, alpha: true, powerPreference: lowPower ? "low-power" : "high-performance" }}
      frameloop={lowPower || reducedMotion ? "demand" : "always"}
      onCreated={({ gl, camera }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.05;
        camera.lookAt(0, 0.6, 0);
        gl.domElement.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          onContextLost?.();
        });
      }}
      aria-hidden
    >
      <fog attach="fog" args={["#06080b", 7, 16]} />
      <ambientLight intensity={0.12} />
      <directionalLight position={[-4, 5, 3]} intensity={0.25} color="#9fc7ff" />
      <Environment resolution={lowPower ? 32 : 128} frames={1}>
        <Lightformer form="rect" intensity={1.6} color="#7cc8ff" position={[-5, 2, -2]} scale={[6, 2, 1]} />
        <Lightformer form="rect" intensity={0.8} color="#38d9f5" position={[5, 1, 2]} scale={[4, 1.2, 1]} />
        <Lightformer form="ring" intensity={0.6} color="#ffffff" position={[0, 6, 3]} scale={3} />
      </Environment>
      <Pendant {...props} />
      <Floor />
      <CameraRig parallax={!lowPower && !reducedMotion} />
      {bloom ? (
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={0.75} luminanceThreshold={0.82} luminanceSmoothing={0.2} />
          <Vignette eskil={false} offset={0.25} darkness={0.7} />
        </EffectComposer>
      ) : (
        <></>
      )}
    </Canvas>
  );
}
