// THE WORLD — Thursday 26 November 2026.
// A one-page newspaper summary of the day's world news, drawn programmatically
// (Node 22, standard library only) to /output/entry.png: 1024x1024, deterministic.
// Text is rendered from TrueType glyph outlines (glyphs.json, extracted from the
// Liberation Serif/Sans fonts) with a scanline rasterizer at 3x supersampling.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------- PNG encoder

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function encodePng(rgb: Uint8Array, w: number, h: number): Buffer {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const row = rgb.subarray(y * stride, (y + 1) * stride);
    // try all five filters, keep the one with the lowest sum of |signed bytes|
    let bestType = 0, bestScore = Infinity, bestRow: Uint8Array | null = null;
    for (let type = 0; type < 5; type++) {
      const cand = new Uint8Array(stride);
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= 3 ? row[i - 3] : 0;
        const up = prev[i];
        const upLeft = i >= 3 ? prev[i - 3] : 0;
        let v: number;
        if (type === 0) v = row[i];
        else if (type === 1) v = row[i] - left;
        else if (type === 2) v = row[i] - up;
        else if (type === 3) v = row[i] - ((left + up) >> 1);
        else v = row[i] - paeth(left, up, upLeft);
        cand[i] = v & 0xff;
        const s = cand[i] < 128 ? cand[i] : 256 - cand[i];
        score += s;
      }
      if (score < bestScore) { bestScore = score; bestType = type; bestRow = cand; }
    }
    raw[y * (stride + 1)] = bestType;
    raw.set(bestRow!, y * (stride + 1) + 1);
    prev.set(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------- canvas

type RGB = [number, number, number];

const SS = 3; // supersampling factor
const W = 1024, H = 1024;
const BW = W * SS, BH = H * SS;
const buf = new Uint8Array(BW * BH * 3);

function setPx(x: number, y: number, c: RGB): void {
  if (x < 0 || y < 0 || x >= BW || y >= BH) return;
  const i = (y * BW + x) * 3;
  buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
}

function fillRect(x: number, y: number, w: number, h: number, c: RGB): void {
  const x0 = Math.max(0, Math.round(x * SS)), x1 = Math.min(BW, Math.round((x + w) * SS));
  const y0 = Math.max(0, Math.round(y * SS)), y1 = Math.min(BH, Math.round((y + h) * SS));
  for (let yy = y0; yy < y1; yy++) {
    let i = (yy * BW + x0) * 3;
    for (let xx = x0; xx < x1; xx++) { buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; i += 3; }
  }
}

function strokeRect(x: number, y: number, w: number, h: number, c: RGB, t = 1): void {
  fillRect(x, y, w, t, c);
  fillRect(x, y + h - t, w, t, c);
  fillRect(x, y, t, h, c);
  fillRect(x + w - t, y, t, h, c);
}

// Scanline polygon fill (nonzero winding). Points are in output px, scaled by SS here.
function fillPolygon(pts: [number, number][], c: RGB): void {
  if (pts.length < 3) return;
  const P = pts.map(([x, y]) => [x * SS, y * SS] as [number, number]);
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of P) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const yStart = Math.max(0, Math.floor(minY)), yEnd = Math.min(BH - 1, Math.ceil(maxY));
  const edges: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let i = 0; i < P.length; i++) {
    const [x0, y0] = P[i], [x1, y1] = P[(i + 1) % P.length];
    if (y0 !== y1) edges.push({ x0, y0, x1, y1 });
  }
  for (let y = yStart; y <= yEnd; y++) {
    const yc = y + 0.5;
    const hits: { x: number; w: number }[] = [];
    for (const e of edges) {
      const lo = Math.min(e.y0, e.y1), hi = Math.max(e.y0, e.y1);
      if (yc < lo || yc >= hi) continue;
      const t = (yc - e.y0) / (e.y1 - e.y0);
      hits.push({ x: e.x0 + t * (e.x1 - e.x0), w: e.y1 > e.y0 ? 1 : -1 });
    }
    if (hits.length < 2) continue;
    hits.sort((a, b) => a.x - b.x);
    let wind = 0;
    for (let i = 0; i < hits.length - 1; i++) {
      wind += hits[i].w;
      if (wind !== 0) {
        const xa = Math.max(0, Math.ceil(hits[i].x)), xb = Math.min(BW - 1, Math.floor(hits[i + 1].x));
        let idx = (y * BW + xa) * 3;
        for (let x = xa; x <= xb; x++) { buf[idx] = c[0]; buf[idx + 1] = c[1]; buf[idx + 2] = c[2]; idx += 3; }
      }
    }
  }
}

function fillCircle(cx: number, cy: number, r: number, c: RGB): void {
  const pts: [number, number][] = [];
  const n = Math.max(16, Math.min(64, Math.round(r * 3)));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  fillPolygon(pts, c);
}

function fillEllipse(cx: number, cy: number, rx: number, ry: number, c: RGB): void {
  const pts: [number, number][] = [];
  const n = 40;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  fillPolygon(pts, c);
}

function line(x0: number, y0: number, x1: number, y1: number, c: RGB, t = 1): void {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (t / 2), ny = (dx / len) * (t / 2);
  fillPolygon([[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]], c);
  fillCircle(x0, y0, t / 2, c);
  fillCircle(x1, y1, t / 2, c);
}

function polyline(pts: [number, number][], c: RGB, t = 1): void {
  for (let i = 0; i < pts.length - 1; i++) line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], c, t);
}

function downsample(): Uint8Array {
  const out = new Uint8Array(W * H * 3);
  const area = SS * SS;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < SS; dy++) {
        let i = ((y * SS + dy) * BW + x * SS) * 3;
        for (let dx = 0; dx < SS; dx++) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; i += 3; }
      }
      const o = (y * W + x) * 3;
      out[o] = Math.round(r / area); out[o + 1] = Math.round(g / area); out[o + 2] = Math.round(b / area);
    }
  }
  return out;
}

// --------------------------------------------------------------------- text

interface GlyphData { a: number; c: [number, number, number][][] }
interface FontData { upem: number; asc: number; desc: number; g: Record<string, GlyphData> }

const FONTS: Record<string, FontData> = JSON.parse(readFileSync(join(HERE, 'glyphs.json'), 'utf8'));

const glyphCache = new Map<string, [number, number][][]>();

function flattenContour(pts: [number, number, number][], scale: number): [number, number][] {
  // TrueType contour: on/off-curve points, implied on-curve midpoints between
  // consecutive off-curve points. Returns a polygon in px space (y down).
  const n = pts.length;
  if (n === 0) return [];
  const P = pts.map(([x, y, f]) => ({ x: x * scale, y: -y * scale, on: f === 1 }));
  // build the full point list with implied on-curve points inserted
  const full: { x: number; y: number; on: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const cur = P[i], next = P[(i + 1) % n];
    full.push(cur);
    if (!cur.on && !next.on) full.push({ x: (cur.x + next.x) / 2, y: (cur.y + next.y) / 2, on: true });
  }
  // choose a start on-curve point
  let startIdx = full.findIndex((p) => p.on);
  if (startIdx < 0) return [];
  const seq = [...full.slice(startIdx), ...full.slice(0, startIdx)];
  const poly: [number, number][] = [[seq[0].x, seq[0].y]];
  let i = 1;
  const SEG = 10;
  while (i <= seq.length) {
    const cur = seq[i % seq.length];
    const prev = seq[(i - 1) % seq.length];
    if (cur.on) {
      poly.push([cur.x, cur.y]);
      i += 1;
    } else {
      const next = seq[(i + 1) % seq.length]; // guaranteed on-curve
      for (let s = 1; s <= SEG; s++) {
        const t = s / SEG, u = 1 - t;
        poly.push([
          u * u * prev.x + 2 * u * t * cur.x + t * t * next.x,
          u * u * prev.y + 2 * u * t * cur.y + t * t * next.y,
        ]);
      }
      i += 2;
    }
    if (i > seq.length) break;
  }
  return poly;
}

function glyphPolys(fontName: string, ch: string, size: number): [number, number][][] {
  const key = `${fontName}|${ch}|${size.toFixed(2)}`;
  const hit = glyphCache.get(key);
  if (hit) return hit;
  const font = FONTS[fontName];
  const g = font.g[ch] ?? font.g['?'];
  const scale = size / font.upem;
  const polys = g.c.map((contour) => flattenContour(contour, scale)).filter((p) => p.length >= 3);
  glyphCache.set(key, polys);
  return polys;
}

function textWidth(text: string, fontName: string, size: number): number {
  const font = FONTS[fontName];
  let w = 0;
  for (const ch of text) {
    const g = font.g[ch] ?? font.g['?'];
    w += g.a;
  }
  return (w / font.upem) * size;
}

function drawText(text: string, x: number, baselineY: number, fontName: string, size: number, c: RGB): number {
  const font = FONTS[fontName];
  let pen = x;
  for (const ch of text) {
    const g = font.g[ch] ?? font.g['?'];
    if (g.c.length > 0) {
      for (const poly of glyphPolys(fontName, ch, size)) {
        fillPolygon(poly.map(([px, py]) => [pen + px, baselineY + py] as [number, number]), c);
      }
    }
    pen += (g.a / font.upem) * size;
  }
  return pen - x;
}

function wrapText(text: string, fontName: string, size: number, maxW: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const trial = cur === '' ? word : cur + ' ' + word;
    if (textWidth(trial, fontName, size) <= maxW || cur === '') {
      cur = trial;
    } else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur !== '') lines.push(cur);
  return lines;
}

interface BlockOpts {
  font: string; size: number; color: RGB; lineHeight: number;
  align?: 'left' | 'center' | 'right'; maxLines?: number;
}

function drawBlock(text: string, x: number, y: number, w: number, o: BlockOpts): number {
  const lines = wrapText(text, o.font, o.size, w);
  const use = o.maxLines ? lines.slice(0, o.maxLines) : lines;
  let cy = y;
  for (const ln of use) {
    const lw = textWidth(ln, o.font, o.size);
    const lx = o.align === 'center' ? x + (w - lw) / 2 : o.align === 'right' ? x + w - lw : x;
    drawText(ln, lx, cy + o.size * 0.8, o.font, o.size, o.color);
    cy += o.lineHeight;
  }
  return use.length * o.lineHeight;
}

function blockHeight(text: string, w: number, o: BlockOpts): number {
  const lines = wrapText(text, o.font, o.size, w);
  const use = o.maxLines ? Math.min(lines.length, o.maxLines) : lines.length;
  return use * o.lineHeight;
}

// ------------------------------------------------------------------ palette

const PAPER: RGB = [247, 243, 234];
const INK: RGB = [24, 22, 20];
const INK_SOFT: RGB = [74, 70, 64];
const RULE: RGB = [120, 112, 98];
const RED: RGB = [179, 35, 27];
const NAVY: RGB = [29, 58, 95];
const GOLD: RGB = [176, 124, 18];
const TEAL: RGB = [20, 102, 107];
const GREEN: RGB = [30, 122, 52];
const SKY: RGB = [168, 200, 224];
const SKY_DEEP: RGB = [110, 158, 200];
const SAND: RGB = [232, 214, 170];
const LAND: RGB = [196, 205, 168];
const OCEAN: RGB = [203, 224, 238];
const WHITE: RGB = [255, 255, 255];
const CREAM: RGB = [252, 249, 242];

const BADGE_COLORS: Record<string, RGB> = {
  CONFIRMED: GREEN,
  OFFICIAL: NAVY,
  REPORTED: [122, 106, 58],
  CLAIM: RED,
};

function drawBadge(text: string, x: number, y: number, size = 8): number {
  const c = BADGE_COLORS[text] ?? INK_SOFT;
  const w = textWidth(text, 'sansBold', size) + 8;
  fillRect(x, y, w, size + 5, c);
  drawText(text, x + 4, y + size + 1.5, 'sansBold', size, WHITE);
  return w;
}

function drawPin(n: number, x: number, y: number, c: RGB, r = 7): void {
  fillCircle(x, y, r, c);
  const s = String(n);
  const size = n >= 10 ? r * 1.15 : r * 1.35;
  const w = textWidth(s, 'sansBold', size);
  drawText(s, x - w / 2, y + size * 0.36, 'sansBold', size, WHITE);
}

// ------------------------------------------------------------------- stories

type Kind = 'lead' | 'card' | 'brief';
interface Story {
  kind: Kind;
  headline: string;
  body?: string;
  why?: string;
  badge: string;
  source: string;
  region: string;
  field: string;
  illo?: string;
  lon: number;
  lat: number;
  dx?: number; // pin label offset on the map
  dy?: number;
}

const STORIES: Story[] = [
  // ---- leads ----
  {
    kind: 'lead', illo: 'mine',
    headline: '13 DEAD, 13 MISSING IN BOGOR MINE',
    body: 'Illegal gold mine at Pongkor, Nanggung: 26 miners went in on Monday; the shaft flooded in heavy rain about 100 m down. Search resumed Thursday; 6 of the 13 dead identified. Antam: unauthorised, not its operation.',
    why: 'Rainy-season flooding turns unlicensed shafts deadly; rescuers are racing the weather.',
    badge: 'REPORTED', source: 'Reuters', region: 'SE Asia', field: 'disaster', lon: 106.8, lat: -6.6,
  },
  {
    kind: 'lead', illo: 'bank',
    headline: 'SEOUL HIKES TO 3.25%; ASIA REBOUNDS',
    body: 'Bank of Korea raised its base rate 25 bp to 3.25% (5–2 vote) — third hike since July, highest since Nov 2024. Closes: Kospi +0.29% 4,711.21 · Nikkei +0.86% 57,499.16 · Hang Seng +1.2% 22,226.88 · Taiex +2.5% · Shanghai 3,476.88.',
    why: 'Seoul tightens into 4% inflation as chip shares steady after Wednesday\u2019s rout.',
    badge: 'OFFICIAL', source: 'Bank of Korea / Reuters', region: 'E Asia', field: 'monetary policy', lon: 127.0, lat: 37.5,
  },
  {
    kind: 'lead', illo: 'balloon',
    headline: 'STORM POSTPONES 100TH MACY\u2019S PARADE',
    body: 'A nor\u2019easter lashes the US Northeast on Thanksgiving: gusts 35–60 mph, 1.5–3 in of rain, coastal flood warnings. The 100th Macy\u2019s parade — first weather postponement in its history — moves to Sat 28 Nov.',
    why: 'A century-old tradition meets the storm; 81.5m holiday travellers face disruption.',
    badge: 'REPORTED', source: 'Reuters / CNN', region: 'N America', field: 'weather', lon: -74.0, lat: 40.7,
  },
  // ---- cards ----
  {
    kind: 'card', illo: 'eu',
    headline: 'EU CLASH OVER €1.582TN BUDGET',
    body: 'Split on the 2028–34 budget and a €45bn Ukraine loan (€25bn military + €20bn budget). No deal Thu.',
    badge: 'REPORTED', source: 'Reuters / AP', region: 'Europe', field: 'politics', lon: 4.35, lat: 50.85, dx: -16, dy: -10,
  },
  {
    kind: 'card', illo: 'percent',
    headline: 'ECB MINUTES TURN HAWKISH',
    body: '\u201CA large number\u201D backed an October hike; deposit rate held at 2.50%. Markets price ~93% for a Dec hike.',
    badge: 'OFFICIAL', source: 'ECB / Reuters', region: 'Europe', field: 'monetary policy', lon: 8.68, lat: 50.11, dx: 14, dy: 8,
  },
  {
    kind: 'card', illo: 'chess',
    headline: 'GAME 3 DRAWN: 1.5–1.5 IN GENEVA',
    body: '60-move draw. Sindarov down to seconds at move 40; Gukesh pressed but could not break through.',
    badge: 'OFFICIAL', source: 'Chess.com / FIDE', region: 'Europe', field: 'chess', lon: 6.14, lat: 46.2, dx: -14, dy: 12,
  },
  {
    kind: 'card', illo: 'podiums',
    headline: 'TRUMP HOSTS RUTTE AT MAR-A-LAGO',
    body: 'Evening talks on the Russia–Ukraine war, Iran and higher defence spending. Joint line: no wider war.',
    badge: 'REPORTED', source: 'White House / LaPresse', region: 'N America', field: 'diplomacy', lon: -80.0, lat: 26.7,
  },
  {
    kind: 'card', illo: 'chart',
    headline: 'OECD: INDONESIA TO GROW 5.4% IN 2026',
    body: 'Survey launched in Jakarta: GDP 5.4% in 2026, 5.3% in 2027–28; inflation easing to 2.5% by 2028.',
    badge: 'OFFICIAL', source: 'OECD', region: 'SE Asia', field: 'economy', lon: 106.8, lat: -6.2, dx: 16, dy: 10,
  },
  {
    kind: 'card', illo: 'missile',
    headline: 'KIM ORDERS WIDER TACTICAL-NUKE ROLE',
    body: 'KCNA Thu: Kim inspected nuclear sites Wed, ordered tactical forces expanded; status \u201Cinviolable\u201D.',
    badge: 'REPORTED', source: 'KCNA / Reuters', region: 'E Asia', field: 'defence', lon: 125.75, lat: 39.03, dx: -18, dy: -6,
  },
  {
    kind: 'card', illo: 'pillar',
    headline: 'INDIA: 77 YEARS OF ITS CONSTITUTION',
    body: 'Samvidhan Diwas: Preamble readings in 23 languages, youth dialogues in 786 districts; marches planned Thu.',
    badge: 'OFFICIAL', source: 'PIB', region: 'S Asia', field: 'culture', lon: 77.2, lat: 28.6,
  },
  {
    kind: 'card', illo: 'train',
    headline: 'LONDON TUBE STRIKE BITES',
    body: 'RMT drivers\u2019 24-hour walkout from midday Thu: no Circle or Piccadilly line all day, no Tube after 21:00.',
    badge: 'OFFICIAL', source: 'TfL', region: 'Europe', field: 'transport', lon: -0.12, lat: 51.5, dx: -18, dy: -8,
  },
  {
    kind: 'card', illo: 'rain',
    headline: 'HEAVY-RAIN ALERTS ACROSS INDONESIA',
    body: '12 regions on heavy-to-very-heavy rain alert Thu, 23 on advisory incl. Jakarta; nowcast warnings midday.',
    badge: 'OFFICIAL', source: 'BMKG', region: 'SE Asia', field: 'weather', lon: 110.0, lat: -7.5, dx: 10, dy: -14,
  },
  {
    kind: 'card', illo: 'snow',
    headline: 'SNOW PILES UP IN NORTHERN JAPAN',
    body: '10–20 cm more snow forecast in western Hokkaido into Thu morning; the cold spell eases Fri.',
    badge: 'OFFICIAL', source: 'JMA / Weathernews', region: 'E Asia', field: 'weather', lon: 141.3, lat: 43.06,
  },
  {
    kind: 'card', illo: 'cricket',
    headline: 'INDIA TEST STARTS IN CHRISTCHURCH',
    body: 'Second Test at Hagley Oval from 22:00 UTC Thu (Fri NZDT). First Test drawn; India made 720/9 dec.',
    badge: 'OFFICIAL', source: 'Fixture listing', region: 'Oceania', field: 'cricket', lon: 172.6, lat: -43.5,
  },
  {
    kind: 'card', illo: 'stadium',
    headline: 'NFL THANKSGIVING TRIPLEHEADER',
    body: 'Bears (8-2) at Lions (8-2) 18:00 · Eagles (3-7) at Cowboys (5-6) 21:30 · Chiefs (8-2) at Bills (9-1) 01:20 Fri.',
    badge: 'OFFICIAL', source: 'NFL.com', region: 'N America', field: 'NFL', lon: -83.0, lat: 42.3, dx: 12, dy: -12,
  },
  {
    kind: 'card', illo: 'ball',
    headline: 'EUROPA LEAGUE: 18 TIES THURSDAY',
    body: 'Matchday 5: Olympiacos v Milan, Marseille v Levski (17:45 UTC); Juventus v Omonia, Lyon v Lillestrøm (20:00).',
    badge: 'OFFICIAL', source: 'UEFA', region: 'Europe', field: 'football', lon: 9.19, lat: 45.46, dx: 16, dy: 14,
  },
  {
    kind: 'card', illo: 'freezer',
    headline: 'HISENSE FREEZERS RECALLED IN NZ',
    body: 'Hisense 501L and 702L chest freezers recalled in New Zealand over a child-entrapment risk.',
    badge: 'REPORTED', source: 'newswire.nz', region: 'Oceania', field: 'consumer', lon: 174.8, lat: -36.8, dx: 6, dy: -14,
  },
  {
    kind: 'card', illo: 'ship',
    headline: 'CLAIM: RED SEA STRIKE KILLS SIX',
    body: 'Arab Press reports a Houthi strike on Red Sea shipping killing six workers. Not independently verified.',
    badge: 'CLAIM', source: 'Arab Press', region: 'Middle East', field: 'conflict', lon: 42.0, lat: 15.0,
  },
  // ---- briefs ----
  { kind: 'brief', headline: 'US markets shut for Thanksgiving', badge: 'OFFICIAL', source: 'White House', region: 'N America', field: 'markets', lon: -77.0, lat: 38.9, dx: 14, dy: 10 },
  { kind: 'brief', headline: 'AAA: 81.48m Thanksgiving travellers', badge: 'REPORTED', source: 'AAA', region: 'N America', field: 'travel', lon: -87.6, lat: 41.8, dx: -14, dy: 12 },
  { kind: 'brief', headline: 'Seoul lifts 2026 growth view to 3.9%', badge: 'OFFICIAL', source: 'Bank of Korea', region: 'E Asia', field: 'economy', lon: 128.5, lat: 36.5, dx: 14, dy: 8 },
  { kind: 'brief', headline: 'Hang Seng +1.2% ends 7-session slide', badge: 'REPORTED', source: 'AP', region: 'E Asia', field: 'markets', lon: 114.17, lat: 22.32, dx: 10, dy: 12 },
  { kind: 'brief', headline: 'Shanghai edges up to 3,476.88', badge: 'REPORTED', source: 'AP', region: 'E Asia', field: 'markets', lon: 121.47, lat: 31.23, dx: 14, dy: -6 },
  { kind: 'brief', headline: 'Taiex closes +2.5% in Taipei', badge: 'REPORTED', source: 'Asia Market Wrap', region: 'E Asia', field: 'markets', lon: 121.56, lat: 25.03, dx: 16, dy: 6 },
  { kind: 'brief', headline: 'EUR/USD ~1.0975 after ECB minutes', badge: 'REPORTED', source: 'FXStreet', region: 'Europe', field: 'markets', lon: 7.1, lat: 51.2, dx: -20, dy: 2 },
  { kind: 'brief', headline: 'EU October M3 money data released', badge: 'REPORTED', source: 'FXStreet', region: 'Europe', field: 'economy', lon: 5.5, lat: 49.8, dx: -6, dy: 16 },
  { kind: 'brief', headline: 'Bank of England stability report due', badge: 'REPORTED', source: 'Newsquawk', region: 'Europe', field: 'monetary policy', lon: -1.5, lat: 52.5, dx: -16, dy: 4 },
  { kind: 'brief', headline: 'Bulgaria backs only €20bn civilian aid', badge: 'REPORTED', source: 'Reuters', region: 'Europe', field: 'politics', lon: 23.3, lat: 42.7 },
  { kind: 'brief', headline: 'Meloni: EU \u201Clight-years from a solution\u201D', badge: 'REPORTED', source: 'Reuters', region: 'Europe', field: 'politics', lon: 12.5, lat: 41.9, dx: 4, dy: 14 },
  { kind: 'brief', headline: 'Merz ties EU payouts to Ukraine funding', badge: 'REPORTED', source: 'Reuters', region: 'Europe', field: 'politics', lon: 13.4, lat: 52.52, dx: 12, dy: -8 },
  { kind: 'brief', headline: 'Ukraine 2027 gap put at ~€70bn', badge: 'REPORTED', source: 'Reuters', region: 'Europe', field: 'politics', lon: 30.5, lat: 50.45 },
  { kind: 'brief', headline: 'Hernández de Cos tipped as ECB chief', badge: 'REPORTED', source: 'Reuters', region: 'Europe', field: 'politics', lon: -3.7, lat: 40.4, dx: -8, dy: 12 },
  { kind: 'brief', headline: 'Indonesia reviews 25 areas in OECD bid', badge: 'REPORTED', source: 'ASEAN Coverage', region: 'SE Asia', field: 'politics', lon: 104.0, lat: -5.0, dx: -14, dy: -10 },
  { kind: 'brief', headline: 'Productivity push needed by 2045', badge: 'OFFICIAL', source: 'OECD', region: 'SE Asia', field: 'economy', lon: 109.0, lat: -7.5, dx: 16, dy: 12 },
  { kind: 'brief', headline: 'Preamble read in 23 languages in India', badge: 'OFFICIAL', source: 'PIB', region: 'S Asia', field: 'culture', lon: 75.0, lat: 27.0, dx: -14, dy: 8 },
  { kind: 'brief', headline: 'Youth dialogues in 786 districts', badge: 'OFFICIAL', source: 'PIB', region: 'S Asia', field: 'education', lon: 80.9, lat: 26.8, dx: 12, dy: 10 },
  { kind: 'brief', headline: 'Congress plans nationwide marches Thu', badge: 'REPORTED', source: 'PTI', region: 'S Asia', field: 'politics', lon: 72.9, lat: 19.1, dx: -12, dy: 10 },
  { kind: 'brief', headline: 'Coroner finding on glacier death', badge: 'OFFICIAL', source: 'NZ DOC', region: 'Oceania', field: 'law', lon: 169.2, lat: -44.2, dx: -10, dy: 10 },
  { kind: 'brief', headline: 'Chess: rest day Fri, Game 4 Sat', badge: 'OFFICIAL', source: 'FIDE', region: 'Europe', field: 'chess', lon: 7.5, lat: 45.2, dx: 10, dy: -14 },
  { kind: 'brief', headline: 'Sindarov down to seconds at move 40', badge: 'OFFICIAL', source: 'Chess.com', region: 'Europe', field: 'chess', lon: 5.0, lat: 47.3, dx: -16, dy: -4 },
  { kind: 'brief', headline: 'First Test drawn; India 720/9 dec', badge: 'OFFICIAL', source: 'Fixture listing', region: 'Oceania', field: 'cricket', lon: 174.8, lat: -41.3, dx: 8, dy: 12 },
  { kind: 'brief', headline: 'Kim toured nuclear-powered base', badge: 'REPORTED', source: 'KCNA', region: 'E Asia', field: 'defence', lon: 127.5, lat: 40.5, dx: 14, dy: -8 },
  { kind: 'brief', headline: 'Trump–Rutte back defence spending rise', badge: 'REPORTED', source: 'White House', region: 'N America', field: 'diplomacy', lon: -75.0, lat: 40.0, dx: 18, dy: 4 },
  { kind: 'brief', headline: 'Balloons deflated; NBC airs 2025 rerun', badge: 'REPORTED', source: 'CNN', region: 'N America', field: 'culture', lon: -72.0, lat: 42.0, dx: 16, dy: -10 },
  { kind: 'brief', headline: 'NWS: 1.5–3 in rain, flood warnings', badge: 'OFFICIAL', source: 'NWS', region: 'N America', field: 'weather', lon: -71.0, lat: 42.4, dx: 20, dy: 10 },
  { kind: 'brief', headline: '6 of 13 Bogor dead identified', badge: 'REPORTED', source: 'Reuters', region: 'SE Asia', field: 'disaster', lon: 105.5, lat: -7.5, dx: -16, dy: 8 },
  { kind: 'brief', headline: 'Japan cold spell eases Fri', badge: 'OFFICIAL', source: 'JMA', region: 'E Asia', field: 'weather', lon: 138.0, lat: 38.0, dx: 14, dy: 10 },
];

const STATS: [string, string][] = [
  ['3.25%', 'Bank of Korea base rate'],
  ['13 + 13', 'Bogor mine dead + missing'],
  ['100th', 'Macy\u2019s parade postponed'],
  ['1.5–1.5', 'Chess title match score'],
  ['€45bn', 'EU Ukraine loan debated'],
  ['60', 'moves in chess Game 3'],
];

const TIMELINE: [string, string][] = [
  ['01:00', 'BoK hikes'],
  ['12:30', 'ECB minutes'],
  ['13:30', 'Parade due*'],
  ['14:00', 'Chess G3'],
  ['17:45', 'Europa early'],
  ['18:00', 'NFL: CHI@DET'],
  ['20:00', 'Europa late'],
  ['21:30', 'NFL: PHI@DAL'],
  ['22:00', 'NZ v IND Test'],
];

const DATE_CHECK: [string, string][] = [
  ['Shenzhou-24 docking, first Pakistani astronaut', '25 Nov'],
  ['Huawei convicted in New York', '24 Nov'],
  ['US tariffs proposed on 14 partners', '25 Nov'],
  ['Cairo tanker fire, at least 31 dead', '25 Nov'],
  ['Kim nuclear-facility inspection', '25 Nov'],
  ['Houthi Ras Tanura / Riyadh attacks', '25 Nov'],
  ['Australia CPI 4.9% (3-year high)', '25 Nov'],
  ['COP31 talks collapse in Antalya', '22 Nov'],
];

// -------------------------------------------------------------- illustrations
// Small flat vector scenes, drawn in a (x, y, w, h) box. Deterministic.

function illoMine(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [96, 116, 92]); // hillside green-grey
  fillPolygon([[x, y + h], [x + w * 0.35, y + h * 0.3], [x + w * 0.7, y + h * 0.55], [x + w, y + h * 0.35], [x + w, y + h]], [74, 94, 70]);
  // shaft entrance: dark arch with timber frame
  const sx = x + w * 0.42, sy = y + h * 0.42, sw = w * 0.22, sh = h * 0.58;
  fillRect(sx - 3, sy, sw + 6, sh, [120, 84, 48]);
  fillPolygon([[sx, sy + sh], [sx, sy + sh * 0.35], [sx + sw / 2, sy], [sx + sw, sy + sh * 0.35], [sx + sw, sy + sh]], [26, 24, 22]);
  // flooded water at the mouth
  fillRect(sx, sy + sh * 0.78, sw, sh * 0.22, [70, 110, 140]);
  // rain streaks
  for (let i = 0; i < 14; i++) {
    const rx = x + ((i * 53) % 100) / 100 * w;
    const ry = y + ((i * 37) % 60) / 100 * h;
    line(rx, ry, rx - 3, ry + 9, [190, 210, 225], 1.2);
  }
  // rescue tent
  fillPolygon([[x + w * 0.08, y + h], [x + w * 0.2, y + h * 0.62], [x + w * 0.32, y + h]], [214, 120, 40]);
  fillPolygon([[x + w * 0.16, y + h], [x + w * 0.2, y + h * 0.78], [x + w * 0.24, y + h]], [150, 78, 24]);
  // figures
  for (const fx of [0.7, 0.78]) {
    fillCircle(x + w * fx, y + h * 0.66, 3.2, [40, 38, 36]);
    fillRect(x + w * fx - 2.4, y + h * 0.7, 4.8, h * 0.24, [40, 38, 36]);
  }
}

function illoBank(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, SKY);
  // skyline
  const towers: [number, number, number][] = [[0.02, 0.55, 0.12], [0.16, 0.35, 0.13], [0.31, 0.62, 0.11], [0.72, 0.4, 0.12], [0.86, 0.58, 0.12]];
  for (const [tx, th, tw] of towers) fillRect(x + w * tx, y + h * (1 - th), w * tw, h * th, [120, 140, 165]);
  // bank building with columns
  const bx = x + w * 0.44, bw = w * 0.26, by = y + h * 0.34;
  fillPolygon([[bx - 4, by], [bx + bw / 2, by - h * 0.16], [bx + bw + 4, by]], NAVY);
  fillRect(bx, by, bw, h * 0.1, NAVY);
  for (let i = 0; i < 4; i++) fillRect(bx + 3 + i * (bw - 8) / 3, by + h * 0.1, 3.4, h * 0.42, [238, 234, 222]);
  fillRect(bx - 3, by + h * 0.52, bw + 6, h * 0.08, NAVY);
  fillRect(x, y + h * 0.94, w, h * 0.06, [90, 100, 110]);
  // rising chart arrow
  polyline([[x + w * 0.05, y + h * 0.82], [x + w * 0.3, y + h * 0.6], [x + w * 0.55, y + h * 0.68], [x + w * 0.82, y + h * 0.3]], RED, 2.4);
  fillPolygon([[x + w * 0.82, y + h * 0.3], [x + w * 0.75, y + h * 0.31], [x + w * 0.81, y + h * 0.4]], RED);
  drawText('3.25%', x + w * 0.06, y + h * 0.3, 'serifBold', Math.min(20, h * 0.24), NAVY);
}

function illoBalloon(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [176, 192, 205]); // storm sky
  // buildings
  fillRect(x + w * 0.02, y + h * 0.3, w * 0.14, h * 0.7, [96, 104, 116]);
  fillRect(x + w * 0.18, y + h * 0.18, w * 0.12, h * 0.82, [110, 118, 130]);
  fillRect(x + w * 0.8, y + h * 0.24, w * 0.16, h * 0.76, [100, 108, 120]);
  for (let i = 0; i < 12; i++) {
    fillRect(x + w * 0.04 + (i % 3) * w * 0.035, y + h * 0.36 + Math.floor(i / 3) * h * 0.14, 3, 4, [230, 220, 160]);
    fillRect(x + w * 0.83 + (i % 3) * w * 0.04, y + h * 0.32 + Math.floor(i / 3) * h * 0.14, 3, 4, [230, 220, 160]);
  }
  // deflated balloon sagging between buildings
  fillEllipse(x + w * 0.5, y + h * 0.52, w * 0.2, h * 0.2, [214, 84, 60]);
  fillEllipse(x + w * 0.44, y + h * 0.46, w * 0.07, h * 0.06, [232, 120, 96]);
  line(x + w * 0.36, y + h * 0.66, x + w * 0.3, y + h * 0.95, INK_SOFT, 1.2);
  line(x + w * 0.64, y + h * 0.66, x + w * 0.7, y + h * 0.95, INK_SOFT, 1.2);
  // wind swirls
  for (const wy of [0.2, 0.3]) {
    polyline([[x + w * 0.34, y + h * wy], [x + w * 0.5, y + h * (wy - 0.04)], [x + w * 0.66, y + h * wy], [x + w * 0.78, y + h * (wy - 0.03)]], [240, 244, 248], 1.6);
  }
  fillRect(x, y + h * 0.95, w, h * 0.05, [80, 88, 98]);
}

function illoEU(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [24, 48, 120]);
  const cx = x + w / 2, cy = y + h / 2, r = Math.min(w, h) * 0.36;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
    const sx = cx + Math.cos(a) * r, sy = cy + Math.sin(a) * r;
    const sr = Math.min(w, h) * 0.055;
    const star: [number, number][] = [];
    for (let k = 0; k < 10; k++) {
      const aa = (k / 10) * Math.PI * 2 - Math.PI / 2;
      const rr = k % 2 === 0 ? sr : sr * 0.45;
      star.push([sx + Math.cos(aa) * rr, sy + Math.sin(aa) * rr]);
    }
    fillPolygon(star, [250, 205, 40]);
  }
}

function illoPercent(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [238, 234, 222]);
  fillPolygon([[x + w * 0.1, y + h * 0.22], [x + w * 0.5, y + h * 0.06], [x + w * 0.9, y + h * 0.22]], NAVY);
  fillRect(x + w * 0.1, y + h * 0.22, w * 0.8, h * 0.08, NAVY);
  for (let i = 0; i < 4; i++) fillRect(x + w * (0.16 + i * 0.19), y + h * 0.3, w * 0.06, h * 0.5, [170, 162, 144]);
  fillRect(x + w * 0.08, y + h * 0.8, w * 0.84, h * 0.08, NAVY);
  drawText('%', x + w * 0.42, y + h * 0.72, 'serifBold', h * 0.5, RED);
}

function illoChess(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [240, 236, 224]);
  const s = Math.min(w, h) * 0.92, ox = x + (w - s) / 2, oy = y + (h - s) / 2, cell = s / 8;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if ((r + c) % 2 === 1) fillRect(ox + c * cell, oy + r * cell, cell, cell, [150, 116, 84]);
  }
  strokeRect(ox, oy, s, s, INK_SOFT, 1);
  // knight silhouette (simple)
  const kx = ox + s * 0.42, ky = oy + s * 0.78, ks = s * 0.34;
  fillPolygon([
    [kx, ky], [kx, ky - ks * 0.25], [kx + ks * 0.12, ky - ks * 0.62], [kx + ks * 0.3, ky - ks * 0.92],
    [kx + ks * 0.44, ky - ks * 0.98], [kx + ks * 0.5, ky - ks * 0.8], [kx + ks * 0.62, ky - ks * 0.72],
    [kx + ks * 0.6, ky - ks * 0.55], [kx + ks * 0.44, ky - ks * 0.6], [kx + ks * 0.42, ky - ks * 0.25], [kx + ks * 0.42, ky],
  ], [30, 28, 26]);
  fillCircle(kx + ks * 0.4, ky - ks * 0.84, ks * 0.045, [240, 236, 224]);
}

function illoPodiums(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [70, 84, 110]);
  // two flags
  fillRect(x + w * 0.12, y + h * 0.1, w * 0.3, h * 0.3, [178, 34, 52]);
  fillRect(x + w * 0.12, y + h * 0.1, w * 0.13, h * 0.16, [40, 60, 120]);
  fillRect(x + w * 0.58, y + h * 0.1, w * 0.3, h * 0.3, [24, 48, 120]);
  fillCircle(x + w * 0.73, y + h * 0.25, Math.min(w, h) * 0.07, WHITE);
  // podiums
  fillPolygon([[x + w * 0.16, y + h], [x + w * 0.2, y + h * 0.58], [x + w * 0.34, y + h * 0.58], [x + w * 0.38, y + h]], [52, 48, 44]);
  fillPolygon([[x + w * 0.62, y + h], [x + w * 0.66, y + h * 0.58], [x + w * 0.8, y + h * 0.58], [x + w * 0.84, y + h]], [52, 48, 44]);
  // heads
  fillCircle(x + w * 0.27, y + h * 0.5, Math.min(w, h) * 0.07, [232, 196, 160]);
  fillCircle(x + w * 0.73, y + h * 0.5, Math.min(w, h) * 0.07, [232, 196, 160]);
}

function illoChart(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, CREAM);
  const bars = [0.35, 0.5, 0.62, 0.78];
  bars.forEach((b, i) => {
    fillRect(x + w * (0.12 + i * 0.2), y + h * (0.9 - b * 0.75), w * 0.13, h * b * 0.75, i === 3 ? TEAL : [140, 170, 175]);
  });
  line(x + w * 0.06, y + h * 0.9, x + w * 0.95, y + h * 0.9, INK_SOFT, 1.4);
  polyline([[x + w * 0.14, y + h * 0.55], [x + w * 0.4, y + h * 0.42], [x + w * 0.64, y + h * 0.3], [x + w * 0.88, y + h * 0.14]], RED, 2);
  drawText('5.4%', x + w * 0.58, y + h * 0.34, 'serifBold', h * 0.26, TEAL);
}

function illoMissile(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [52, 58, 72]);
  const cx = x + w * 0.52;
  fillPolygon([[cx - w * 0.09, y + h * 0.72], [cx - w * 0.09, y + h * 0.3], [cx, y + h * 0.08], [cx + w * 0.09, y + h * 0.3], [cx + w * 0.09, y + h * 0.72]], [210, 214, 220]);
  fillPolygon([[cx - w * 0.09, y + h * 0.72], [cx - w * 0.2, y + h * 0.88], [cx - w * 0.09, y + h * 0.88]], [170, 176, 186]);
  fillPolygon([[cx + w * 0.09, y + h * 0.72], [cx + w * 0.2, y + h * 0.88], [cx + w * 0.09, y + h * 0.88]], [170, 176, 186]);
  fillPolygon([[cx - w * 0.05, y + h * 0.88], [cx + w * 0.05, y + h * 0.88], [cx, y + h * 1.0]], [240, 160, 60]);
  fillCircle(cx, y + h * 0.42, w * 0.045, RED);
  for (let i = 0; i < 8; i++) fillCircle(x + ((i * 41) % 90 + 5) / 100 * w, y + ((i * 29) % 40 + 4) / 100 * h, 1.1, [200, 206, 218]);
}

function illoPillar(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [244, 230, 200]);
  const cx = x + w / 2;
  fillRect(cx - w * 0.05, y + h * 0.22, w * 0.1, h * 0.62, [150, 96, 52]);
  fillRect(cx - w * 0.1, y + h * 0.16, w * 0.2, h * 0.07, [150, 96, 52]);
  fillRect(cx - w * 0.13, y + h * 0.84, w * 0.26, h * 0.07, [150, 96, 52]);
  fillCircle(cx, y + h * 0.1, Math.min(w, h) * 0.055, [150, 96, 52]);
  // open book
  fillPolygon([[cx - w * 0.3, y + h * 0.98], [cx - w * 0.3, y + h * 0.82], [cx, y + h * 0.88], [cx, y + h * 0.98]], WHITE);
  fillPolygon([[cx + w * 0.3, y + h * 0.98], [cx + w * 0.3, y + h * 0.82], [cx, y + h * 0.88], [cx, y + h * 0.98]], [238, 234, 222]);
  line(cx, y + h * 0.88, cx, y + h * 0.98, INK_SOFT, 1);
}

function illoTrain(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [44, 46, 54]);
  // tunnel arch
  fillPolygon([[x + w * 0.12, y + h], [x + w * 0.12, y + h * 0.4], [x + w * 0.5, y + h * 0.08], [x + w * 0.88, y + h * 0.4], [x + w * 0.88, y + h]], [24, 25, 30]);
  // train front
  const tx = x + w * 0.3, tw = w * 0.4, ty = y + h * 0.3, th = h * 0.62;
  fillRect(tx, ty, tw, th, [196, 30, 42]);
  fillRect(tx + tw * 0.08, ty + th * 0.1, tw * 0.84, th * 0.3, [40, 44, 52]);
  fillRect(tx, ty + th * 0.52, tw, th * 0.14, [240, 240, 240]);
  fillCircle(tx + tw * 0.22, ty + th * 0.82, tw * 0.09, [250, 230, 150]);
  fillCircle(tx + tw * 0.78, ty + th * 0.82, tw * 0.09, [250, 230, 150]);
  // roundel
  fillCircle(x + w * 0.5, y + h * 0.16, Math.min(w, h) * 0.09, [196, 30, 42]);
  fillRect(x + w * 0.5 - Math.min(w, h) * 0.12, y + h * 0.16 - 2, Math.min(w, h) * 0.24, 4, NAVY);
}

function illoRain(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [150, 172, 190]);
  fillEllipse(x + w * 0.38, y + h * 0.26, w * 0.26, h * 0.16, [90, 104, 120]);
  fillEllipse(x + w * 0.62, y + h * 0.3, w * 0.24, h * 0.15, [100, 114, 130]);
  for (let i = 0; i < 10; i++) {
    const rx = x + w * (0.14 + i * 0.08);
    line(rx, y + h * 0.46, rx - w * 0.03, y + h * 0.66, [70, 110, 160], 1.6);
  }
  // umbrella
  fillPolygon([[x + w * 0.28, y + h * 0.78], [x + w * 0.5, y + h * 0.6], [x + w * 0.72, y + h * 0.78], [x + w * 0.61, y + h * 0.74], [x + w * 0.5, y + h * 0.78], [x + w * 0.39, y + h * 0.74]], [214, 120, 40]);
  line(x + w * 0.5, y + h * 0.78, x + w * 0.5, y + h * 0.96, INK, 1.6);
  fillRect(x, y + h * 0.95, w, h * 0.05, [80, 110, 140]);
}

function illoSnow(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [186, 204, 222]);
  // rooftops with snow
  const roofs: [number, number, number][] = [[0.04, 0.55, 0.3], [0.36, 0.42, 0.3], [0.68, 0.58, 0.28]];
  for (const [rx, ry, rw] of roofs) {
    fillRect(x + w * rx, y + h * ry, w * rw, h * (1 - ry), [120, 96, 76]);
    fillPolygon([[x + w * (rx - 0.03), y + h * ry], [x + w * (rx + rw / 2), y + h * (ry - 0.16)], [x + w * (rx + rw + 0.03), y + h * ry]], WHITE);
  }
  for (let i = 0; i < 16; i++) {
    fillCircle(x + ((i * 47) % 96 + 2) / 100 * w, y + ((i * 31) % 55 + 3) / 100 * h, 1.6, WHITE);
  }
  fillRect(x, y + h * 0.94, w, h * 0.06, WHITE);
}

function illoCricket(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [120, 168, 96]);
  fillRect(x + w * 0.42, y + h * 0.08, w * 0.16, h * 0.84, [222, 206, 160]); // pitch
  // stumps
  for (let i = 0; i < 3; i++) fillRect(x + w * (0.455 + i * 0.04), y + h * 0.16, 2.2, h * 0.18, [240, 220, 120]);
  // bat
  fillPolygon([[x + w * 0.2, y + h * 0.95], [x + w * 0.3, y + h * 0.5], [x + w * 0.38, y + h * 0.52], [x + w * 0.3, y + h * 0.95]], [222, 196, 150]);
  line(x + w * 0.34, y + h * 0.52, x + w * 0.42, y + h * 0.3, [90, 70, 50], 2.4);
  // ball
  fillCircle(x + w * 0.68, y + h * 0.62, Math.min(w, h) * 0.09, [178, 34, 52]);
  polyline([[x + w * 0.65, y + h * 0.55], [x + w * 0.68, y + h * 0.62], [x + w * 0.65, y + h * 0.69]], [240, 220, 220], 1);
}

function illoStadium(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [36, 44, 66]);
  // floodlights
  for (const fx of [0.12, 0.88]) {
    line(x + w * fx, y + h * 0.95, x + w * fx, y + h * 0.24, [160, 168, 180], 2);
    for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
      fillCircle(x + w * fx + (c - 1) * w * 0.045, y + h * (0.14 + r * 0.09), 2.2, [250, 244, 200]);
    }
  }
  // stands + pitch
  fillPolygon([[x + w * 0.06, y + h * 0.62], [x + w * 0.94, y + h * 0.62], [x + w * 0.86, y + h * 0.98], [x + w * 0.14, y + h * 0.98]], [64, 120, 66]);
  line(x + w * 0.5, y + h * 0.62, x + w * 0.5, y + h * 0.98, [240, 240, 230], 1.4);
  // american football
  fillEllipse(x + w * 0.5, y + h * 0.8, w * 0.1, h * 0.07, [150, 90, 50]);
  line(x + w * 0.47, y + h * 0.8, x + w * 0.53, y + h * 0.8, WHITE, 1.4);
}

function illoBall(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [52, 96, 58]);
  fillCircle(x + w * 0.5, y + h * 0.5, Math.min(w, h) * 0.3, WHITE);
  const cx = x + w * 0.5, cy = y + h * 0.5, r = Math.min(w, h) * 0.3;
  const pent: [number, number][] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    pent.push([cx + Math.cos(a) * r * 0.42, cy + Math.sin(a) * r * 0.42]);
  }
  fillPolygon(pent, [30, 30, 30]);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    line(cx + Math.cos(a) * r * 0.42, cy + Math.sin(a) * r * 0.42, cx + Math.cos(a) * r * 0.98, cy + Math.sin(a) * r * 0.98, [30, 30, 30], 1.4);
  }
  // floodlight glow corners
  fillCircle(x + w * 0.1, y + h * 0.12, 2.4, [250, 244, 200]);
  fillCircle(x + w * 0.9, y + h * 0.12, 2.4, [250, 244, 200]);
}

function illoFreezer(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [220, 228, 234]);
  const fx = x + w * 0.18, fy = y + h * 0.3, fw = w * 0.64, fh = h * 0.55;
  fillRect(fx, fy, fw, fh, [240, 244, 248]);
  strokeRect(fx, fy, fw, fh, [120, 134, 148], 1.6);
  line(fx, fy + fh * 0.18, fx + fw, fy + fh * 0.18, [120, 134, 148], 1.6);
  fillRect(fx + fw * 0.62, fy + fh * 0.06, fw * 0.3, 3, [120, 134, 148]);
  // warning triangle
  const tx = x + w * 0.5, ty = y + h * 0.14;
  fillPolygon([[tx, ty], [tx - w * 0.09, ty + h * 0.16], [tx + w * 0.09, ty + h * 0.16]], [240, 180, 30]);
  drawText('!', tx - 1.5, ty + h * 0.145, 'sansBold', h * 0.13, INK);
  fillRect(x, y + h * 0.88, w, h * 0.12, [170, 184, 198]);
}

function illoShip(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [150, 190, 210]);
  // sea
  fillRect(x, y + h * 0.62, w, h * 0.38, [60, 110, 150]);
  for (let i = 0; i < 5; i++) {
    const wy = y + h * (0.7 + i * 0.06);
    polyline([[x + w * 0.04, wy], [x + w * 0.3, wy - 2], [x + w * 0.55, wy], [x + w * 0.8, wy - 2], [x + w * 0.96, wy]], [170, 205, 230], 1.2);
  }
  // hull + containers
  fillPolygon([[x + w * 0.12, y + h * 0.62], [x + w * 0.88, y + h * 0.62], [x + w * 0.8, y + h * 0.74], [x + w * 0.2, y + h * 0.74]], [52, 56, 64]);
  const cols: RGB[] = [[200, 90, 60], [60, 120, 180], [90, 160, 90], [220, 170, 60]];
  cols.forEach((c, i) => fillRect(x + w * (0.2 + i * 0.15), y + h * 0.44, w * 0.13, h * 0.18, c));
  fillRect(x + w * 0.78, y + h * 0.3, w * 0.08, h * 0.32, [230, 232, 236]);
  // smoke
  fillCircle(x + w * 0.82, y + h * 0.22, w * 0.05, [110, 112, 116]);
  fillCircle(x + w * 0.87, y + h * 0.15, w * 0.065, [130, 132, 136]);
}

const ILLOS: Record<string, (x: number, y: number, w: number, h: number) => void> = {
  mine: illoMine, bank: illoBank, balloon: illoBalloon, eu: illoEU, percent: illoPercent,
  chess: illoChess, podiums: illoPodiums, chart: illoChart, missile: illoMissile,
  pillar: illoPillar, train: illoTrain, rain: illoRain, snow: illoSnow, cricket: illoCricket,
  stadium: illoStadium, ball: illoBall, freezer: illoFreezer, ship: illoShip,
};

// ---------------------------------------------------------------------- map

const CONTINENTS: [number, number][][] = [
  // North America
  [[-168, 66], [-150, 70], [-135, 69], [-122, 70], [-110, 68], [-98, 69], [-90, 69], [-85, 66], [-82, 62], [-79, 58], [-68, 52], [-60, 47], [-65, 44], [-70, 42], [-72, 40], [-75, 37], [-76, 34], [-79, 33], [-81, 28], [-80, 26], [-82, 28], [-84, 30], [-89, 30], [-94, 29], [-97, 26], [-97, 22], [-95, 19], [-92, 19], [-90, 21], [-87, 21], [-88, 16], [-85, 11], [-83, 9], [-79, 9], [-77, 7], [-80, 8], [-83, 10], [-86, 13], [-90, 14], [-95, 16], [-99, 17], [-103, 19], [-106, 22], [-110, 24], [-113, 29], [-117, 33], [-121, 36], [-124, 41], [-124, 47], [-128, 51], [-133, 56], [-140, 60], [-148, 61], [-155, 59], [-162, 61], [-166, 60]],
  // Greenland
  [[-45, 60], [-40, 64], [-32, 68], [-22, 70], [-20, 74], [-28, 78], [-45, 80], [-58, 78], [-60, 74], [-55, 68], [-52, 62]],
  // South America
  [[-77, 7], [-74, 11], [-68, 12], [-62, 10], [-56, 6], [-51, 4], [-50, 0], [-44, -3], [-37, -5], [-35, -8], [-38, -13], [-39, -17], [-40, -21], [-45, -24], [-49, -28], [-52, -32], [-56, -35], [-60, -38], [-62, -41], [-65, -42], [-65, -45], [-66, -48], [-68, -51], [-68, -54], [-71, -54], [-73, -50], [-74, -45], [-73, -39], [-72, -33], [-71, -27], [-70, -21], [-70, -18], [-75, -15], [-77, -12], [-79, -8], [-81, -4], [-80, 1], [-77, 4]],
  // Africa
  [[-6, 35], [-2, 35], [3, 37], [10, 37], [11, 34], [15, 32], [20, 32], [25, 32], [30, 31], [32, 31], [33, 28], [35, 24], [37, 22], [38, 20], [39, 16], [41, 13], [43, 12], [47, 11], [51, 12], [51, 10], [48, 6], [44, 0], [41, -4], [40, -9], [39, -14], [38, -18], [36, -21], [35, -24], [33, -26], [31, -29], [28, -32], [25, -34], [20, -35], [18, -33], [17, -30], [15, -26], [14, -21], [12, -16], [13, -11], [12, -6], [9, -2], [9, 3], [6, 4], [2, 6], [-3, 5], [-7, 4], [-12, 7], [-15, 11], [-17, 15], [-17, 19], [-16, 23], [-15, 27], [-12, 29], [-9, 31]],
  // Madagascar
  [[44, -13], [47, -14], [49, -17], [48, -21], [47, -24], [45, -25], [44, -22], [43, -18]],
  // Europe (incl. Scandinavia, coarse)
  [[-9, 43], [-9, 37], [-6, 36], [-2, 37], [0, 39], [3, 42], [3, 43], [7, 44], [10, 44], [12, 42], [14, 41], [16, 39], [16, 38], [18, 40], [19, 42], [21, 40], [22, 37], [23, 36], [24, 38], [26, 40], [28, 41], [30, 41], [33, 42], [36, 42], [38, 45], [36, 46], [32, 46], [29, 45], [28, 45], [30, 48], [28, 50], [24, 52], [21, 54], [19, 55], [18, 56], [21, 58], [24, 59], [28, 59], [30, 60], [29, 62], [25, 65], [23, 68], [25, 71], [30, 70], [35, 68], [40, 67], [45, 67], [50, 68], [55, 68], [60, 69], [66, 69], [68, 67], [66, 64], [60, 62], [55, 58], [50, 55], [46, 52], [42, 50], [38, 49], [34, 49], [30, 50], [26, 50], [22, 50], [18, 50], [14, 50], [10, 52], [8, 54], [8, 55], [10, 57], [12, 56], [14, 54], [12, 52], [8, 51], [5, 51], [3, 51], [1, 51], [-1, 50], [-2, 49], [-5, 48], [-4, 48], [-2, 47], [-2, 45], [-1, 44], [-2, 44], [-6, 44]],
  // Britain
  [[-5, 50], [-3, 51], [-1, 52], [0, 53], [-2, 55], [-2, 57], [-4, 58], [-6, 57], [-6, 55], [-5, 53], [-5, 51]],
  // Asia (mainland incl. Arabia, India, SE Asia)
  [[36, 42], [40, 43], [44, 42], [47, 41], [49, 40], [50, 39], [52, 38], [54, 37], [54, 35], [56, 33], [58, 32], [60, 31], [62, 30], [64, 29], [66, 27], [68, 24], [70, 22], [72, 20], [73, 18], [74, 15], [75, 12], [76, 9], [77, 8], [78, 9], [80, 10], [80, 13], [80, 15], [83, 18], [86, 20], [88, 21], [89, 22], [91, 22], [92, 20], [93, 17], [94, 16], [95, 16], [97, 15], [98, 13], [99, 10], [100, 7], [101, 5], [103, 2], [104, 2], [105, 6], [106, 8], [107, 11], [108, 14], [109, 13], [109, 16], [108, 18], [110, 20], [112, 22], [114, 22], [116, 23], [118, 25], [120, 27], [121, 28], [122, 30], [121, 32], [120, 34], [120, 36], [122, 37], [124, 39], [126, 40], [127, 39], [128, 38], [129, 36], [128, 38], [127, 40], [128, 42], [130, 42], [132, 43], [135, 45], [137, 46], [139, 48], [141, 50], [142, 52], [141, 54], [143, 56], [145, 58], [148, 59], [150, 60], [153, 60], [156, 58], [158, 56], [160, 54], [162, 57], [163, 60], [166, 62], [170, 64], [175, 65], [179, 65], [179, 68], [170, 69], [160, 69], [150, 70], [140, 72], [130, 72], [120, 73], [110, 74], [100, 77], [90, 75], [80, 73], [70, 72], [68, 69], [60, 69], [55, 68], [50, 68], [45, 67], [40, 67], [35, 66], [33, 64], [33, 60], [32, 56], [33, 52], [35, 50], [37, 48], [39, 46], [40, 44], [38, 43]],
  // Arabia (separate blob for shape)
  [[43, 12], [45, 13], [48, 14], [52, 15], [55, 17], [58, 19], [59, 22], [58, 23], [56, 24], [56, 26], [54, 25], [52, 25], [50, 26], [49, 28], [48, 29], [47, 29], [45, 28], [43, 26], [41, 24], [39, 21], [38, 19], [39, 16], [41, 13]],
  // Japan
  [[130, 31], [132, 33], [134, 34], [136, 35], [138, 35], [140, 36], [141, 39], [141, 42], [142, 44], [143, 44], [142, 42], [141, 40], [140, 37], [138, 36], [136, 34], [134, 33], [132, 32], [130, 31]],
  // Indonesia blobs
  [[95, 5], [98, 3], [100, 1], [103, -2], [105, -5], [106, -6], [104, -5], [101, -2], [98, 2], [96, 4]], // Sumatra
  [[105, -6], [110, -6], [114, -7], [114, -8], [110, -8], [106, -7]], // Java
  [[109, 1], [113, 3], [117, 4], [119, 1], [118, -2], [115, -3], [111, -2], [109, 0]], // Borneo
  [[119, 0], [121, 1], [123, 0], [121, -2], [120, -4], [119, -2]], // Sulawesi
  [[131, -1], [136, -2], [141, -3], [146, -6], [147, -8], [143, -7], [138, -5], [133, -3]], // Papua
  // Australia
  [[113, -22], [114, -26], [115, -31], [115, -34], [118, -35], [122, -34], [127, -32], [130, -32], [133, -32], [135, -35], [137, -35], [138, -36], [139, -37], [141, -38], [144, -38], [147, -38], [150, -37], [152, -33], [153, -29], [153, -26], [151, -24], [150, -22], [148, -20], [146, -19], [144, -15], [143, -12], [142, -11], [142, -14], [141, -16], [140, -18], [137, -16], [136, -15], [135, -12], [133, -11], [130, -12], [128, -14], [126, -14], [124, -16], [121, -17], [118, -19], [115, -21]],
  // New Zealand
  [[173, -35], [175, -37], [176, -38], [178, -38], [177, -39], [175, -40], [174, -41], [173, -40], [173, -38], [172, -37]],
  [[168, -46], [170, -45], [172, -44], [173, -43], [174, -42], [172, -41], [170, -42], [168, -44]],
];

function drawMap(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, OCEAN);
  const lonMin = -180, lonMax = 180, latMax = 74, latMin = -56;
  const proj = (lon: number, lat: number): [number, number] => [
    x + ((lon - lonMin) / (lonMax - lonMin)) * w,
    y + ((latMax - lat) / (latMax - latMin)) * h,
  ];
  // graticule
  for (let lon = -150; lon < 180; lon += 30) {
    const [gx] = proj(lon, 0);
    line(gx, y, gx, y + h, [176, 198, 216], 0.6);
  }
  for (let lat = -30; lat < 74; lat += 30) {
    const [, gy] = proj(0, lat);
    line(x, gy, x + w, gy, [176, 198, 216], 0.6);
  }
  for (const poly of CONTINENTS) {
    fillPolygon(poly.map(([lon, lat]) => proj(lon, lat)), LAND);
  }
  strokeRect(x, y, w, h, RULE, 1);
  // pins
  STORIES.forEach((s, i) => {
    const [px, py] = proj(s.lon, s.lat);
    const lx = px + (s.dx ?? 0), ly = py + (s.dy ?? 0);
    if (s.dx || s.dy) line(px, py, lx, ly, [110, 104, 92], 0.7);
    fillCircle(px, py, 1.6, INK);
    const c = s.kind === 'lead' ? RED : s.kind === 'card' ? NAVY : [110, 104, 92];
    drawPin(i + 1, lx, ly, c, s.kind === 'lead' ? 7.5 : 6.2);
  });
}

// -------------------------------------------------------------------- layout

const M = 14; // page margin
const CW = W - M * 2; // content width

function sectionRule(y: number): void {
  fillRect(M, y, CW, 1.2, RULE);
}

function drawMasthead(): void {
  fillRect(M, 6, CW, 1, INK);
  fillRect(M, 9, CW, 3, INK);
  drawText('THE WORLD', M, 58, 'serifBold', 46, INK);
  const regions = new Set(STORIES.map((s) => s.region)).size;
  const fields = new Set(STORIES.map((s) => s.field)).size;
  const date = 'Thursday 26 November 2026';
  drawText(date, W - M - textWidth(date, 'serifBold', 17), 34, 'serifBold', 17, INK);
  const counts = `${STORIES.length} stories · ${regions} regions · ${fields} fields · all times UTC`;
  drawText(counts, W - M - textWidth(counts, 'sans', 10.5), 52, 'sans', 10.5, INK_SOFT);
  const sub = 'The day\u2019s world news on one page — every story date-verified to this day';
  drawText(sub, W - M - textWidth(sub, 'sans', 9.5), 67, 'sans', 9.5, INK_SOFT);
  sectionRule(76);
}

function drawStats(y: number): void {
  const colW = CW / STATS.length;
  STATS.forEach(([num, label], i) => {
    const cx = M + colW * i + colW / 2;
    const nw = textWidth(num, 'serifBold', 23);
    drawText(num, cx - nw / 2, y + 24, 'serifBold', 23, i % 2 === 0 ? NAVY : RED);
    const lw = textWidth(label, 'sans', 8.5);
    drawText(label, cx - lw / 2, y + 37, 'sans', 8.5, INK_SOFT);
    if (i > 0) fillRect(M + colW * i, y + 4, 0.8, 32, RULE);
  });
  sectionRule(y + 42);
}

function drawLeads(y: number, h: number): void {
  const leads = STORIES.filter((s) => s.kind === 'lead');
  const gap = 10;
  const colW = (CW - gap * 2) / 3;
  leads.forEach((s, i) => {
    const x = M + i * (colW + gap);
    const n = STORIES.indexOf(s) + 1;
    let cy = y;
    drawPin(n, x + 8, cy + 8, RED, 8);
    drawText(`${s.region.toUpperCase()} · ${s.field.toUpperCase()}`, x + 22, cy + 12, 'sansBold', 9.5, RED);
    cy += 18;
    ILLOS[s.illo!](x, cy, colW, 72);
    strokeRect(x, cy, colW, 72, RULE, 0.8);
    cy += 78;
    cy += drawBlock(s.headline, x, cy, colW, { font: 'serifBold', size: 18, color: INK, lineHeight: 20.5, maxLines: 2 });
    cy += 2;
    cy += drawBlock(s.body!, x, cy, colW, { font: 'sans', size: 11, color: INK, lineHeight: 13, maxLines: 4 });
    cy += 4;
    fillRect(x, cy, 3, 33, GOLD);
    drawText('WHY IT MATTERS', x + 8, cy + 9, 'sansBold', 8.5, GOLD);
    drawBlock(s.why!, x + 8, cy + 12, colW - 8, { font: 'sans', size: 10, color: INK_SOFT, lineHeight: 12, maxLines: 2 });
    cy += 36;
    const bw = drawBadge(s.badge, x, cy, 8);
    drawText(s.source, x + bw + 5, cy + 10, 'sans', 9, INK_SOFT);
    if (i > 0) fillRect(x - gap / 2, y, 0.8, h, RULE);
  });
  sectionRule(y + h + 4);
}

function drawCards(y: number, rowH: number): void {
  const cards = STORIES.filter((s) => s.kind === 'card');
  const cols = 5, gap = 6;
  const colW = (CW - gap * (cols - 1)) / cols;
  cards.forEach((s, i) => {
    const cx = M + (i % cols) * (colW + gap);
    const cy = y + Math.floor(i / cols) * (rowH + gap);
    const n = STORIES.indexOf(s) + 1;
    fillRect(cx, cy, colW, rowH, CREAM);
    strokeRect(cx, cy, colW, rowH, RULE, 0.7);
    drawPin(n, cx + 9, cy + 10, NAVY, 6.5);
    drawText(s.field.toUpperCase(), cx + 20, cy + 13.5, 'sansBold', 8.5, NAVY);
    ILLOS[s.illo!](cx + colW - 31, cy + rowH - 27, 27, 24);
    let ty = cy + 19;
    ty += drawBlock(s.headline, cx + 6, ty, colW - 12, { font: 'sansBold', size: 11, color: INK, lineHeight: 12.5, maxLines: 2 });
    ty += 1;
    drawBlock(s.body!, cx + 6, ty, colW - 12, { font: 'sans', size: 9.3, color: INK_SOFT, lineHeight: 11, maxLines: 3 });
    const bw = drawBadge(s.badge, cx + 6, cy + rowH - 15, 7.5);
    drawText(s.source, cx + 6 + bw + 4, cy + rowH - 5.5, 'sans', 8, INK_SOFT);
  });
}

function drawTimeline(y: number): void {
  drawText('THE DAY IN UTC', M, y + 22, 'sansBold', 10.5, INK);
  const x0 = M + 118, x1 = W - M - 6;
  line(x0, y + 18, x1, y + 18, RULE, 1.4);
  TIMELINE.forEach(([time, label], i) => {
    const tx = x0 + (i / (TIMELINE.length - 1)) * (x1 - x0);
    fillCircle(tx, y + 18, 3, RED);
    const tw = textWidth(time, 'sansBold', 9);
    drawText(time, tx - tw / 2, y + 11, 'sansBold', 9, INK);
    const lw = textWidth(label, 'sans', 8.3);
    drawText(label, Math.min(Math.max(tx - lw / 2, x0 - 20), W - M - lw), y + 33, 'sans', 8.3, INK_SOFT);
  });
  sectionRule(y + 38);
}

function drawDateCheck(x: number, y: number, w: number): void {
  drawText('DATE CHECK — NOT 26 NOVEMBER', x, y + 11, 'sansBold', 10, RED);
  let cy = y + 15;
  for (const [what, when] of DATE_CHECK) {
    fillCircle(x + 3, cy + 4, 1.8, RED);
    const label = `${what} — ${when}`;
    drawBlock(label, x + 10, cy - 2, w - 10, { font: 'sans', size: 9.3, color: INK_SOFT, lineHeight: 11, maxLines: 1 });
    cy += 10.5;
  }
  drawBlock('Big stories doing the rounds as \u201C26 Nov\u201D that belong to earlier days. None is counted above.',
    x, cy + 1, w, { font: 'sans', size: 8.3, color: INK_SOFT, lineHeight: 10, maxLines: 2 });
  cy += 22;
  // badge legend, two rows of two
  const rows: [string, string][] = [
    ['CONFIRMED', 'verified, multiple sources'],
    ['OFFICIAL', 'authority\u2019s own release'],
    ['REPORTED', 'one reputable outlet'],
    ['CLAIM', 'unverified; source named'],
  ];
  rows.forEach(([b, t], r) => {
    const lx = x + (r % 2) * (w / 2);
    const ly = cy + Math.floor(r / 2) * 14;
    const bw = drawBadge(b, lx, ly, 6.5);
    drawText(t, lx + bw + 3, ly + 8.5, 'sans', 7.8, INK_SOFT);
  });
}

function drawBriefs(x: number, y: number, w: number): void {
  drawText('MORE OF THE DAY', x, y + 11, 'sansBold', 10.5, INK);
  const briefs = STORIES.filter((s) => s.kind === 'brief');
  const cols = 2, gap = 10;
  const colW = (w - gap) / cols;
  const top = y + 18;
  const rowH = 17.5;
  briefs.forEach((s, i) => {
    const n = STORIES.indexOf(s) + 1;
    const col = i < Math.ceil(briefs.length / cols) ? 0 : 1;
    const row = col === 0 ? i : i - Math.ceil(briefs.length / cols);
    const bx = x + col * (colW + gap);
    const cy = top + row * rowH;
    drawPin(n, bx + 6, cy + 5, [110, 104, 92], 5.5);
    const bw = drawBadge(s.badge, bx + 14, cy, 6.5);
    const tx = bx + 14 + bw + 4;
    const avail = bx + colW - tx;
    let size = 9.3;
    const sw = textWidth(` · ${s.source}`, 'sans', 8.3);
    if (textWidth(s.headline, 'sansBold', size) + sw > avail) {
      size = Math.max(7.8, (size * avail) / (textWidth(s.headline, 'sansBold', size) + sw));
    }
    const hw = drawText(s.headline, tx, cy + 9, 'sansBold', size, INK);
    drawText(` · ${s.source}`, tx + hw, cy + 9, 'sans', 8.3, INK_SOFT);
  });
}

function main(): void {
  fillRect(0, 0, W, H, PAPER);
  drawMasthead();
  drawStats(82);
  drawLeads(128, 238);
  drawCards(374, 94);
  drawTimeline(672);
  // bottom band
  const by = 714;
  drawText('WHERE IT HAPPENED', M, by + 11, 'sansBold', 10.5, INK);
  drawMap(M, by + 16, 400, 126);
  drawDateCheck(M, by + 148, 400);
  fillRect(M + 408, by, 0.8, 288, RULE);
  drawBriefs(M + 418, by, CW - 418);
  // footer
  fillRect(M, 1006, CW, 1, INK);
  const foot = 'Every story date-verified to Thu 26 Nov 2026 · Times in UTC · *Macy\u2019s parade postponed to Sat 28 Nov · Sources shown per story';
  drawText(foot, (W - textWidth(foot, 'sans', 8.5)) / 2, 1019, 'sans', 8.5, INK_SOFT);

  const rgb = downsample();
  const png = encodePng(rgb, W, H);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'entry.png'), png);
}

main();
