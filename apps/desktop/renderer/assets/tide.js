// 潮汐背景：迁移自旧版 Web 启动页（汐语灵境）的 GLSL 片元着色器，改为原生 WebGL
// 全屏渲染，仅作桌面背景，不含任何文字 UI。原有 three.js Bloom 强度仅 0.10，
// 这里直接在着色器里保留贴边微光即可，不引入后处理依赖。

const canvas = document.getElementById("tide-canvas");
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const gl = canvas?.getContext("webgl", { antialias: false, alpha: false, powerPreference: "high-performance" });
if (!gl) {
  // WebGL 不可用时移除画布，露出 .leopard 上的静态极光兜底背景
  canvas?.remove();
} else {
  const VERTEX = "attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }";

  const FRAGMENT = `
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
    return 3.0 * u * u * (c.y - c.x) + 6.0 * u * t * (c.z - c.y) + 3.0 * u * t * t * (c.w - c.z);
  }

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

  vec2 waveEmission(vec2 uv, float mx, float my) {
    float t = invert(uv.x);
    float ya = curveY(t, 0.0, mx, my);
    float yb = curveY(t, 1.0, mx, my);
    float da = abs(uv.y - ya);
    float db = abs(uv.y - yb);
    float ea = exp(-da * da * 4200.0) + exp(-da * da * 300.0) * 0.2;
    float eb = (exp(-db * db * 4200.0) + exp(-db * db * 300.0) * 0.2) * 0.22;
    float d = min(da, db);
    return vec2(ea + eb, d);
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / uRes;

    float strips = 26.0;
    float stripId = floor(uv.x * strips);
    float inStrip = fract(uv.x * strips);
    float rnd = fract(sin(stripId * 12.9898) * 43758.5453);
    float gauss = exp(-pow((uv.x - uMouse.x) * 4.0, 2.0));
    float refr = (rnd - 0.5) * 0.020 * (0.40 + 1.60 * gauss);

    vec2 wR = waveEmission(uv + vec2(refr * 0.78, 0.0), uMouse.x, uMouse.y);
    vec2 wG = waveEmission(uv + vec2(refr * 1.00, 0.0), uMouse.x, uMouse.y);
    vec2 wB = waveEmission(uv + vec2(refr * 1.30, 0.0), uMouse.x, uMouse.y);
    float dmin = min(wR.y, min(wG.y, wB.y));
    float eR = wR.x * (1.0 + 0.7 * gauss);
    float eG = wG.x * (1.0 + 0.7 * gauss);
    float eB = wB.x * (1.0 + 0.7 * gauss);

    float endFade = smoothstep(0.0, 0.12, uv.x) * smoothstep(1.0, 0.88, uv.x);
    vec3 col = vec3(ramp(eR * endFade).r, ramp(eG * endFade).g, ramp(eB * endFade).b);

    float edge = min(inStrip, 1.0 - inStrip);
    col += exp(-edge * 46.0) * vec3(0.05, 0.08, 0.11) * (0.25 + 0.75 * gauss) * exp(-dmin * dmin * 60.0);

    col *= uFade;
    gl_FragColor = vec4(col, 1.0);
  }`;

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
    }
    return shader;
  }

  try {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link failed");
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, "uRes");
    const uTime = gl.getUniformLocation(program, "uTime");
    const uMouse = gl.getUniformLocation(program, "uMouse");
    const uFade = gl.getUniformLocation(program, "uFade");

    const mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
    let fade = reducedMotion ? 1 : 0;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    resize();
    window.addEventListener("resize", resize);

    window.addEventListener("pointermove", (event) => {
      mouse.tx = event.clientX / window.innerWidth;
      mouse.ty = 1 - event.clientY / window.innerHeight;
    });

    if (reducedMotion) {
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, 12.0);
      gl.uniform2f(uMouse, 0.5, 0.5);
      gl.uniform1f(uFade, 1.0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      let previous = performance.now();
      let raf = 0;
      const start = performance.now();
      const loop = (now) => {
        const delta = Math.min((now - previous) / 1000, 0.05);
        previous = now;
        fade = Math.min(1, fade + delta * 0.9);
        mouse.x += (mouse.tx - mouse.x) * 0.08;
        mouse.y += (mouse.ty - mouse.y) * 0.08;
        gl.uniform2f(uRes, canvas.width, canvas.height);
        gl.uniform1f(uTime, (now - start) / 1000);
        gl.uniform2f(uMouse, mouse.x, mouse.y);
        gl.uniform1f(uFade, fade);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) cancelAnimationFrame(raf);
        else { previous = performance.now(); raf = requestAnimationFrame(loop); }
      });
    }
  } catch {
    canvas.remove();
  }
}
