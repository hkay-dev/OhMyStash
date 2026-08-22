import { resolve } from "node:path";

const path = resolve(process.argv[2] ?? "assets/ohmystash-browser.png");
const png = Buffer.from(await Bun.file(path).arrayBuffer());
const signature = "89504e470d0a1a0a";
if (png.subarray(0, 8).toString("hex") !== signature || png.subarray(12, 16).toString() !== "IHDR") {
  throw new Error(`${path} is not a PNG with an IHDR header`);
}

const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
const accentOverride = process.env.OMS_CAPTURE_ACCENT;
if (accentOverride !== undefined && !/^[0-9a-f]{6}$/i.test(accentOverride)) {
  throw new Error(`OMS_CAPTURE_ACCENT must be six hexadecimal digits: ${accentOverride}`);
}

const decoded = Bun.spawnSync({
  cmd: ["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
  stdout: "pipe",
  stderr: "pipe",
});
if (decoded.exitCode !== 0) {
  throw new Error(`ffmpeg could not decode ${path}: ${decoded.stderr.toString().trim()}`);
}

const pixels = Buffer.from(decoded.stdout);
const expectedBytes = width * height * 3;
if (pixels.length !== expectedBytes) {
  throw new Error(`Decoded ${pixels.length} bytes for ${width}x${height}; expected ${expectedBytes}`);
}
let accent: number[];
if (accentOverride) {
  accent = [0, 2, 4].map((offset) =>
    Number.parseInt(accentOverride.slice(offset, offset + 2), 16),
  );
} else {
  const colors = new Map<number, number>();
  for (let offset = 0; offset < pixels.length; offset += 3) {
    const red = pixels[offset]!;
    const green = pixels[offset + 1]!;
    const blue = pixels[offset + 2]!;
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    if (maximum < 180 || maximum - minimum < 60 || minimum > 180) continue;
    const key = (red << 16) | (green << 8) | blue;
    colors.set(key, (colors.get(key) ?? 0) + 1);
  }
  const detected = [...colors].sort((left, right) => right[1] - left[1])[0]?.[0];
  if (detected === undefined) throw new Error(`Could not detect an accent color in ${path}`);
  accent = [(detected >> 16) & 0xff, (detected >> 8) & 0xff, detected & 0xff];
}

const qualifyingRows: Array<{ y: number; minX: number; maxX: number }> = [];
const minimumAccentPixels = Math.floor(width * 0.5);
for (let y = 0; y < height; y += 1) {
  let count = 0;
  let minX = width;
  let maxX = -1;
  const rowOffset = y * width * 3;
  for (let x = 0; x < width; x += 1) {
    const offset = rowOffset + x * 3;
    if (
      pixels[offset] === accent[0] &&
      pixels[offset + 1] === accent[1] &&
      pixels[offset + 2] === accent[2]
    ) {
      count += 1;
      minX = Math.min(minX, x);
      maxX = x;
    }
  }
  if (count >= minimumAccentPixels) qualifyingRows.push({ y, minX, maxX });
}

const groups: Array<Array<{ y: number; minX: number; maxX: number }>> = [];
for (const row of qualifyingRows) {
  const group = groups.at(-1);
  if (!group || row.y > group.at(-1)!.y + 1) groups.push([row]);
  else group.push(row);
}
if (groups.length < 3) {
  throw new Error(`Found ${groups.length} full accent border groups in ${path}; expected at least 3`);
}

const median = (values: number[]) => {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)]!;
};
const endpoints = groups.map((group) => ({
  y: group[0]!.y,
  minX: median(group.map((row) => row.minX)),
  maxX: median(group.map((row) => row.maxX)),
}));
const leftSpread = Math.max(...endpoints.map((row) => row.minX)) - Math.min(...endpoints.map((row) => row.minX));
const rightSpread = Math.max(...endpoints.map((row) => row.maxX)) - Math.min(...endpoints.map((row) => row.maxX));
if (leftSpread > 2 || rightSpread > 2) {
  throw new Error(
    `Modal border endpoints are misaligned in ${path}: ${JSON.stringify(endpoints)} (left spread ${leftSpread}px, right spread ${rightSpread}px)`,
  );
}

console.log(
  `border alignment ok: ${groups.length} horizontal groups, left spread ${leftSpread}px, right spread ${rightSpread}px`,
);
