#!/usr/bin/env node
// Downloads the CC0 / public-domain Wikimedia Commons clips used by the vision benchmarks
// (tests/e2e/vision-models.spec.ts) and cuts the analysed segments with ffmpeg.
// Output: tests/fixtures/.cache/vision/<name>.webm. Sources are verified by SHA-256 before cutting.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const OUT = path.resolve(import.meta.dirname, '../tests/fixtures/.cache/vision')

/** name, Commons file name, license, author, analysed segment [start, end] in seconds. Checksums of the 480p VP9 transcodes are in vision-fixtures.sha256.json. */
export const CLIPS = [
  [
    'people_teacher',
    'Interview_with_a_Teacher_-_Glen_Caruso.webm',
    'CC0',
    'Chase Bohannon, Glen Caruso',
    [60, 68],
  ],
  ['people_interview', 'Entrevista_Maricarmen_Canales_-_TECMTY.webm', 'CC0', 'NachoCHOCO', [40, 48]],
  ['people_dance', "Chinese_fitness_dancing_in_Haikou_People's_Park.ogv", 'CC0', 'Anna Frodesiak', [5, 13]],
  ['city_street', 'Spiegelgasse.ogv', 'CC0', 'Albinfo', [20, 28]],
  [
    'nature_creek',
    'Overlooking_a_forest_creek_in_the_Tsimpsean_Peninsula.webm',
    'CC0',
    'Extemporalist',
    [10, 18],
  ],
  ['rain_street', 'Cyberpunk_Rainy_Street_(Hailuo_AI).webm', 'Public domain', 'VulcanSphere', [0, 5.5]],
]

const SHA256 = JSON.parse(readFileSync(path.join(import.meta.dirname, 'vision-fixtures.sha256.json'), 'utf8'))

function transcodeUrl(file) {
  const md5 = createHash('md5').update(file).digest('hex')
  const enc = encodeURIComponent(file)
  return `https://upload.wikimedia.org/wikipedia/commons/transcoded/${md5[0]}/${md5.slice(0, 2)}/${enc}/${enc}.480p.vp9.webm`
}

async function download(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      headers: { 'user-agent': 'mv-studio-test-fixtures/1.0 (https://github.com/theoi/mv-studio)' },
    })
    if (res.ok) return Buffer.from(await res.arrayBuffer())
    if (res.status !== 429 && res.status < 500) throw new Error(`${res.status} for ${url}`)
    const wait = Number(res.headers.get('retry-after')) || 30 * (attempt + 1)
    console.log(`  ${res.status}, retrying in ${wait} s`)
    await new Promise((r) => setTimeout(r, wait * 1000))
  }
  throw new Error(`Giving up on ${url}`)
}

mkdirSync(OUT, { recursive: true })
const update = process.argv.includes('--update-checksums')
for (const [name, file, license, author, [start, end]] of CLIPS) {
  const out = path.join(OUT, `${name}.webm`)
  if (existsSync(out)) continue
  console.log(`${name}: ${file} (${license}, ${author})`)
  const data = await download(transcodeUrl(file))
  const sha = createHash('sha256').update(data).digest('hex')
  if (update) SHA256[name] = sha
  else if (SHA256[name] !== sha)
    throw new Error(`${name}: checksum mismatch (got ${sha}); the Commons transcode changed`)
  const src = path.join(OUT, `${name}.source.webm`)
  writeFileSync(src, data)
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(start),
    '-i',
    src,
    '-t',
    String(end - start),
    '-an',
    '-c:v',
    'libvpx-vp9',
    '-b:v',
    '0',
    '-crf',
    '32',
    '-row-mt',
    '1',
    '-deadline',
    'realtime',
    out,
  ])
}
if (update)
  writeFileSync(
    path.join(import.meta.dirname, 'vision-fixtures.sha256.json'),
    JSON.stringify(SHA256, null, 2) + '\n',
  )
console.log(`Vision fixtures in ${OUT}`)
