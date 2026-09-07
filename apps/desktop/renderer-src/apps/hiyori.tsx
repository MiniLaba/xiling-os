import { useEffect, useRef, useState } from "react";

// AIRI's default Hiyori (Pro) asset, unmodified. Rendering is loaded only on demand.
let core: Promise<void> | undefined;
function loadCore() {
  return core ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("assets/companion/CubismSdkForWeb-5-r.3/Core/live2dcubismcore.min.js", document.baseURI).href;
    script.onload = () => resolve();
    script.onerror = () => { core = undefined; script.remove(); reject(new Error("角色运行库未能加载")); };
    document.head.append(script);
  });
}

export default function Hiyori({ motion }: { motion: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const animate = useRef(motion);
  const applyMotion = useRef<() => void>(() => {});
  useEffect(() => { animate.current = motion; applyMotion.current(); }, [motion]);
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      await loadCore();
      const [{ Application, ShaderSystem }, { Live2DModel }, { install }] = await Promise.all([import("pixi.js"), import("pixi-live2d-display/cubism4"), import("@pixi/unsafe-eval")]);
      if (disposed || !host.current) return;
      // Official interpreter for shader uniforms: no eval/CSP relaxation required.
      install({ ShaderSystem });
      const app = new Application({ width: 260, height: 380, backgroundAlpha: 0, antialias: true, resolution: Math.min(devicePixelRatio, 1.5), autoDensity: true });
      app.ticker.maxFPS = 30;
      host.current.appendChild(app.view as HTMLCanvasElement);
      let model: InstanceType<typeof Live2DModel> | undefined;
      let mouth = 0;
      const lips = (event: Event) => { mouth = Number((event as CustomEvent).detail) || 0; if (mouth > 0 && !document.hidden) app.start(); else visibility(); };
      window.addEventListener("xiling:voice-mouth", lips);
      app.ticker.add(() => { model?.update(app.ticker.deltaMS); });
      const resize = () => {
        if (!model || !host.current) return;
        const { width, height } = host.current.getBoundingClientRect();
        app.renderer.resize(width, height);
        model.scale.set(1);
        const scale = Math.min(width / model.width, height / model.height);
        const preference = Number(localStorage.getItem("settings/live2d/scale") ?? 1);
        model.scale.set(scale * Math.max(.01, Math.min(3, preference || 1)));
        model.anchor.set(.5, 1);
        model.position.set(width / 2, height);
        app.render();
      };
      const visibility = () => {
        animate.current && !document.hidden ? app.start() : app.stop();
      };
      applyMotion.current = visibility;
      const observer = new ResizeObserver(resize);
      let destroyed = false;
      observer.observe(host.current);
      document.addEventListener("visibilitychange", visibility);
      window.addEventListener("xiling:companion-settings", resize);
      cleanup = () => {
        if (destroyed) return;
        destroyed = true;
        window.removeEventListener("xiling:voice-mouth", lips);
        applyMotion.current = () => {};
        observer.disconnect(); document.removeEventListener("visibilitychange", visibility);
        window.removeEventListener("xiling:companion-settings", resize);
        app.destroy(true, { children: true, texture: true, baseTexture: true });
      };
      try {
        const loaded = await Live2DModel.from(new URL("assets/companion/hiyori_pro_zh/runtime/hiyori_pro_t11.model3.json", document.baseURI).href, { autoInteract: true, autoUpdate: false });
        if (disposed) { loaded.destroy({ texture: true, baseTexture: true }); return; }
        model = loaded;
        model.internalModel.on("beforeModelUpdate", () => { const core = model!.internalModel.coreModel as { setParameterValueById(id: string, value: number): void }; core.setParameterValueById("ParamMouthOpenY", mouth); });
        app.stage.addChild(model);
        resize(); visibility();
      } catch (reason) { cleanup(); cleanup = () => {}; throw reason; }
    })().catch((reason) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; cleanup(); };
  }, []);
  return <div className="hiyori-stage" ref={host}>{error && <span role="alert">{error}</span>}</div>;
}
