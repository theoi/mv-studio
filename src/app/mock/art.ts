/*
 * Procedural artwork for the design preview: no stock footage or bundled media,
 * so every thumbnail and preview frame is drawn here. Scenes render once into
 * offscreen canvases and are cached.
 */

export type SceneId =
  'city' | 'neon' | 'crowd' | 'sunset' | 'ocean' | 'portrait' | 'tunnel' | 'rain' | 'dancer' | 'aurora'

type Ctx = CanvasRenderingContext2D

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function vgrad(ctx: Ctx, h: number, stops: [number, string][]) {
  const g = ctx.createLinearGradient(0, 0, 0, h)
  stops.forEach(([o, c]) => g.addColorStop(o, c))
  return g
}

function glow(ctx: Ctx, x: number, y: number, r: number, color: string, alpha = 1) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, color)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.globalAlpha = alpha
  ctx.fillStyle = g
  ctx.fillRect(x - r, y - r, r * 2, r * 2)
  ctx.globalAlpha = 1
}

function bokeh(
  ctx: Ctx,
  w: number,
  h: number,
  seed: number,
  colors: string[],
  count: number,
  maxR: number,
  yRange: [number, number] = [0, 1],
) {
  const r = rng(seed)
  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < count; i++) {
    const x = r() * w
    const y = (yRange[0] + r() * (yRange[1] - yRange[0])) * h
    const rad = maxR * (0.35 + r() * 0.65)
    const c = colors[Math.floor(r() * colors.length)]
    const g = ctx.createRadialGradient(x, y, rad * 0.55, x, y, rad)
    g.addColorStop(0, c)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.globalAlpha = 0.18 + r() * 0.3
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, rad, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}

function skyline(
  ctx: Ctx,
  w: number,
  h: number,
  base: number,
  seed: number,
  color: string,
  windows: string | null,
  minH: number,
  maxH: number,
) {
  const r = rng(seed)
  let x = -10
  while (x < w + 10) {
    const bw = w * (0.03 + r() * 0.06)
    const bh = h * (minH + r() * (maxH - minH))
    ctx.fillStyle = color
    ctx.fillRect(x, base - bh, bw, bh + 2)
    if (windows) {
      ctx.fillStyle = windows
      const cols = Math.max(2, Math.floor(bw / (w * 0.012)))
      const rows = Math.floor(bh / (h * 0.03))
      for (let cx = 0; cx < cols; cx++) {
        for (let ry = 0; ry < rows; ry++) {
          if (r() < 0.28) {
            ctx.globalAlpha = 0.35 + r() * 0.6
            ctx.fillRect(
              x + (cx + 0.3) * (bw / cols),
              base - bh + (ry + 0.5) * h * 0.03,
              w * 0.004,
              h * 0.008,
            )
          }
        }
      }
      ctx.globalAlpha = 1
    }
    x += bw + w * 0.004
  }
}

function person(ctx: Ctx, cx: number, baseY: number, scale: number, rim: string) {
  ctx.save()
  ctx.translate(cx, baseY)
  ctx.scale(scale, scale)
  const body = new Path2D()
  body.moveTo(-170, 0)
  body.bezierCurveTo(-165, -95, -120, -135, -55, -150)
  body.bezierCurveTo(-35, -158, -28, -175, -30, -195)
  body.bezierCurveTo(-58, -215, -66, -260, -60, -300)
  body.bezierCurveTo(-52, -352, -22, -372, 6, -372)
  body.bezierCurveTo(40, -372, 66, -348, 70, -300)
  body.bezierCurveTo(74, -258, 62, -218, 36, -196)
  body.bezierCurveTo(34, -176, 40, -160, 62, -150)
  body.bezierCurveTo(125, -133, 168, -95, 175, 0)
  body.closePath()
  const fill = ctx.createLinearGradient(-170, -370, 175, 0)
  fill.addColorStop(0, '#120d1c')
  fill.addColorStop(1, '#06050a')
  ctx.fillStyle = fill
  ctx.fill(body)
  ctx.save()
  ctx.clip(body)
  ctx.strokeStyle = rim
  ctx.lineWidth = 10
  ctx.filter = 'blur(6px)'
  ctx.translate(-5, 2)
  ctx.stroke(body)
  ctx.restore()
  ctx.restore()
}

type Pt = [number, number]

/** Fills a tapered limb: one quad per segment plus round joints, filled part by part to avoid winding holes. */
function limb(ctx: Ctx, pts: Pt[], widths: number[]) {
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i] as Pt
    const [x2, y2] = pts[i + 1] as Pt
    const w1 = (widths[i] ?? 10) / 2
    const w2 = (widths[i + 1] ?? 10) / 2
    const a = Math.atan2(y2 - y1, x2 - x1) + Math.PI / 2
    const c = Math.cos(a)
    const sn = Math.sin(a)
    ctx.beginPath()
    ctx.moveTo(x1 + c * w1, y1 + sn * w1)
    ctx.lineTo(x2 + c * w2, y2 + sn * w2)
    ctx.lineTo(x2 - c * w2, y2 - sn * w2)
    ctx.lineTo(x1 - c * w1, y1 - sn * w1)
    ctx.fill()
  }
  pts.forEach(([x, y], i) => {
    ctx.beginPath()
    ctx.arc(x, y, (widths[i] ?? 10) / 2, 0, Math.PI * 2)
    ctx.fill()
  })
}

function dancerParts(ctx: Ctx) {
  ctx.beginPath()
  ctx.ellipse(8, -318, 21, 26, 0.12, 0, Math.PI * 2)
  ctx.fill()
  limb(
    ctx,
    [
      [5, -294],
      [3, -268],
    ],
    [17, 22],
  )
  ctx.beginPath()
  ctx.moveTo(-40, -264)
  ctx.bezierCurveTo(-30, -224, -22, -196, -27, -150)
  ctx.lineTo(31, -150)
  ctx.bezierCurveTo(26, -196, 32, -224, 44, -262)
  ctx.quadraticCurveTo(4, -276, -40, -264)
  ctx.fill()
  ctx.beginPath()
  ctx.ellipse(2, -150, 35, 19, 0, 0, Math.PI * 2)
  ctx.fill()
  limb(
    ctx,
    [
      [-32, -258],
      [-74, -310],
      [-90, -382],
    ],
    [25, 17, 11],
  )
  limb(
    ctx,
    [
      [38, -256],
      [90, -230],
      [138, -262],
    ],
    [25, 17, 11],
  )
  limb(
    ctx,
    [
      [-16, -150],
      [-52, -78],
      [-66, -8],
      [-94, -2],
    ],
    [38, 26, 16, 10],
  )
  limb(
    ctx,
    [
      [20, -150],
      [56, -86],
      [104, -58],
      [128, -70],
    ],
    [38, 26, 16, 10],
  )
}

/** A backlit dancer silhouette: a warm halo pass, then the dark body on top so halos never cross the body. */
function dancer(ctx: Ctx, cx: number, baseY: number, scale: number) {
  ctx.save()
  ctx.translate(cx, baseY)
  ctx.scale(scale, scale)
  ctx.save()
  ctx.fillStyle = '#07060b'
  ctx.shadowColor = 'rgba(255,190,130,0.75)'
  ctx.shadowBlur = 26 * scale
  ctx.shadowOffsetY = -3 * scale
  dancerParts(ctx)
  ctx.restore()
  const fill = ctx.createLinearGradient(0, -400, 0, 0)
  fill.addColorStop(0, '#120e1a')
  fill.addColorStop(1, '#060509')
  ctx.fillStyle = fill
  dancerParts(ctx)
  ctx.restore()
}

function drawBackground(ctx: Ctx, scene: SceneId, w: number, h: number) {
  switch (scene) {
    case 'city': {
      ctx.fillStyle = vgrad(ctx, h, [
        [0, '#070a1c'],
        [0.55, '#1a1c45'],
        [0.8, '#43285a'],
        [1, '#130f22'],
      ])
      ctx.fillRect(0, 0, w, h)
      glow(ctx, w * 0.5, h * 0.78, w * 0.55, 'rgba(255,120,170,0.35)')
      skyline(ctx, w, h, h * 0.86, 3, '#151633', 'rgba(255,214,150,1)', 0.18, 0.42)
      skyline(ctx, w, h, h * 1.0, 9, '#090a18', 'rgba(255,190,120,1)', 0.12, 0.3)
      bokeh(ctx, w, h, 11, ['#ffb36b', '#ff6fa8', '#6fd4ff'], 26, w * 0.05, [0.5, 1])
      break
    }
    case 'neon': {
      ctx.fillStyle = vgrad(ctx, h, [
        [0, '#0d0420'],
        [0.45, '#3a0a4e'],
        [0.6, '#ff3d8b'],
        [0.6001, '#0b0420'],
        [1, '#05020f'],
      ])
      ctx.fillRect(0, 0, w, h)
      const sunR = h * 0.22
      const sx = w / 2
      const sy = h * 0.47
      const sg = ctx.createLinearGradient(0, sy - sunR, 0, sy + sunR)
      sg.addColorStop(0, '#ffe36e')
      sg.addColorStop(1, '#ff3d8b')
      ctx.save()
      ctx.beginPath()
      ctx.arc(sx, sy, sunR, 0, Math.PI * 2)
      ctx.clip()
      ctx.fillStyle = sg
      ctx.fillRect(sx - sunR, sy - sunR, sunR * 2, sunR * 2)
      ctx.fillStyle = '#3a0a4e'
      for (let i = 0; i < 6; i++) {
        const y = sy + i * sunR * 0.17
        ctx.fillRect(sx - sunR, y, sunR * 2, 2 + i * 1.6)
      }
      ctx.restore()
      glow(ctx, sx, sy, sunR * 2.4, 'rgba(255,61,139,0.35)')
      const horizon = h * 0.6
      ctx.strokeStyle = 'rgba(255,80,200,0.75)'
      ctx.lineWidth = 1.5
      for (let i = -14; i <= 14; i++) {
        ctx.beginPath()
        ctx.moveTo(w / 2 + i * w * 0.012, horizon)
        ctx.lineTo(w / 2 + i * w * 0.16, h)
        ctx.stroke()
      }
      for (let i = 0; i < 12; i++) {
        const y = horizon + Math.pow(i / 12, 2.2) * (h - horizon)
        ctx.globalAlpha = 0.3 + (i / 12) * 0.7
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
      break
    }
    case 'crowd': {
      ctx.fillStyle = vgrad(ctx, h, [
        [0, '#0a0614'],
        [1, '#05040a'],
      ])
      ctx.fillRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'lighter'
      const beams: [number, string][] = [
        [0.2, 'rgba(130,90,255,0.32)'],
        [0.42, 'rgba(255,80,170,0.26)'],
        [0.6, 'rgba(90,170,255,0.3)'],
        [0.82, 'rgba(160,90,255,0.3)'],
      ]
      beams.forEach(([x, c], i) => {
        const g = ctx.createLinearGradient(0, 0, 0, h)
        g.addColorStop(0, c)
        g.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.moveTo(w * x - 8, 0)
        ctx.lineTo(w * x + 8, 0)
        ctx.lineTo(w * (x + (i % 2 ? 0.16 : -0.14)) + w * 0.09, h)
        ctx.lineTo(w * (x + (i % 2 ? 0.16 : -0.14)) - w * 0.09, h)
        ctx.closePath()
        ctx.fill()
      })
      ctx.globalCompositeOperation = 'source-over'
      glow(ctx, w * 0.5, h * 0.25, w * 0.4, 'rgba(180,120,255,0.18)')
      const r = rng(5)
      ctx.fillStyle = '#020204'
      for (let i = 0; i < 46; i++) {
        const x = (i / 46) * w + (r() - 0.5) * 20
        const y = h * (0.8 + r() * 0.08)
        const s = w * (0.022 + r() * 0.01)
        ctx.beginPath()
        ctx.arc(x, y, s, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillRect(x - s * 1.6, y + s * 0.6, s * 3.2, h)
        if (r() < 0.18) {
          ctx.lineWidth = s * 0.55
          ctx.strokeStyle = '#020204'
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.moveTo(x + s, y + s)
          ctx.lineTo(x + s * 1.8, y - s * 3)
          ctx.stroke()
        }
      }
      break
    }
    case 'sunset': {
      ctx.fillStyle = vgrad(ctx, h, [
        [0, '#1b1838'],
        [0.4, '#7a3c66'],
        [0.68, '#e5735a'],
        [0.8, '#f6b26b'],
        [1, '#2a1a24'],
      ])
      ctx.fillRect(0, 0, w, h)
      glow(ctx, w * 0.62, h * 0.74, h * 0.6, 'rgba(255,214,140,0.65)')
      ctx.fillStyle = '#fff1c8'
      ctx.beginPath()
      ctx.arc(w * 0.62, h * 0.74, h * 0.07, 0, Math.PI * 2)
      ctx.fill()
      skyline(ctx, w, h, h * 1.0, 21, '#1a1020', null, 0.14, 0.3)
      ctx.fillStyle = '#120a16'
      ctx.fillRect(w * 0.18, h * 0.6, w * 0.05, h * 0.12)
      ctx.fillRect(w * 0.195, h * 0.72, w * 0.006, h * 0.12)
      ctx.fillRect(w * 0.218, h * 0.72, w * 0.006, h * 0.12)
      break
    }
    case 'ocean': {
      ctx.fillStyle = vgrad(ctx, h, [
        [0, '#06131f'],
        [0.5, '#12415a'],
        [0.52, '#0b2e3e'],
        [1, '#03141c'],
      ])
      ctx.fillRect(0, 0, w, h)
      glow(ctx, w * 0.35, h * 0.5, w * 0.35, 'rgba(120,230,255,0.28)')
      const r = rng(8)
      ctx.globalCompositeOperation = 'lighter'
      for (let i = 0; i < 90; i++) {
        const y = h * (0.53 + Math.pow(r(), 1.6) * 0.47)
        const len = w * (0.02 + r() * 0.12) * (y / h)
        const x = w * 0.35 + (r() - 0.5) * w * 0.5 * (y / h)
        ctx.fillStyle = `rgba(160,235,255,${0.12 + r() * 0.35})`
        ctx.fillRect(x - len / 2, y, len, 1.5 + r() * 1.5)
      }
      ctx.globalCompositeOperation = 'source-over'
      break
    }
    case 'portrait': {
      ctx.fillStyle = vgrad(ctx, h, [
        [0, '#170d2a'],
        [1, '#2e1638'],
      ])
      ctx.fillRect(0, 0, w, h)
      glow(ctx, w * 0.78, h * 0.3, w * 0.4, 'rgba(255,90,150,0.3)')
      glow(ctx, w * 0.18, h * 0.6, w * 0.35, 'rgba(100,120,255,0.25)')
      bokeh(ctx, w, h, 31, ['#ff7fb0', '#8fa0ff', '#ffc27a'], 22, w * 0.06)
      break
    }
    case 'tunnel': {
      ctx.fillStyle = '#07050a'
      ctx.fillRect(0, 0, w, h)
      const cx = w * 0.5
      const cy = h * 0.48
      glow(ctx, cx, cy, w * 0.18, 'rgba(255,190,120,0.55)')
      const r = rng(12)
      ctx.globalCompositeOperation = 'lighter'
      for (let i = 0; i < 70; i++) {
        const a = r() * Math.PI * 2
        const d0 = w * (0.05 + r() * 0.1)
        const d1 = d0 + w * (0.15 + r() * 0.5)
        const g = ctx.createLinearGradient(
          cx + Math.cos(a) * d0,
          cy + Math.sin(a) * d0,
          cx + Math.cos(a) * d1,
          cy + Math.sin(a) * d1,
        )
        const hue = r() < 0.7 ? '255,160,80' : '120,180,255'
        g.addColorStop(0, `rgba(${hue},0)`)
        g.addColorStop(1, `rgba(${hue},${0.25 + r() * 0.45})`)
        ctx.strokeStyle = g
        ctx.lineWidth = 1 + r() * 3
        ctx.beginPath()
        ctx.moveTo(cx + Math.cos(a) * d0, cy + Math.sin(a) * d0)
        ctx.lineTo(cx + Math.cos(a) * d1, cy + Math.sin(a) * d1)
        ctx.stroke()
      }
      ctx.globalCompositeOperation = 'source-over'
      break
    }
    case 'rain': {
      ctx.fillStyle = vgrad(ctx, h, [
        [0, '#0a1a24'],
        [1, '#0e2630'],
      ])
      ctx.fillRect(0, 0, w, h)
      bokeh(ctx, w, h, 44, ['#5fd4c8', '#ffbf6b', '#7aa7ff', '#ff7f9f'], 40, w * 0.07)
      const r = rng(45)
      for (let i = 0; i < 120; i++) {
        const x = r() * w
        const y = r() * h
        const s = 1 + r() * 2.5
        ctx.fillStyle = `rgba(220,240,255,${0.2 + r() * 0.4})`
        ctx.beginPath()
        ctx.ellipse(x, y, s, s * 1.4, 0, 0, Math.PI * 2)
        ctx.fill()
      }
      break
    }
    case 'dancer': {
      ctx.fillStyle = vgrad(ctx, h, [
        [0, '#0d0b16'],
        [1, '#1a1324'],
      ])
      ctx.fillRect(0, 0, w, h)
      glow(ctx, w * 0.5, h * 0.95, w * 0.42, 'rgba(255,200,140,0.35)')
      const g = ctx.createLinearGradient(0, 0, 0, h)
      g.addColorStop(0, 'rgba(255,220,170,0.18)')
      g.addColorStop(1, 'rgba(255,220,170,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.moveTo(w * 0.47, 0)
      ctx.lineTo(w * 0.53, 0)
      ctx.lineTo(w * 0.7, h)
      ctx.lineTo(w * 0.3, h)
      ctx.fill()
      break
    }
    case 'aurora': {
      ctx.fillStyle = vgrad(ctx, h, [
        [0, '#020611'],
        [1, '#0a1626'],
      ])
      ctx.fillRect(0, 0, w, h)
      const r = rng(77)
      for (let i = 0; i < 140; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.2 + r() * 0.6})`
        ctx.fillRect(r() * w, r() * h * 0.6, 1.2, 1.2)
      }
      ctx.globalCompositeOperation = 'lighter'
      const bands: [string, number][] = [
        ['80,255,190', 0.3],
        ['120,160,255', 0.22],
        ['200,110,255', 0.26],
      ]
      bands.forEach(([c, y0], bi) => {
        for (let x = 0; x < w; x += 3) {
          const y = h * (y0 + 0.08 * Math.sin(x / (w * 0.12) + bi * 2))
          const len = h * (0.18 + 0.1 * Math.sin(x / (w * 0.05) + bi))
          const g = ctx.createLinearGradient(0, y, 0, y + len)
          g.addColorStop(0, `rgba(${c},0)`)
          g.addColorStop(0.4, `rgba(${c},0.16)`)
          g.addColorStop(1, `rgba(${c},0)`)
          ctx.fillStyle = g
          ctx.fillRect(x, y, 3, len)
        }
      })
      ctx.globalCompositeOperation = 'source-over'
      skyline(ctx, w, h, h * 1.0, 64, '#03060e', 'rgba(255,220,160,1)', 0.08, 0.22)
      break
    }
  }
}

function drawForeground(ctx: Ctx, scene: SceneId, w: number, h: number): boolean {
  if (scene === 'portrait') {
    person(ctx, w * 0.5, h * 1.02, h / 400, 'rgba(255,120,180,0.9)')
    return true
  }
  if (scene === 'dancer') {
    dancer(ctx, w * 0.5, h * 0.95, h / 430)
    return true
  }
  return false
}

interface SceneLayers {
  bg: HTMLCanvasElement
  fg: HTMLCanvasElement | null
}

const layerCache = new Map<string, SceneLayers>()

export function sceneLayers(scene: SceneId, w = 1280, h = 720): SceneLayers {
  const key = `${scene}:${w}x${h}`
  const hit = layerCache.get(key)
  if (hit) return hit
  const bg = document.createElement('canvas')
  bg.width = w
  bg.height = h
  drawBackground(bg.getContext('2d')!, scene, w, h)
  const fgc = document.createElement('canvas')
  fgc.width = w
  fgc.height = h
  const hasFg = drawForeground(fgc.getContext('2d')!, scene, w, h)
  const layers = { bg, fg: hasFg ? fgc : null }
  layerCache.set(key, layers)
  return layers
}

const thumbCache = new Map<string, string>()

export function sceneThumb(scene: SceneId, w = 320, h = 180): string {
  const key = `${scene}:${w}x${h}`
  const hit = thumbCache.get(key)
  if (hit) return hit
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  const { bg, fg } = sceneLayers(scene, w * 2, h * 2)
  ctx.drawImage(bg, 0, 0, w, h)
  if (fg) ctx.drawImage(fg, 0, 0, w, h)
  const url = c.toDataURL('image/jpeg', 0.86)
  thumbCache.set(key, url)
  return url
}
