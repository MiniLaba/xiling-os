import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ScientificMarkdown } from "./ScientificMarkdown.js";

const render = (text: string) => renderToStaticMarkup(<ScientificMarkdown text={text} />);

describe("ScientificMarkdown", () => {
  it("把有序列表每一项渲染为独立的 li", () => {
    const html = render(["需要确认的参数：", "", "1. **首选数据源**：Argo GDAC", "2. **区域**：120°E–170°E", "3. **时间**：2023 年热浪期"].join("\n"));
    expect(html).toContain("<ol");
    expect((html.match(/<li>/g) ?? []).length).toBe(3);
    expect(html).toContain("<strong>首选数据源</strong>");
    expect(html).not.toContain("2. **区域**");
  });

  it("支持中文顿号编号并保留起始序号", () => {
    const html = render("3、第三项\n4、第四项");
    expect(html).toContain('<ol start="3">');
    expect((html.match(/<li>/g) ?? []).length).toBe(2);
  });

  it("小数点开头的数字不被当作列表", () => {
    const html = render("水深约 1.5 米处取样");
    expect(html).not.toContain("<ol");
  });

  it("序号不连续时拆分为两个列表", () => {
    const html = render("1. 第一项\n5. 第五项");
    expect((html.match(/<ol/g) ?? []).length).toBe(2);
  });

  it("普通段落里的数字不被当作列表", () => {
    const html = render("2023 年夏季发生了海洋热浪");
    expect(html).not.toContain("<ol");
    expect(html).toContain("<p>2023 年夏季发生了海洋热浪</p>");
  });

  it("无序列表行为保持不变", () => {
    const html = render("- 第一项\n- 第二项");
    expect(html).toContain("<ul>");
    expect((html.match(/<li>/g) ?? []).length).toBe(2);
  });

  it("渲染 Markdown 表格", () => {
    const html = render(["| 用途 | 数据需求 |", "|---|---|", "| 热浪定义 | 逐日 SST |", "| 层结诊断 | T/S 剖面 |"].join("\n"));
    expect(html).toContain("<table>");
    expect((html.match(/<th>/g) ?? []).length).toBe(2);
    expect((html.match(/<td>/g) ?? []).length).toBe(4);
    expect(html).toContain("逐日 SST");
    expect(html).not.toContain("|---|");
  });

  it("没有分隔行的竖线文本不当成表格", () => {
    const html = render("| 只有竖线的普通文字 |");
    expect(html).not.toContain("<table");
  });
});
