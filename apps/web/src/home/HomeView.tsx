import { useEffect, useRef } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

/**
 * 启动首页（汐语灵境）：纯黑底上一条发光贝塞尔波浪横贯左右，
 * 20~30 条垂直玻璃窄条把它折射成带彩色镶边的碎片；克制的 Bloom 只让
 * 最亮的核发光。配色为灵境主题：冰白核 → 汐青 → 深汐蓝 → 黑。
 * 前景文字只是配角；4~6 个十字准星节点带反向视差。
 */

const FRAGMENT = /* glsl */ `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform float uFade;

float bez(float t, vec4 c) {
  float u = 1.0 - t;
  return u * u * u * c.x + 3.0 * u * u * t * c.y + 3.0 * u * t * t * c.z + t * t * t * c.w;
}
float bezD(float t, vec4 c) {
  float u = 1.0 - t;
  return 3.0 * u * u * (c.y - c.x) + 6.0 * u * t * (c.z - c.y) + 3.0 * t * t * (c.w - c.z);
}

// 波浪 y(t)：控制点 y 由多组错拍正弦（0.27~0.41）驱动，缓缓起伏如呼吸；
// 光标附近的高斯权重把曲线 y 拉向光标。
float curveY(float t, float idx, float mx, float my) {
  float x = bez(t, vec4(0.0, 0.38, 0.72, 1.0));
  float base = idx < 0.5 ? 0.53 : 0.44;
  float amp = idx < 0.5 ? 0.100 : 0.060;
  float ph = idx < 0.5 ? 0.0 : 2.4;
  float y = base
    + amp * 0.55 * sin(uTime * 0.31 + ph + 1.2)
    + amp * 0.30 * sin(uTime * 0.41 + ph + 3.9)
    + amp * 0.15 * sin(uTime * 0.27 + ph + 5.1);
  y += exp(-pow((x - mx) * 4.5, 2.0)) * (my - y) * 0.38;
  return y;
}

// 牛顿法：由像素 x 反解一次贝塞尔参数 t（x 控制点单调，导数有下界）。
float invert(float px) {
  vec4 cx = vec4(0.0, 0.38, 0.72, 1.0);
  float t = clamp(px, 0.0, 1.0);
  for (int i = 0; i < 4; i++) {
    float x = bez(t, cx);
    float d = max(bezD(t, cx), 0.35);
    t = clamp(t - (x - px) / d, 0.0, 1.0);
  }
  return t;
}

// 灵境配色梯：冰白核 → 汐青 → 深汐蓝 → 黑
vec3 ramp(float e) {
  vec3 c0 = vec3(0.88, 0.98, 1.00);
  vec3 c1 = vec3(0.12, 0.50, 0.68);
  vec3 c2 = vec3(0.02, 0.14, 0.32);
  vec3 col = vec3(0.0);
  col = mix(col, c2, smoothstep(0.0, 0.10, e));
  col = mix(col, c1, smoothstep(0.10, 0.55, e));
  col = mix(col, c0, smoothstep(0.68, 0.95, e));
  return col;
}

// 到最近一条波浪的有符号距离 → 亮度的核（exp(-d²·k)，k≈1200）与贴边微光（k=300·0.3）
vec2 waveEmission(vec2 uv, float mx, float my) {
  float t = invert(uv.x);
  float ya = curveY(t, 0.0, mx, my);
  float yb = curveY(t, 1.0, mx, my);
  float da = abs(uv.y - ya);
  float db = abs(uv.y - yb);
  // 主曲线满亮度，次曲线只做低强度伴生微光，画面才有主次
  float ea = exp(-da * da * 4200.0) + exp(-da * da * 300.0) * 0.12;
  float eb = (exp(-db * db * 4200.0) + exp(-db * db * 300.0) * 0.12) * 0.22;
  float d = min(da, db);
  return vec2(ea + eb, d);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;

  // 玻璃窄条：floor() 量化成离散条带，条内偏移恒定、条间跳变
  float strips = 26.0;
  float stripId = floor(uv.x * strips);
  float inStrip = fract(uv.x * strips);
  float rnd = fract(sin(stripId * 12.9898) * 43758.5453);
  float gauss = exp(-pow((uv.x - uMouse.x) * 4.0, 2.0));
  float refr = (rnd - 0.5) * 0.020 * (0.40 + 1.60 * gauss);

  // 三通道不同折射倍率（0.78 / 1.00 / 1.30）→ 条边彩色镶边
  vec2 wR = waveEmission(uv + vec2(refr * 0.78, 0.0), uMouse.x, uMouse.y);
  vec2 wG = waveEmission(uv + vec2(refr * 1.00, 0.0), uMouse.x, uMouse.y);
  vec2 wB = waveEmission(uv + vec2(refr * 1.30, 0.0), uMouse.x, uMouse.y);
  float dmin = min(wR.y, min(wG.y, wB.y));
  float eR = wR.x * (1.0 + 0.7 * gauss);
  float eG = wG.x * (1.0 + 0.7 * gauss);
  float eB = wB.x * (1.0 + 0.7 * gauss);

  // 两端淡入黑暗：曲线横贯左右边缘前，亮度先收进夜色
  float endFade = smoothstep(0.0, 0.12, uv.x) * smoothstep(1.0, 0.88, uv.x);
  vec3 col = vec3(ramp(eR * endFade).r, ramp(eG * endFade).g, ramp(eB * endFade).b);

  // 条边细高光（不能亮到喧宾夺主）
  float edge = min(inStrip, 1.0 - inStrip);
  col += exp(-edge * 46.0) * vec3(0.05, 0.08, 0.11) * (0.25 + 0.75 * gauss) * exp(-dmin * dmin * 60.0);

  col *= uFade;
  gl_FragColor = vec4(col, 1.0);
}
`;

const NODES = [
  { zh: "证据链", en: "EVIDENCE CHAIN", x: 13, y: 24, depth: 1.4 },
  { zh: "汐潮推演", en: "AGENT RUN", x: 77, y: 20, depth: 0.9 },
  { zh: "溯源", en: "PROVENANCE", x: 84, y: 66, depth: 1.2 },
  { zh: "科研画布", en: "CANVAS", x: 9, y: 74, depth: 0.8 },
  { zh: "灵境", en: "LINGJING REALM", x: 60, y: 82, depth: 1.0 },
];

const reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function HomeView({ onEnter }: { onEnter: (view: "chat" | "canvas" | "wiki" | "papers") => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const uniforms = {
      uRes: { value: new THREE.Vector2(host.clientWidth * renderer.getPixelRatio(), host.clientHeight * renderer.getPixelRatio()) },
      uTime: { value: reducedMotion ? 12.0 : 0.0 },
      uMouse: { value: new THREE.Vector2(0.5, 0.5) },
      uFade: { value: reducedMotion ? 1.0 : 0.0 },
    };
    const material = new THREE.ShaderMaterial({ fragmentShader: FRAGMENT, vertexShader: "void main() { gl_Position = vec4(position, 1.0); }", uniforms });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    // strength/threshold 按参考（0.30/0.85）；radius 收窄到 0.15，泛光才只贴着亮核而不是糊成宽带。
    const bloom = new UnrealBloomPass(new THREE.Vector2(host.clientWidth, host.clientHeight), 0.10, 0.08, 0.85);
    composer.addPass(bloom);

    const mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
    const onPointer = (event: PointerEvent) => {
      mouse.tx = event.clientX / window.innerWidth;
      mouse.ty = 1 - event.clientY / window.innerHeight;
    };
    window.addEventListener("pointermove", onPointer);

    const onResize = () => {
      const width = host.clientWidth; const height = host.clientHeight;
      renderer.setSize(width, height);
      composer.setSize(width, height);
      uniforms.uRes.value.set(width * renderer.getPixelRatio(), height * renderer.getPixelRatio());
      bloom.setSize(width, height);
    };
    window.addEventListener("resize", onResize);

    const clock = new THREE.Clock();
    let raf = 0;
    const tick = () => {
      const delta = Math.min(clock.getDelta(), 0.05);
      if (!reducedMotion) {
        uniforms.uTime.value += delta;
        uniforms.uFade.value = Math.min(1, uniforms.uFade.value + delta * 0.9);
        mouse.x += (mouse.tx - mouse.x) * 0.08;
        mouse.y += (mouse.ty - mouse.y) * 0.08;
        uniforms.uMouse.value.set(mouse.x, mouse.y);
        // 节点反向视差：JS 内联 transform，鼠标左移节点右飘
        nodeRefs.current.forEach((node, index) => {
          if (!node) return;
          const depth = NODES[index]!.depth;
          const dx = (0.5 - mouse.x) * 26 * depth;
          const dy = (0.5 - mouse.y) * 18 * depth;
          node.style.transform = `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0)`;
        });
      }
      composer.render();
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("resize", onResize);
      material.dispose();
      (bloom as unknown as { dispose?: () => void }).dispose?.();
      composer.dispose?.();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <div className="home" aria-label="汐灵 OS 启动首页">
      <div className="home-gl" ref={hostRef} aria-hidden="true" />
      <div className="home-ui">
        <header className="home-nav">
          <div className="home-brand"><img src="/brand/xiling-mark.png" alt="" /><b>汐灵</b><small>SCIENCE OS</small></div>
          <nav aria-label="进入各工作面">
            {([["chat", "对话"], ["canvas", "科研画布"], ["wiki", "Wiki"], ["papers", "文献工作台"]] as const).map(([view, label]) => (
              <button key={view} onClick={() => onEnter(view)}>{label}</button>
            ))}
          </nav>
        </header>
        <div className="home-title">
          <small>XI LING · SCIENCE OS</small>
          <h1>汐语灵境</h1>
          <p>潮汐的语言，灵境之中。本地优先的 AI 科研操作系统。</p>
          <div className="home-cta">
            <button className="home-cta-primary" onClick={() => onEnter("chat")}>进入工作区</button>
            <button className="home-cta-ghost" onClick={() => onEnter("canvas")}>先看看科研画布</button>
          </div>
        </div>
        {NODES.map((node, index) => (
          <div
            key={node.en}
            className="home-node"
            style={{ left: `${node.x}%`, top: `${node.y}%` }}
            ref={(el) => { nodeRefs.current[index] = el; }}
          >
            <i aria-hidden="true" />
            <span><b>{node.zh}</b><small>{node.en}</small></span>
          </div>
        ))}
      </div>
    </div>
  );
}
