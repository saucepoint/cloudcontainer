// Generates public/og.png, the 1200x630 social-share card for usebench.dev.
// Run: node scripts/og-image.mjs
// Rasterizes the card SVG with the Playwright-cached Chromium (no extra deps).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const W = 1200;
const H = 630;
const MONO = "'Liberation Mono', 'DejaVu Sans Mono', monospace";
const SANS = "'Liberation Sans', 'DejaVu Sans', sans-serif";

const PROMPT =
  "Add a little mischievous raccoon to the web app; animate it as if it were stealing components from the app.";

// Liberation Mono is exactly 0.6em per character.
const wrap = (text, charsPerLine) => {
  const lines = [];
  for (let i = 0; i < text.length; i += charsPerLine) {
    lines.push(text.slice(i, i + charsPerLine));
  }
  return lines;
};

const terminalLines = [
  { text: "you@laptop:~$ ssh workbench", prompt: true },
  { text: "dev@workbench:~$ cd ~/repos/lantern", prompt: true },
  { text: "dev@workbench:~/repos/lantern$ codex", prompt: true },
  { text: "", prompt: false },
  ...wrap(`\u203a ${PROMPT}`, 34).map((line, index) => ({
    text: index === 0 ? line : `  ${line}`,
    prompt: false,
    chevron: index === 0,
  })),
  { text: "Working (7s \u2022 esc to interrupt)", prompt: false, dim: true },
];

const TERM_X = 640;
const TERM_Y = 120;
const TERM_W = 480;
const TERM_H = 410;
const LINE_Y0 = TERM_Y + 78;
const LINE_H = 34;

const terminalSvg = terminalLines.map((line, index) => {
  const y = LINE_Y0 + index * LINE_H;
  if (line.text === "") return "";
  if (line.prompt) {
    const dollar = line.text.lastIndexOf("$");
    return `
      <text x="${TERM_X + 32}" y="${y}" font-family="${MONO}" font-size="20" fill="#8b949e">${line.text.slice(0, dollar + 1)}</text>
      <text x="${TERM_X + 32 + (dollar + 1) * 12}" y="${y}" font-family="${MONO}" font-size="20" fill="#c9d1d9">${line.text.slice(dollar + 1)}</text>`;
  }
  const color = line.dim ? "#8b949e" : "#c9d1d9";
  const chevron = line.chevron
    ? `<text x="${TERM_X + 32}" y="${y}" font-family="${MONO}" font-size="20" fill="#3fb950">\u203a</text>`
    : "";
  return `
    ${chevron}
    <text x="${TERM_X + 32 + (line.chevron ? 24 : 0)}" y="${y}" font-family="${MONO}" font-size="20" fill="${color}">${line.text}</text>`;
}).join("\n");

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#fbfaf7"/>
  <!-- wordmark -->
  <text x="80" y="96" font-family="${SANS}" font-weight="700" font-size="44" fill="#20201d">work</text>
  <text x="200" y="96" font-family="${SANS}" font-weight="700" font-size="44" fill="#174ea6">bench</text>
  <rect x="298" y="60" width="56" height="30" rx="6" fill="none" stroke="#d8d6cf"/>
  <text x="326" y="81" font-family="${SANS}" font-weight="600" font-size="15" fill="#65645e" text-anchor="middle" letter-spacing="0.6">beta</text>
  <!-- headline -->
  <text x="80" y="240" font-family="${SANS}" font-weight="700" font-size="62" fill="#20201d">Your free</text>
  <text x="80" y="318" font-family="${SANS}" font-weight="700" font-size="62" fill="#20201d">cloud terminal</text>
  <!-- tagline -->
  <text x="80" y="392" font-family="${SANS}" font-size="25" fill="#65645e">an always-on container</text>
  <text x="80" y="430" font-family="${SANS}" font-size="25" fill="#65645e">access from any terminal client,</text>
  <text x="80" y="468" font-family="${SANS}" font-size="25" fill="#65645e">on any device</text>
  <!-- terminal window -->
  <rect x="${TERM_X}" y="${TERM_Y}" width="${TERM_W}" height="${TERM_H}" rx="14" fill="#0d1117"/>
  <rect x="${TERM_X}" y="${TERM_Y}" width="${TERM_W}" height="46" rx="14" fill="#161b22"/>
  <rect x="${TERM_X}" y="${TERM_Y + 30}" width="${TERM_W}" height="16" fill="#161b22"/>
  <circle cx="${TERM_X + 30}" cy="${TERM_Y + 23}" r="6" fill="#ff5f57"/>
  <circle cx="${TERM_X + 52}" cy="${TERM_Y + 23}" r="6" fill="#febc2e"/>
  <circle cx="${TERM_X + 74}" cy="${TERM_Y + 23}" r="6" fill="#28c840"/>
  <text x="${TERM_X + 32}" y="${TERM_Y + 29}" font-family="${MONO}" font-size="14" fill="#8b949e">ssh workbench</text>
  ${terminalSvg}
  <text x="${TERM_X + 32}" y="${TERM_Y + TERM_H - 24}" font-family="${MONO}" font-size="14" fill="#8b949e">gpt-5.6-luna xhigh \u00b7 ~/repos/lantern</text>
</svg>`;

const candidates = [
  join(homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux/chrome"),
  join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell"),
  join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/chrome"),
].filter(existsSync);

const chrome = candidates[0];
if (!chrome) {
  console.error("no Playwright Chromium found; install via playwright or use another rasterizer");
  process.exit(1);
}

const svgPath = join("/tmp", "og-card.svg");
const pngPath = join("/tmp", "og-card.png");
writeFileSync(svgPath, svg);
execFileSync(chrome, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  `--window-size=${W},${H}`,
  `--screenshot=${pngPath}`,
  `file://${svgPath}`,
], { stdio: "ignore" });

// Verify the PNG dimensions from its IHDR header.
const png = readFileSync(pngPath);
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
if (width !== W || height !== H) {
  console.error(`unexpected screenshot size ${width}x${height}`);
  process.exit(1);
}

const outputPath = fileURLToPath(new URL("../public/og.png", import.meta.url));
writeFileSync(outputPath, png);
rmSync(svgPath, { force: true });
rmSync(pngPath, { force: true });
console.log(`wrote ${outputPath} (${width}x${height})`);
