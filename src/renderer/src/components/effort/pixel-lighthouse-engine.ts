export const PIXEL_SCENE_W = 128
export const PIXEL_SCENE_H = 42

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}

type Rgb3 = readonly [number, number, number]

function mix3(c1: Rgb3, c2: Rgb3, t: number): Rgb3 {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t))
  ]
}

function rgbStr(c: Rgb3, a = 1): string {
  return a < 1 ? `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(2)})` : `rgb(${c[0]},${c[1]},${c[2]})`
}

function triMix(a: Rgb3, b: Rgb3, c: Rgb3, t: number): Rgb3 {
  return t < 0.5 ? mix3(a, b, t * 2) : mix3(b, c, (t - 0.5) * 2)
}

const STARS: ReadonlyArray<readonly [number, number, number]> = [
  [8, 4, 1], [16, 7, 0], [26, 3, 0], [38, 5, 1], [49, 4, 0], [60, 8, 1],
  [71, 4, 0], [82, 7, 0], [93, 5, 1], [104, 4, 0], [114, 7, 1], [122, 5, 0],
  [44, 11, 0], [56, 14, 1], [67, 11, 0], [77, 15, 0], [13, 14, 0],
  [33, 10, 0], [53, 6, 0], [88, 10, 0], [109, 12, 0], [120, 10, 0]
]

/** 将 6 档思考强度（0=晨雾静海 → 1=极光流星风暴）实时绘制到 128×42 像素画布 */
export function renderPixelLighthouseScene(ctx: CanvasRenderingContext2D, power01: number, sec: number): void {
  const PW = PIXEL_SCENE_W
  const t = clamp(power01, 0, 1)
  const duskT = smoothstep(0.36, 0.62, t) * (1 - smoothstep(0.68, 0.9, t))
  const nightT = smoothstep(0.62, 0.86, t)
  const auroraT = smoothstep(0.84, 0.99, t)
  const speed = 0.08 + Math.pow(t, 1.8) * 2.4

  const px = (x: number, y: number, col: string, w = 1, h = 1): void => {
    ctx.fillStyle = col
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h))
  }

  const skyTop = mix3(mix3([84, 152, 224], [66, 46, 108], smoothstep(0.35, 0.65, t)), [6, 14, 34], nightT)
  const skyMid = mix3(mix3([134, 192, 240], [218, 104, 118], smoothstep(0.35, 0.65, t)), [12, 28, 60], nightT)
  const skyHor = mix3(mix3([198, 228, 248], [255, 186, 92], smoothstep(0.35, 0.65, t)), [20, 44, 84], nightT)
  for (let y = 0; y < 27; y++) {
    const u = y / 26
    const c = u < 0.5 ? mix3(skyTop, skyMid, u * 2) : mix3(skyMid, skyHor, (u - 0.5) * 2)
    px(0, y, rgbStr(c), PW, 1)
  }

  // 极限档专属：舞动像素极光带
  if (auroraT > 0.04) {
    for (let x = 2; x < PW - 2; x += 2) {
      const wave1 = Math.sin(x * 0.08 + sec * 2.4) * 3.5 + Math.cos(x * 0.04 - sec * 1.5) * 2.0
      const baseY = 7 + wave1
      const h = 5 + Math.sin(x * 0.13 - sec * 3.2) * 2.5
      const a1 = auroraT * (0.45 + 0.35 * Math.sin(x * 0.09 + sec * 3.0))
      px(x, baseY, `rgba(52, 245, 192, ${a1.toFixed(2)})`, 2, Math.max(2, h * 0.55))
      px(x, baseY - 2, `rgba(92, 188, 255, ${(a1 * 0.65).toFixed(2)})`, 2, 3)
      px(x, baseY + h * 0.45, `rgba(128, 255, 168, ${(a1 * 0.45).toFixed(2)})`, 2, 2)
    }
  }

  // 闪烁星海 + 流星雨
  if (nightT > 0.06) {
    STARS.forEach(([sx, sy, big], idx) => {
      const tw = 0.45 + 0.55 * Math.sin(sec * (2.4 + t * 2) + idx * 1.7)
      const a = nightT * tw
      if (a < 0.15) return
      px(sx, sy, `rgba(242,248,255,${a.toFixed(2)})`)
      if (big && tw > 0.7) {
        const ga = (a * 0.45).toFixed(2)
        px(sx - 1, sy, `rgba(200,232,255,${ga})`)
        px(sx + 1, sy, `rgba(200,232,255,${ga})`)
        px(sx, sy - 1, `rgba(200,232,255,${ga})`)
        px(sx, sy + 1, `rgba(200,232,255,${ga})`)
      }
    })
  }
  const meteorCount = auroraT > 0.25 ? 3 : (nightT > 0.35 ? 1 : 0)
  for (let m = 0; m < meteorCount; m++) {
    const prog = (sec * (0.55 + m * 0.19) + m * 0.43) % 1
    if (prog < 0.55) {
      const u = prog / 0.55
      const mx = Math.round(lerp(28 + m * 30, 62 + m * 30, u))
      const my = Math.round(lerp(2 + m * 2, 16 + m * 2, u))
      const a = Math.sin(u * Math.PI) * nightT
      px(mx, my, `rgba(255,255,255,${a.toFixed(2)})`, 2, 1)
      px(mx - 2, my - 1, `rgba(180,242,255,${(a * 0.65).toFixed(2)})`, 2, 1)
      px(mx - 4, my - 2, `rgba(120,210,255,${(a * 0.32).toFixed(2)})`, 2, 1)
    }
  }

  // 太阳 / 落日 / 明月
  const sunVis = 1 - smoothstep(0.62, 0.8, t)
  if (sunVis > 0.02) {
    const sunX = lerp(52, 42, clamp(t / 0.68, 0, 1))
    const sunY = lerp(6, 20, clamp(t / 0.7, 0, 1))
    const sunCore = mix3([255, 244, 148], [255, 198, 86], clamp(t * 1.5, 0, 1))
    const sunGlow = mix3([255, 224, 118], [255, 140, 68], clamp(t * 1.5, 0, 1))
    px(sunX - 1, sunY - 2, rgbStr(sunGlow, sunVis * 0.45), 6, 8)
    px(sunX - 2, sunY - 1, rgbStr(sunGlow, sunVis * 0.45), 8, 6)
    px(sunX, sunY - 1, rgbStr(sunCore, sunVis), 4, 6)
    px(sunX - 1, sunY, rgbStr(sunCore, sunVis), 6, 4)
  }
  if (nightT > 0.08) {
    const mx = 12
    const my = Math.round(lerp(13, 6, nightT))
    px(mx - 1, my - 1, `rgba(216,238,255,${(nightT * 0.25).toFixed(2)})`, 6, 6)
    px(mx, my, `rgba(246,250,255,${nightT.toFixed(2)})`, 4, 4)
    px(mx + 1, my - 1, `rgba(246,250,255,${nightT.toFixed(2)})`, 2, 6)
    px(mx - 1, my + 1, `rgba(246,250,255,${nightT.toFixed(2)})`, 6, 2)
  }

  // 像素云
  const cloudCol = triMix([246, 250, 255], [255, 212, 174], [38, 56, 94], t)
  const cloudShd = triMix([202, 222, 242], [220, 146, 144], [24, 38, 68], t)
  const drift = (sec * (0.4 + speed * 1.2)) % (PW + 24)
  const drawCloud = (bx: number, by: number, len: number): void => {
    const cx = ((bx + drift) % (PW + 24)) - 12
    px(cx + 2, by, rgbStr(cloudCol), len - 4, 2)
    px(cx, by + 2, rgbStr(cloudCol), len, 2)
    px(cx + 1, by + 3, rgbStr(cloudShd), len - 2, 1)
  }
  drawCloud(44, 9, 14)
  drawCloud(86, 7, 12)
  drawCloud(12, 12, 10)

  // 最高/极限：灯塔旋转强探照光束
  if (nightT > 0.15) {
    const sweep = Math.sin(sec * (1.8 + auroraT * 1.6))
    const beamLen = lerp(26, 62, nightT + auroraT * 0.4)
    for (let s = 4; s < beamLen; s += 2) {
      const bx = 26 + s
      const by = 11 + sweep * (s * 0.2) - s * 0.04
      const bh = Math.max(2, Math.round(1.5 + s * 0.12))
      const ba = (1 - s / beamLen) * (0.34 + auroraT * 0.24) * nightT
      if (bx < PW) px(bx, by - bh * 0.5, `rgba(255, 246, 176, ${ba.toFixed(2)})`, 2, bh)
    }
  }

  // 海洋与动态波光
  const seaTop = triMix([58, 140, 216], [126, 80, 132], [14, 30, 68], t)
  const seaBot = triMix([44, 114, 190], [156, 98, 124], [10, 20, 50], t)
  for (let y = 26; y < 37; y++) {
    px(0, y, rgbStr(mix3(seaTop, seaBot, (y - 26) / 10)), PW, 1)
  }
  const waveCnt = Math.round(4 + t * 18)
  const waveCol: Rgb3 = auroraT > 0.3
    ? [120, 245, 214]
    : triMix([182, 226, 252], [255, 208, 134], [96, 146, 212], t)
  for (let i = 0; i < waveCnt; i++) {
    const wx = (i * 21 + Math.floor(sec * (1.2 + speed * 3.5 + (i % 3)))) % PW
    const wy = 27 + ((i * 5) % 9)
    px(wx, wy, rgbStr(waveCol, 0.48 + t * 0.35), 2 + (i % 3), 1)
  }
  if (duskT > 0.15) {
    for (let y = 27; y < 37; y++) {
      const w = Math.max(2, 10 - Math.floor((y - 27) * 0.6))
      px(42 + Math.round(Math.sin(sec * 3.4 + y) * 1.4), y, `rgba(255,216,120,${(duskT * 0.62).toFixed(2)})`, w, 1)
    }
  }

  // 沙滩
  const sandHi = triMix([232, 216, 184], [202, 166, 134], [48, 54, 70], t)
  const sandLo = triMix([206, 186, 152], [166, 130, 108], [32, 36, 50], t)
  px(0, 37, rgbStr(sandHi), PW, 3)
  px(0, 40, rgbStr(sandLo), PW, 2)

  // 左侧红白灯塔 + 蓝顶木屋
  const outline = triMix([32, 34, 46], [30, 22, 38], [12, 16, 28], t)
  const lhRed = triMix([216, 62, 54], [182, 54, 58], [112, 40, 48], t)
  const lhWht = triMix([246, 246, 250], [238, 202, 180], [102, 116, 144], t)
  const grass = triMix([86, 182, 74], [94, 136, 64], [26, 72, 56], t)
  const rock = triMix([136, 140, 148], [108, 92, 102], [40, 48, 68], t)

  px(10, 34, rgbStr(grass), 40, 2)
  px(10, 36, rgbStr(rock), 39, 2)

  px(21, 6, rgbStr(outline), 5, 1)
  px(20, 7, rgbStr(lhRed), 7, 2)
  px(20, 9, rgbStr(outline), 7, 4)
  if (nightT > 0.12) {
    px(17, 8, `rgba(255,244,160,${(nightT * 0.42).toFixed(2)})`, 13, 6)
    px(21, 10, '#fffce0', 5, 2)
  } else {
    px(21, 10, rgbStr(lhWht), 5, 2)
  }
  px(19, 13, rgbStr(outline), 9, 1)
  px(20, 14, rgbStr(lhRed), 7, 5)
  px(20, 19, rgbStr(lhWht), 7, 5)
  px(19, 24, rgbStr(lhRed), 9, 5)
  px(19, 29, rgbStr(lhWht), 9, 5)
  px(19, 14, rgbStr(outline), 1, 20)
  px(27, 14, rgbStr(outline), 1, 20)
  px(23, 20, nightT > 0.25 ? '#ffd65c' : rgbStr(outline), 1, 3)
  px(23, 30, rgbStr(outline), 2, 4)

  const roofCol = triMix([62, 82, 148], [68, 62, 116], [26, 38, 76], t)
  const houseWall = triMix([44, 52, 74], [48, 42, 64], [20, 26, 44], t)
  for (let i = 0; i < 6; i++) px(31 + (5 - i), 20 + i, rgbStr(roofCol), 6 + i * 2, 1)
  px(32, 26, rgbStr(houseWall), 14, 8)
  px(31, 26, rgbStr(outline), 1, 8)
  px(46, 26, rgbStr(outline), 1, 8)
  const winLit = smoothstep(0.42, 0.65, t)
  const winCol = winLit > 0.1 ? rgbStr(mix3([190, 212, 232], [255, 220, 98], winLit)) : rgbStr(lhWht)
  px(34, 28, winCol, 2, 2)
  px(38, 28, winCol, 2, 2)
  px(42, 28, winCol, 2, 2)
  px(35, 32, winLit > 0.3 ? '#ffce54' : '#94a3b8', 7, 1)
  if (winLit > 0.2) px(33, 36, `rgba(255,208,92,${(winLit * 0.48).toFixed(2)})`, 11, 2)

  // 起伏帆船
  const bob = Math.round(Math.sin(sec * (1.2 + speed * 2.2)) * (0.4 + t * 0.7))
  const boatSail = triMix([250, 250, 255], [244, 210, 188], [134, 152, 186], t)
  const boatHull = triMix([238, 240, 246], [204, 174, 168], [76, 88, 120], t)
  const by = 26 + bob
  px(63, by, rgbStr(outline), 1, 6)
  for (let i = 0; i < 5; i++) {
    px(63 - i, by + 1 + i, rgbStr(boatSail), i, 1)
    px(64, by + 1 + i, rgbStr(boatSail), Math.max(1, i - 1), 1)
  }
  px(59, by + 6, rgbStr(outline), 9, 1)
  px(60, by + 7, rgbStr(boatHull), 7, 1)
  px(61, by + 8, rgbStr(lhRed), 5, 1)

  // 右侧悬崖、路灯、大树、长椅
  const cliffHi = triMix([164, 118, 76], [134, 92, 72], [40, 38, 50], t)
  const cliffLo = triMix([134, 92, 58], [106, 70, 58], [28, 26, 38], t)
  const grassTop = triMix([96, 198, 76], [104, 148, 66], [28, 82, 62], t)
  for (let y = 27; y < 38; y++) {
    const sx = 78 - Math.floor((y - 27) * 0.4)
    px(sx, y, rgbStr(y < 29 ? grassTop : (y % 2 === 0 ? cliffHi : cliffLo)), PW - sx, 1)
  }
  px(82, 19, rgbStr(outline), 1, 9)
  px(81, 18, rgbStr(outline), 3, 2)
  if (winLit > 0.15) {
    px(79, 16, `rgba(255,226,112,${(winLit * 0.4).toFixed(2)})`, 7, 6)
    px(81, 18, '#fff4a0', 3, 2)
  } else {
    px(82, 18, '#e2e8f0', 1, 1)
  }

  const trunk = triMix([110, 68, 38], [86, 52, 40], [32, 26, 32], t)
  const leafHi = triMix([92, 192, 78], [118, 154, 68], [36, 98, 74], t)
  const leafMid = triMix([54, 146, 56], [74, 110, 52], [22, 66, 54], t)
  const leafDk = triMix([28, 86, 40], [42, 64, 42], [12, 38, 36], t)
  px(93, 26, rgbStr(trunk), 3, 3)
  px(94, 23, rgbStr(trunk), 3, 3)
  px(95, 20, rgbStr(trunk), 3, 3)
  px(96, 18, rgbStr(trunk), 3, 2)
  px(87, 13, rgbStr(leafDk), 24, 7)
  px(84, 15, rgbStr(leafDk), 30, 5)
  px(88, 12, rgbStr(leafMid), 22, 6)
  px(85, 15, rgbStr(leafMid), 28, 4)
  px(90, 12, rgbStr(leafHi), 16, 2)
  px(87, 14, rgbStr(leafHi), 13, 2)
  px(103, 15, rgbStr(leafHi), 7, 2)

  px(103, 23, rgbStr(outline), 7, 1)
  px(103, 24, rgbStr(trunk), 7, 2)
  px(104, 26, rgbStr(outline), 1, 2)
  px(108, 26, rgbStr(outline), 1, 2)
}

const VS_SRC = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  vUv.y = 1.0 - vUv.y;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FS_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform vec2 uRes;
uniform vec2 uGrid;
uniform float uPos;
uniform float uPower;
uniform float uActive;
uniform float uDarkUi;
uniform float uStops;

vec3 toBlueprint(vec3 c, float darkUi) {
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 tint = mix(vec3(0.84, 0.87, 0.91), vec3(0.14, 0.17, 0.22), darkUi);
  return mix(vec3(lum) * 0.55 + tint * 0.45, vec3(lum) * 0.42 + tint * 0.58, darkUi);
}

vec3 sampleLed(vec2 uv, float awakenMask) {
  vec2 clamped = clamp(uv, vec2(0.001), vec2(0.999));
  vec2 cell = floor(clamped * uGrid);
  vec2 f = fract(clamped * uGrid);
  vec3 col = texture(uScene, (cell + 0.5) / uGrid).rgb;
  float satBoost = mix(0.82, 1.18, uPower);
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  vec3 vivid = mix(vec3(l), col, satBoost);
  vec3 blueprint = toBlueprint(col, uDarkUi);
  vec3 finalCol = mix(blueprint, vivid, awakenMask * uActive);
  float gx = smoothstep(0.0, 0.15, f.x) * smoothstep(1.0, 0.85, f.x);
  float gy = smoothstep(0.0, 0.15, f.y) * smoothstep(1.0, 0.85, f.y);
  return finalCol * mix(0.74, 1.05, gx * gy);
}

void main() {
  vec2 p = vUv * uRes;
  float h = uRes.y;
  float w = uRes.x;
  float r = h * 0.47;
  float pad = h * 0.50;
  float cx = mix(pad, w - pad, uPos);
  vec2 center = vec2(cx, h * 0.50);

  float awakenMask = 1.0 - smoothstep(cx - r * 0.25, cx + r * 0.65, p.x);
  awakenMask = max(awakenMask, smoothstep(0.94, 0.99, uPos));

  vec3 bg = sampleLed(vUv, awakenMask);

  float topSh = smoothstep(0.0, h * 0.16, p.y);
  float botSh = smoothstep(0.0, h * 0.10, h - p.y);
  bg *= mix(0.66, 1.0, topSh) * mix(0.82, 1.0, botSh);

  float maxStops = max(2.0, uStops);
  for (int i = 0; i < 8; i++) {
    if (float(i) >= maxStops) break;
    float fi = float(i) / (maxStops - 1.0);
    float pipX = mix(pad, w - pad, fi);
    float pipY = h - max(2.5, h * 0.10);
    float dist = length(p - vec2(pipX, pipY));
    float pipR = max(1.3, h * 0.036);
    if (dist < pipR * 1.9 && abs(pipX - cx) > r * 0.72) {
      float lit = step(fi - 0.04, uPos) * uActive;
      vec3 pipCol = mix(
        mix(vec3(0.45, 0.50, 0.58), vec3(0.30, 0.34, 0.42), uDarkUi),
        mix(vec3(0.20, 0.88, 0.80), vec3(0.45, 1.0, 0.80), uPower),
        lit
      );
      float dotA = smoothstep(pipR * 1.35, pipR * 0.55, dist);
      bg = mix(bg, pipCol, dotA * mix(0.45, 0.95, lit));
    }
  }

  vec2 shDelta = (p - (center + vec2(r * 0.09, r * 0.15))) / r;
  bg *= (1.0 - smoothstep(1.22, 0.70, length(shDelta)) * 0.42);
  vec2 caustDelta = (p - (center + vec2(r * 0.10, r * 0.84))) / (r * 0.48);
  float caustic = exp(-dot(caustDelta, caustDelta) * 2.2) * (0.08 + uPower * 0.36) * uActive;
  vec3 caustCol = mix(vec3(0.85, 0.96, 1.0), vec3(0.55, 1.0, 0.86), smoothstep(0.6, 1.0, uPower));
  bg += caustCol * caustic;

  vec2 d = (p - center) / r;
  float r2 = dot(d, d);
  if (r2 < 1.0) {
    float z = sqrt(max(0.0001, 1.0 - r2));
    vec3 N = vec3(d.x, d.y, z);
    float mag = mix(0.56, 1.08, pow(r2, 1.35));
    vec2 rUv = r / uRes;
    vec2 baseUv = (center / uRes) + d * rUv * mag;

    float disp = mix(0.003, 0.026, uPower) * r2 * r2 * uActive;
    float innerAwaken = mix(0.25, 1.0, uActive);
    vec3 refr;
    refr.r = sampleLed(baseUv + d * rUv * disp, innerAwaken).r;
    refr.g = sampleLed(baseUv, innerAwaken).g;
    refr.b = sampleLed(baseUv - d * rUv * disp, innerAwaken).b;

    float fresnel = pow(1.0 - z, 2.5);
    vec3 rimCol = mix(
      mix(vec3(0.88, 0.95, 1.0), vec3(1.0, 0.82, 0.46), smoothstep(0.45, 0.72, uPower)),
      vec3(0.48, 1.0, 0.85),
      smoothstep(0.75, 1.0, uPower)
    );
    refr = mix(refr * 1.08, rimCol, fresnel * mix(0.42, 0.82, uPower * uActive));

    vec3 L1 = normalize(vec3(-0.46, -0.52, 0.72));
    vec3 H1 = normalize(L1 + vec3(0.0, 0.0, 1.0));
    float spec1 = pow(max(0.0, dot(N, H1)), 54.0);
    float specSoft = pow(max(0.0, dot(N, H1)), 10.0) * 0.22;
    refr += vec3(1.0) * (spec1 * 0.96 + specSoft);

    float edgeAA = smoothstep(1.0, 0.95, r2);
    refr *= (1.0 - smoothstep(0.86, 0.985, r2) * 0.24);
    fragColor = vec4(mix(bg, refr, edgeAA), 1.0);
  } else {
    fragColor = vec4(bg, 1.0);
  }
}`

export interface PixelGlassWebGLRenderer {
  draw: (artCanvas: HTMLCanvasElement, pos: number, power: number, stops: number, active: boolean, darkUi: boolean) => void
  dispose: () => void
}

/** 创建 WebGL2 实时球面折射渲染器（仅用于激活行，避免多行耗尽 WebGL 上下文上限） */
export function createPixelGlassWebGLRenderer(canvas: HTMLCanvasElement): PixelGlassWebGLRenderer | null {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false })
  if (!gl) return null

  const compile = (type: number, src: string): WebGLShader | null => {
    const sh = gl.createShader(type)
    if (!sh) return null
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      gl.deleteShader(sh)
      return null
    }
    return sh
  }

  const vs = compile(gl.VERTEX_SHADER, VS_SRC)
  const fs = compile(gl.FRAGMENT_SHADER, FS_SRC)
  if (!vs || !fs) return null
  const prog = gl.createProgram()
  if (!prog) return null
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog)
    return null
  }

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  const uRes = gl.getUniformLocation(prog, 'uRes')
  const uGrid = gl.getUniformLocation(prog, 'uGrid')
  const uPos = gl.getUniformLocation(prog, 'uPos')
  const uPower = gl.getUniformLocation(prog, 'uPower')
  const uActive = gl.getUniformLocation(prog, 'uActive')
  const uDarkUi = gl.getUniformLocation(prog, 'uDarkUi')
  const uStops = gl.getUniformLocation(prog, 'uStops')

  return {
    draw(artCanvas, pos, power, stops, active, darkUi) {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const cw = Math.max(16, Math.round(rect.width * dpr))
      const ch = Math.max(16, Math.round(rect.height * dpr))
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw
        canvas.height = ch
      }
      gl.viewport(0, 0, cw, ch)
      gl.useProgram(prog)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, artCanvas)
      gl.uniform2f(uRes, cw, ch)
      gl.uniform2f(uGrid, PIXEL_SCENE_W, PIXEL_SCENE_H)
      gl.uniform1f(uPos, pos)
      gl.uniform1f(uPower, power)
      gl.uniform1f(uActive, active ? 1.0 : 0.0)
      gl.uniform1f(uDarkUi, darkUi ? 1.0 : 0.0)
      gl.uniform1f(uStops, stops)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    },
    dispose() {
      gl.deleteTexture(tex)
      gl.deleteBuffer(buf)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      gl.deleteProgram(prog)
    }
  }
}

/** 轻量 Canvas2D 绘制：用于非激活行静默像素蓝图（零 WebGL 上下文消耗）及无 WebGL2 环境降级 */
export function drawPixelLighthouseFallback2D(
  canvas: HTMLCanvasElement,
  artCanvas: HTMLCanvasElement,
  pos: number,
  stops: number,
  active: boolean,
  darkUi: boolean
): void {
  const rect = canvas.getBoundingClientRect()
  const w = Math.floor(rect.width)
  const h = Math.floor(rect.height)
  if (w < 24 || h < 12) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const cw = Math.round(w * dpr)
  const ch = Math.round(h * dpr)
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw
    canvas.height = ch
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.imageSmoothingEnabled = false

  const pad = h * 0.5
  const cx = pad + pos * Math.max(1, w - pad * 2)
  const r = h * 0.45

  // 1) 静默蓝图底
  ctx.save()
  ctx.filter = active ? 'grayscale(0.85) opacity(0.55)' : 'grayscale(1) opacity(0.32)'
  ctx.drawImage(artCanvas, 0, 0, w, h)
  ctx.restore()

  ctx.fillStyle = darkUi ? 'rgba(18, 22, 30, 0.56)' : 'rgba(232, 236, 242, 0.58)'
  ctx.fillRect(0, 0, w, h)

  // 2) 若激活（降级模式）：左侧绘制唤醒彩幕
  if (active) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, Math.min(w, cx + r * 0.45), h)
    ctx.clip()
    ctx.drawImage(artCanvas, 0, 0, w, h)
    ctx.restore()
  }

  // 3) 底部刻度点
  const n = Math.max(2, stops)
  for (let i = 0; i < n; i++) {
    const px = pad + (i / (n - 1)) * Math.max(1, w - pad * 2)
    if (Math.abs(px - cx) < r * 0.85) continue
    const lit = active && i / (n - 1) <= pos + 0.04
    ctx.fillStyle = lit ? '#2dd4bf' : (darkUi ? 'rgba(255,255,255,0.22)' : 'rgba(15,23,42,0.22)')
    ctx.beginPath()
    ctx.arc(px, h - 3.2, 1.25, 0, Math.PI * 2)
    ctx.fill()
  }

  // 4) 模拟水晶玻璃球
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, h * 0.5, r, 0, Math.PI * 2)
  ctx.clip()
  const zoom = 1.48
  ctx.drawImage(
    artCanvas,
    (cx / w) * PIXEL_SCENE_W - (r / w) * PIXEL_SCENE_W / zoom,
    PIXEL_SCENE_H * 0.5 - PIXEL_SCENE_H * 0.5 / zoom,
    (r * 2 / w) * PIXEL_SCENE_W / zoom,
    PIXEL_SCENE_H / zoom,
    cx - r,
    h * 0.5 - r,
    r * 2,
    r * 2
  )
  const rimG = ctx.createRadialGradient(cx - r * 0.3, h * 0.5 - r * 0.3, r * 0.1, cx, h * 0.5, r)
  rimG.addColorStop(0, 'rgba(255,255,255,0.52)')
  rimG.addColorStop(0.65, 'rgba(255,255,255,0.04)')
  rimG.addColorStop(1, active ? 'rgba(120,240,220,0.55)' : 'rgba(148,163,184,0.38)')
  ctx.fillStyle = rimG
  ctx.fillRect(cx - r, h * 0.5 - r, r * 2, r * 2)
  ctx.restore()
}
