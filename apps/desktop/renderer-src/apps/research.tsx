// 科研窗口入口：window-runtime 通过此模块按需加载三个受管窗口。
// 三者共用同一份作用域逻辑（scope.js），因此归在一个懒加载模块里。
export { ProjectWindow } from "./research/project-window.js";
export { WikiWindow } from "./research/wiki-window.js";
export { CanvasWindow } from "./research/canvas-window.js";
