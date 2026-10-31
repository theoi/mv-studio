import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

/**
 * The build writes the license texts and copyright notices of everything it bundles to the site's root (linked from
 * Settings › About), because the minifier drops them from the code. The list comes from the modules that actually
 * went into the main and worker bundles, so it follows the dependencies without upkeep. The build fails when a
 * bundled package has no license text, so a new dependency cannot ship without one.
 */
const LICENSES_FILE = 'third-party-licenses.txt'

/**
 * For bundled packages whose npm package lacks them: the upstream license text (a file under licenses/), or the SPDX
 * license id when package.json has none that can be read.
 */
const PACKAGE_LICENSES: Record<string, { text?: string; license?: string }> = {
  '@mediapipe/tasks-vision': { text: 'licenses/packages/mediapipe-tasks-vision.txt' },
  'onnxruntime-common': { text: 'licenses/onnxruntime/LICENSE' },
  'onnxruntime-web': { text: 'licenses/onnxruntime/LICENSE' },
  'react-remove-scroll-bar': { text: 'licenses/packages/react-remove-scroll-bar.txt' },
  robot3: { text: 'licenses/packages/robot3.txt' },
}

/** Code adapted into MV Studio's own source, whose notices the minifier also drops. */
const ADAPTED_CODE = [
  {
    name: 'coi-serviceworker 0.1.7',
    source: 'https://github.com/gzuidhof/coi-serviceworker',
    use: 'coi-serviceworker.js, modified',
    text: 'licenses/adapted/coi-serviceworker.txt',
  },
  {
    name: 'Hash without Sine',
    source: 'https://www.shadertoy.com/view/4djSRW',
    use: 'hash functions in the shaders',
    text: 'licenses/adapted/hash-without-sine.txt',
  },
  {
    name: 'Beat This! 1.1.0',
    source: 'https://github.com/CPJKU/beat_this',
    use: 'audio preprocessing and inference windowing',
    text: 'licenses/adapted/beat-this.txt',
  },
  {
    name: 'beat-this (JavaScript port)',
    source: 'https://github.com/jgorset/beat-this',
    use: 'audio preprocessing and inference windowing',
    text: 'licenses/adapted/beat-this-web.txt',
  },
  {
    name: 'Demucs',
    source: 'https://github.com/facebookresearch/demucs',
    use: 'stem separation pre- and post-processing',
    text: 'licenses/adapted/demucs.txt',
  },
  {
    name: 'demucs-web (timcsy)',
    source: 'https://github.com/timcsy/demucs-web',
    use: 'stem separation pre- and post-processing',
    text: 'licenses/adapted/demucs-web.txt',
  },
]

/**
 * The microsoft/onnxruntime commit whose LICENSE and ThirdPartyNotices.txt are in licenses/onnxruntime. The WASM
 * build in onnxruntime-web compiles in the components those notices cover, so they must match its commit.
 */
const ONNXRUNTIME_NOTICES_COMMIT = '8d85527a010e294a26b274749f74294b2a32cec5'

interface PackageJson {
  name: string
  version: string
  license?: string | { type?: string }
  /** The deprecated form some older packages still publish. */
  licenses?: Array<string | { type?: string }>
  repository?: string | { url?: string }
  homepage?: string
}

interface BundledPackage {
  name: string
  version: string
  license: string
  source: string | undefined
  dir: string
  text: string
}

const SECTION = '-'.repeat(80)

/** The directory of the package a bundled module comes from, or null for MV Studio's own and virtual modules. */
function packageDir(moduleId: string): string | null {
  const path = moduleId
    .replace(/^\0/, '')
    .replace(/[?#].*$/, '')
    .replaceAll('\\', '/')
  const marker = '/node_modules/'
  const at = path.lastIndexOf(marker)
  if (at < 0) return null
  const [scope = '', name = ''] = path.slice(at + marker.length).split('/')
  return path.slice(0, at + marker.length) + (scope.startsWith('@') ? `${scope}/${name}` : scope)
}

function repositoryUrl(pkg: PackageJson): string | undefined {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  if (!raw) return pkg.homepage
  const url = raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '')
  return /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : url
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), 'utf8').replaceAll('\r\n', '\n').trim()
}

/** Reads a file a dependency is expected to ship, saying what to update when an upgrade dropped it. */
function need(root: string, path: string, otherwise: string): string {
  try {
    return read(root, path)
  } catch (cause) {
    throw new Error(`${join(root, path)} is missing. ${otherwise}`, { cause })
  }
}

function licenseId(pkg: PackageJson): string | undefined {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license?.type) return pkg.license.type
  const legacy = (pkg.licenses ?? []).map((l) => (typeof l === 'string' ? l : l.type)).filter(Boolean)
  return legacy.length ? legacy.join(' OR ') : undefined
}

function describe(dir: string, root: string): BundledPackage {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson
  const files = readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(f) && statSync(join(dir, f)).isFile())
    .sort()
  const override = PACKAGE_LICENSES[pkg.name]
  const text = files.map((f) => read(dir, f)).join('\n\n') || (override?.text && read(root, override.text))
  const license = licenseId(pkg) ?? override?.license
  const where = `${pkg.name}@${pkg.version} (${dir})`
  if (!text)
    throw new Error(
      `${where} is bundled but ships no license text. Add its upstream license text under licenses/packages ` +
        "and set it as the package's `text` in PACKAGE_LICENSES (scripts/third-party-licenses.ts).",
    )
  if (!license)
    throw new Error(
      `${where} is bundled but its package.json names no license. Set the package's SPDX id as \`license\` in ` +
        'PACKAGE_LICENSES (scripts/third-party-licenses.ts).',
    )
  return { name: pkg.name, version: pkg.version, license, source: repositoryUrl(pkg), dir, text }
}

function onnxRuntimeSection(ort: BundledPackage): string {
  const commit = need(
    ort.dir,
    '__commit.txt',
    `onnxruntime-web ${ort.version} no longer says which microsoft/onnxruntime commit its WASM is built from. ` +
      'Find it (dev versions end in a commit prefix), then replace licenses/onnxruntime/LICENSE and ' +
      "ThirdPartyNotices.txt with that commit's files and update ONNXRUNTIME_NOTICES_COMMIT.",
  )
  if (commit !== ONNXRUNTIME_NOTICES_COMMIT) {
    const raw = `https://raw.githubusercontent.com/microsoft/onnxruntime/${commit}`
    throw new Error(
      `onnxruntime-web ${ort.version} is built from microsoft/onnxruntime ${commit}, but licenses/onnxruntime holds ` +
        `the notices of ${ONNXRUNTIME_NOTICES_COMMIT}. Replace licenses/onnxruntime/LICENSE with ${raw}/LICENSE ` +
        `and licenses/onnxruntime/ThirdPartyNotices.txt with ${raw}/ThirdPartyNotices.txt, and set ` +
        'ONNXRUNTIME_NOTICES_COMMIT to that commit.',
    )
  }
  return [
    `The WebAssembly build of ONNX Runtime in onnxruntime-web ${ort.version} (ort-wasm-*.wasm) is built from`,
    `https://github.com/microsoft/onnxruntime/tree/${commit}`,
    'and compiles in third-party components such as Eigen, XNNPACK, protobuf, re2, Abseil, flatbuffers, ONNX and',
    "SafeInt. ONNX Runtime's license and the notices of those components, from that commit, are in:",
    '',
    '  licenses/onnxruntime/LICENSE.txt',
    '  licenses/onnxruntime/ThirdPartyNotices.txt',
  ].join('\n')
}

function ffmpegSection(aac: BundledPackage): string {
  const readme = need(
    aac.dir,
    'README.md',
    `Find the FFmpeg source of @mediabunny/aac-encoder ${aac.version} and update ffmpegSection ` +
      '(scripts/third-party-licenses.ts).',
  )
  const found = /FFmpeg \[`([0-9a-f]{40})`\]\([^)]*\) \(`([^`]+)`\), unmodified/.exec(readme)
  if (!found)
    throw new Error(
      `The README of @mediabunny/aac-encoder ${aac.version} no longer names the FFmpeg commit its encoder is built ` +
        'from. Find the source of this version and update ffmpegSection (scripts/third-party-licenses.ts).',
    )
  const [, commit, describeName] = found
  return [
    `@mediabunny/aac-encoder ${aac.version} contains a WebAssembly build of the AAC encoder of FFmpeg, which is`,
    'licensed under the GNU Lesser General Public License 2.1 or later. It is in its own file',
    '(mediabunny-aac-encoder-*.js), which loads only when the browser has no AAC encoder of its own.',
    '',
    `Source: FFmpeg ${commit} (${describeName}), unmodified:`,
    `https://github.com/FFmpeg/FFmpeg/commit/${commit}`,
    'Build instructions:',
    `https://github.com/Vanilagy/mediabunny/tree/v${aac.version}/packages/aac-encoder#building-and-development`,
    'To use a modified FFmpeg, rebuild the encoder with those steps and replace that file.',
    '',
    "FFmpeg's license files:",
    '',
    '  licenses/ffmpeg/LICENSE.txt',
    '  licenses/ffmpeg/COPYING.LGPLv2.1.txt',
  ].join('\n')
}

function render(packages: BundledPackage[], root: string, version: string): string {
  const groups = new Map<string, BundledPackage[]>()
  for (const p of packages) groups.set(p.text, [...(groups.get(p.text) ?? []), p])
  const ort = packages.find((p) => p.name === 'onnxruntime-web')
  const aac = packages.find((p) => p.name === '@mediabunny/aac-encoder')
  const sections = [
    `1. Packages (${packages.length})`,
    '2. Code adapted into MV Studio',
    ...(ort ? ['3. ONNX Runtime WebAssembly'] : []),
    ...(aac ? [`${ort ? 4 : 3}. FFmpeg AAC encoder`] : []),
  ]
  const out = [
    `Third-party software in MV Studio ${version}`,
    '',
    'This build of MV Studio bundles the open-source software below. The list was made when the site was built,',
    'from the code that went into it. Each package is listed with its version, license and source, followed by its',
    'license text and copyright notices. Packages with the same license text share one copy of it.',
    '',
    'MV Studio itself is MIT-licensed: https://github.com/theoi/mv-studio/blob/main/LICENSE',
    'AI models are not part of the site. The browser downloads them from their hosts on first use; their sources',
    'and licenses are in https://github.com/theoi/mv-studio/blob/main/THIRD_PARTY_NOTICES.md',
    '',
    ...sections,
    '',
    SECTION,
    sections[0],
    SECTION,
  ]
  const ordered = [...groups.values()].sort((a, b) => a[0]!.name.localeCompare(b[0]!.name))
  for (const group of ordered) {
    out.push('')
    for (const p of group) out.push(`${p.name} ${p.version} (${p.license})${p.source ? ` ${p.source}` : ''}`)
    // MPL-2.0 asks to tell recipients where the source of the shipped version is.
    for (const p of group)
      if (p.license === 'MPL-2.0' && p.source?.startsWith('https://github.com/'))
        out.push(`Source of ${p.name} ${p.version}: ${p.source}/tree/v${p.version}`)
    out.push('', group[0]!.text, '', SECTION)
  }
  out.push(sections[1]!, SECTION)
  for (const code of ADAPTED_CODE)
    out.push('', `${code.name}: ${code.use}. ${code.source}`, '', read(root, code.text), '', SECTION)
  if (ort) out.push(sections[2]!, SECTION, '', onnxRuntimeSection(ort), '', SECTION)
  if (aac) out.push(sections.at(-1)!, SECTION, '', ffmpegSection(aac), '', SECTION)
  return out.join('\n') + '\n'
}

/**
 * `plugin` goes in the main build, `workerPlugin` in `worker.plugins`. Workers are bundled while the main build
 * transforms the code that starts them, so their modules are known by the time the main bundle is generated.
 */
export function thirdPartyLicenses(version: string): { plugin: Plugin; workerPlugin: () => Plugin } {
  const moduleIds = new Set<string>()
  const collect = (bundle: Record<string, { type: string; moduleIds?: string[] }>) => {
    for (const out of Object.values(bundle))
      if (out.type === 'chunk') for (const id of out.moduleIds ?? []) moduleIds.add(id)
  }
  let root = process.cwd()
  return {
    workerPlugin: () => ({
      name: 'mv-studio:third-party-licenses-worker',
      apply: 'build',
      generateBundle(_, bundle) {
        collect(bundle)
      },
    }),
    plugin: {
      name: 'mv-studio:third-party-licenses',
      apply: 'build',
      configResolved(config) {
        root = config.root
      },
      // Workers are bundled after this, during the main build's transforms; a watch rebuild starts afresh.
      buildStart() {
        moduleIds.clear()
      },
      generateBundle(_, bundle) {
        collect(bundle)
        // One module per package, to name in errors.
        const dirs = new Map<string, string>()
        for (const id of moduleIds) {
          const dir = packageDir(id)
          if (dir && !dirs.has(dir)) dirs.set(dir, id)
        }
        const byKey = new Map<string, BundledPackage>()
        for (const [dir, id] of dirs) {
          let p: BundledPackage
          try {
            p = describe(dir, root)
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause)
            throw new Error(`${message} (bundled through ${id})`, { cause })
          }
          byKey.set(`${p.name}@${p.version}`, p)
        }
        const packages = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name))
        const emit = (fileName: string, source: string) => this.emitFile({ type: 'asset', fileName, source })
        emit(LICENSES_FILE, render(packages, root, version))
        if (packages.some((p) => p.name === 'onnxruntime-web')) {
          emit('licenses/onnxruntime/LICENSE.txt', read(root, 'licenses/onnxruntime/LICENSE') + '\n')
          emit(
            'licenses/onnxruntime/ThirdPartyNotices.txt',
            read(root, 'licenses/onnxruntime/ThirdPartyNotices.txt') + '\n',
          )
        }
        const aac = packages.find((p) => p.name === '@mediabunny/aac-encoder')
        if (aac) {
          const otherwise =
            `@mediabunny/aac-encoder ${aac.version} no longer ships FFmpeg's license files there. Find them for ` +
            'this version and update the files emitted for FFmpeg (scripts/third-party-licenses.ts).'
          emit('licenses/ffmpeg/LICENSE.txt', need(aac.dir, 'licenses/ffmpeg/LICENSE.md', otherwise) + '\n')
          emit(
            'licenses/ffmpeg/COPYING.LGPLv2.1.txt',
            need(aac.dir, 'licenses/ffmpeg/COPYING.LGPLv2.1', otherwise) + '\n',
          )
        }
      },
    },
  }
}
