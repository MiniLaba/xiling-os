// 投递给模型的 prompt 组装（语言无关的宿主契约）。
// DSH 与 Pi 两个适配器共用同一份组装规则：目标 + 最小上下文包 + 约束 + 产物 + 工具。
// 放在独立模块是为了让新增适配器不必 import 任一具体引擎适配器。

import type { RunRequest } from "./port.js";

export function composePrompt(request: RunRequest): string {
  const sections: string[] = [`目标：${request.goal}`];
  const bundle = request.contextBundle;
  if (bundle?.summary) sections.push(`背景：${bundle.summary}`);
  if (bundle?.facts?.length) {
    sections.push(`已知事实：\n${bundle.facts.map((fact) => `- ${fact.key}: ${String(fact.value)}`).join("\n")}`);
  }
  if (bundle?.constraints?.length) sections.push(`约束：\n${bundle.constraints.map((constraint) => `- ${constraint}`).join("\n")}`);
  if (request.inputArtifacts.length > 0) {
    sections.push(`输入产物：\n${request.inputArtifacts.map((ref) => `- artifact://${ref.artifactId}/version/${ref.version}`).join("\n")}`);
  }
  if (request.tools.length > 0) {
    sections.push(`可用工具：${request.tools.map((tool) => tool.name).join(", ")}`);
  }
  return sections.join("\n\n");
}
