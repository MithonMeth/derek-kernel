/**
 * The machine in the hero slot. Loads after first paint and quietly replaces
 * the line-art placeholder; if WebGL is missing or anything fails to load,
 * the placeholder simply stays, which is a perfectly good picture of a
 * typewriter. Nothing on this page depends on the 3D working.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const MODEL_URL = "/models/typewriter.glb";
const SPIN_RATE = 0.13;          // radians/sec at idle
const START_AZIMUTH = -0.42;     // three-quarter view rather than dead-on
const ELEVATION = 0.35;          // looking down far enough to read the keys
const PADDING = 1.06;            // breathing room inside the dashed slot
const DRAG_SENSITIVITY = 0.011;

export function mountHeroModel(slot) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const renderer = makeRenderer();
  if (!renderer) return; // no WebGL — the SVG stays

  const canvas = renderer.domElement;
  canvas.className = "asset__canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "A 3D model of an IBM Selectric II typewriter. Drag to turn it.");
  canvas.tabIndex = 0;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 1000);
  const turntable = new THREE.Group();
  scene.add(turntable);
  addLights(scene);

  let azimuth = START_AZIMUTH;
  // Bounds of the loaded model, in its own units. A typewriter is wide and
  // flat, so a bounding sphere would waste most of the frame on empty air.
  let fitRadius = 1;
  let fitHalfHeight = 1;
  let spinning = !reduce;
  let needsRender = true;
  let running = false;
  let rafId = 0;
  let lastFrame = 0;

  function resize() {
    const rect = slot.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    frameCamera();
    needsRender = true;
  }

  /**
   * Bound the model by a cylinder — radius across the turntable plane, height
   * up the spin axis — so one distance frames it at every angle without
   * clipping, and without the slack a sphere leaves around a flat object.
   */
  function frameCamera() {
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    // Tilting the camera down turns some of the footprint into apparent height.
    const halfHeight =
      fitRadius * Math.sin(ELEVATION) + fitHalfHeight * Math.cos(ELEVATION);
    const distance =
      Math.max(halfHeight / Math.tan(vFov / 2), fitRadius / Math.tan(hFov / 2)) * PADDING;

    camera.near = Math.max(distance / 100, 0.01);
    camera.far = distance * 100;
    camera.position.set(
      Math.sin(azimuth) * Math.cos(ELEVATION) * distance,
      Math.sin(ELEVATION) * distance,
      Math.cos(azimuth) * Math.cos(ELEVATION) * distance
    );
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }

  function renderFrame(now) {
    rafId = 0;
    if (spinning) {
      const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.1) : 0;
      azimuth += SPIN_RATE * dt;
      needsRender = true;
    }
    lastFrame = now;
    if (needsRender) {
      needsRender = false;
      frameCamera();
      renderer.render(scene, camera);
    }
    if (running) rafId = requestAnimationFrame(renderFrame);
  }

  function start() {
    if (running) return;
    running = true;
    lastFrame = 0;
    rafId = requestAnimationFrame(renderFrame);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  /* ---------- drag to turn ---------- */
  let pointerId = null;
  let lastX = 0;

  canvas.addEventListener("pointerdown", (ev) => {
    pointerId = ev.pointerId;
    lastX = ev.clientX;
    spinning = false;
    canvas.setPointerCapture(pointerId);
    canvas.classList.add("is-grabbing");
  });

  canvas.addEventListener("pointermove", (ev) => {
    if (ev.pointerId !== pointerId) return;
    azimuth -= (ev.clientX - lastX) * DRAG_SENSITIVITY;
    lastX = ev.clientX;
    needsRender = true;
    start();
  });

  function endDrag(ev) {
    if (ev.pointerId !== pointerId) return;
    canvas.releasePointerCapture(pointerId);
    pointerId = null;
    canvas.classList.remove("is-grabbing");
    // Idle spin resumes unless the visitor asked for less motion.
    spinning = !reduce;
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  canvas.addEventListener("keydown", (ev) => {
    const step = ev.key === "ArrowLeft" ? -0.22 : ev.key === "ArrowRight" ? 0.22 : 0;
    if (!step) return;
    ev.preventDefault();
    azimuth += step;
    spinning = false;
    needsRender = true;
    start();
  });

  /* ---------- only run while it can be seen ---------- */
  let onScreen = true;
  const io = new IntersectionObserver(
    (entries) => {
      onScreen = entries[0].isIntersecting;
      updateRunning();
    },
    { threshold: 0.01 }
  );
  io.observe(slot);

  document.addEventListener("visibilitychange", updateRunning);

  function updateRunning() {
    // A still frame needs no loop; only spin costs anything.
    if (onScreen && !document.hidden && (spinning || pointerId !== null)) start();
    else stop();
  }

  const ro = new ResizeObserver(() => {
    resize();
    if (!running) renderer.render(scene, camera);
  });
  ro.observe(slot);

  new GLTFLoader()
    .loadAsync(MODEL_URL)
    .then((gltf) => {
      const model = gltf.scene;

      // Centre the model on the turntable axis and measure it. Everything
      // downstream works in the model's own units, so no assumption is made
      // about the scale or orientation it was exported at.
      const box = new THREE.Box3().setFromObject(model);
      const centre = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      model.position.sub(centre);
      fitRadius = Math.hypot(size.x / 2, size.z / 2) || 1;
      fitHalfHeight = size.y / 2 || 1;

      turntable.add(model);
      slot.appendChild(canvas);
      slot.classList.add("is-3d");
      resize();
      renderer.render(scene, camera);
      updateRunning();
    })
    .catch(() => {
      // Placeholder stays. Nothing to announce.
      io.disconnect();
      ro.disconnect();
      renderer.dispose();
    });
}

function makeRenderer() {
  try {
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "low-power"
    });
    renderer.setClearAlpha(0);
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.15;
    return renderer;
  } catch {
    return null;
  }
}

/** Warm office light, not a product showroom. */
function addLights(scene) {
  scene.add(new THREE.HemisphereLight(0xf3f1e4, 0x6d7360, 1.5));

  const key = new THREE.DirectionalLight(0xfff6e2, 2.6);
  key.position.set(-2.4, 3.2, 3.4);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xdfe6f0, 0.9);
  fill.position.set(3.4, 0.6, 1.8);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffffff, 1.4);
  rim.position.set(1.2, 2.0, -3.6);
  scene.add(rim);
}
