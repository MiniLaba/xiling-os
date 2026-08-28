import { Fragment, type ReactNode } from "react";

function inline(text: string): ReactNode[] {
  const pattern = /(https?:\/\/[^\s)]+|`[^`]+`|\*\*[^*]+\*\*|\$[^$]+\$)/g;
  return text.split(pattern).filter(Boolean).map((part, index) => {
    if (/^https?:\/\//.test(part)) return <a key={index} href={part} target="_blank" rel="noreferrer">{part}</a>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("$") && part.endsWith("$")) return <span className="scientific-inline-math" key={index}>{part.slice(1, -1)}</span>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

export function ScientificMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let code: string[] | undefined;
  let paragraph: string[] = [];
  let list: string[] = [];
  let ordered: string[] = [];
  let orderedStart = 1;
  const flushParagraph = () => { if (paragraph.length) { blocks.push(<p key={`p-${blocks.length}`}>{inline(paragraph.join(" "))}</p>); paragraph = []; } };
  const flushList = () => {
    if (list.length) { blocks.push(<ul key={`ul-${blocks.length}`}>{list.map((item, index) => <li key={index}>{inline(item)}</li>)}</ul>); list = []; }
    if (ordered.length) { blocks.push(<ol key={`ol-${blocks.length}`} start={orderedStart}>{ordered.map((item, index) => <li key={index}>{inline(item)}</li>)}</ol>); ordered = []; }
  };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    if (line.startsWith("```")) {
      flushParagraph(); flushList();
      if (code) { blocks.push(<pre key={`code-${blocks.length}`}><code>{code.join("\n")}</code></pre>); code = undefined; } else code = [];
      continue;
    }
    if (code) { code.push(line); continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) { flushParagraph(); flushList(); const level = Math.min(heading[1]!.length + 1, 5); const Tag = `h${level}` as "h2"; blocks.push(<Tag key={`h-${blocks.length}`}>{inline(heading[2]!)}</Tag>); continue; }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bullet) { flushParagraph(); flushList(); list.push(bullet[1]!); continue; }
    const numbered = /^\s*(\d{1,3})(?:[.)]\s+|、\s*)(.+)$/.exec(line);
    if (numbered) {
      flushParagraph();
      const marker = Number(numbered[1]!);
      if (ordered.length && marker !== orderedStart + ordered.length) flushList();
      if (!ordered.length) orderedStart = marker;
      ordered.push(numbered[2]!);
      continue;
    }
    if (line.trim().startsWith("|") && lineIndex + 1 < lines.length && isTableSeparator(lines[lineIndex + 1]!)) {
      flushParagraph(); flushList();
      const header = splitTableRow(line);
      const rows: string[][] = [];
      for (lineIndex += 2; lineIndex < lines.length && lines[lineIndex]!.trim().startsWith("|"); lineIndex += 1) rows.push(splitTableRow(lines[lineIndex]!));
      lineIndex -= 1;
      blocks.push(
        <table key={`table-${blocks.length}`}>
          <thead><tr>{header.map((cell, index) => <th key={index}>{inline(cell)}</th>)}</tr></thead>
          <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell)}</td>)}</tr>)}</tbody>
        </table>,
      );
      continue;
    }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    paragraph.push(line.trim());
  }
  if (code) blocks.push(<pre key={`code-${blocks.length}`}><code>{code.join("\n")}</code></pre>);
  flushParagraph(); flushList();
  return <div className="scientific-markdown">{blocks}</div>;
}
