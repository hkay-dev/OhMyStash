import { resolve } from "node:path";

const rendererPath = resolve(
  import.meta.dir,
  "..",
  "node_modules",
  "@wterm",
  "dom",
  "dist",
  "renderer.js",
);
const wideOriginal = "if (inBounds && width === 2) {";
const wideCollapsed =
  "if (inBounds && width === 2 && !(cp >= 0xe000 && cp <= 0xf8ff)) {";
const wideCallOriginal =
  "                appendStyledSpan(cls, style, ch, cellLinkKey, cellLinkUri);";
const wideCallPatched = `                const wideStyle = cp >= 0xe000 && cp <= 0xf8ff
                    ? style + "width:1ch;overflow:visible;"
                    : style;
                appendStyledSpan(cls, wideStyle, ch, cellLinkKey, cellLinkUri);`;
const scaledPrivateUseStyle =
  'width:1ch;transform:scaleX(0.5);transform-origin:left;overflow:visible;';
const naturalPrivateUseStyle = "width:1ch;overflow:visible;";
const boxOriginal = "            if (inBounds && cp >= 0x2580 && cp <= 0x259f) {";
const boxPatched = `            if (inBounds && cp >= 0x2500 && cp <= 0x257f) {
                flushRun(col);
                const ch = cell.chars ?? String.fromCodePoint(cp);
                const style = buildCellStyle(cell.fg, cell.bg, cell.flags, cell.fgRgb, cell.bgRgb) + "width:1ch;overflow:hidden;";
                appendStyledSpan(col === cursorCol ? "term-cursor" : "", style, ch, cellLinkKey, cellLinkUri);
                runStyle = "";
                runLinkKey = "";
                runLinkUri = undefined;
                runText = "";
                runCells = [];
                runStart = col + 1;
                continue;
            }
${boxOriginal}`;
const runOriginal = "            appendContent(content, runLinkKey, runLinkUri);";
const runPatched = `            content = '<span style="display:inline-block;width:' + (endCol - runStart) + 'ch;overflow:hidden;">' + content + '</span>';
${runOriginal}`;
let source = await Bun.file(rendererPath).text();
const applied: string[] = [];

if (source.includes(wideCollapsed)) {
  source = source.replace(wideCollapsed, wideOriginal);
  applied.push("restore wide-cell branch");
}
if (source.includes(scaledPrivateUseStyle)) {
  source = source.replaceAll(scaledPrivateUseStyle, naturalPrivateUseStyle);
  applied.push("natural private-use glyphs");
}


if (!source.includes("const wideStyle = cp >= 0xe000")) {
  if (!source.includes(wideCallOriginal)) {
    throw new Error(`Could not find the expected wide-cell render call in ${rendererPath}`);
  }
  source = source.replace(wideCallOriginal, wideCallPatched);
  applied.push("private-use glyph scaling");
}

if (!source.includes('cp >= 0x2500 && cp <= 0x257f')) {
  if (!source.includes(boxOriginal)) {
    throw new Error(`Could not find the expected block-glyph branch in ${rendererPath}`);
  }
  source = source.replace(boxOriginal, boxPatched);
  applied.push("box-drawing cells");
}
if (!source.includes("display:inline-block;width:' + (endCol - runStart)")) {
  if (!source.includes(runOriginal)) {
    throw new Error(`Could not find the expected run flush in ${rendererPath}`);
  }
  source = source.replace(runOriginal, runPatched);
  applied.push("fixed-width text runs");
}


if (applied.length > 0) {
  await Bun.write(rendererPath, source);
  console.log(`applied wterm capture patches: ${applied.join(", ")}`);
} else {
  console.log("wterm capture patches already applied");
}
