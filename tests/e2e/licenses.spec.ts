import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'

const DIST = path.resolve(import.meta.dirname, '../../dist')
const ASSETS = path.join(DIST, 'assets')
const read = (file: string) => readFileSync(path.join(DIST, file), 'utf8')

/**
 * "name version" of every package whose code is in the build, from the bundles' source maps, independently of how
 * the build collects them for the license file.
 */
function bundledPackages(): Set<string> {
  const found = new Set<string>()
  for (const file of readdirSync(ASSETS).filter((f) => f.endsWith('.js.map'))) {
    const { sources } = JSON.parse(readFileSync(path.join(ASSETS, file), 'utf8')) as { sources: string[] }
    for (const source of sources) {
      const at = source.lastIndexOf('node_modules/') + 'node_modules/'.length
      if (at < 'node_modules/'.length) continue
      const [scope = '', name = ''] = source.slice(at).split('/')
      const pkg = scope.startsWith('@') ? `${scope}/${name}` : scope
      const json = path.resolve(ASSETS, source.slice(0, at), pkg, 'package.json')
      found.add(`${pkg} ${(JSON.parse(readFileSync(json, 'utf8')) as { version: string }).version}`)
    }
  }
  return found
}

test('the build ships the license text of every package it bundles', () => {
  const listed = new Set(read('third-party-licenses.txt').match(/^@?[\w.-]+(\/[\w.-]+)? \S+(?= \()/gm))
  const bundled = bundledPackages()
  // Without source maps this would pass with nothing to check.
  expect(bundled.size).toBeGreaterThan(50)
  expect([...bundled].filter((p) => !listed.has(p))).toEqual([])

  // Font files are assets rather than code: each must come from a listed Fontsource package.
  const families = [...listed].filter((p) => p.startsWith('@fontsource')).map((p) => p.split(/[/ ]/)[1]!)
  const fonts = readdirSync(ASSETS).filter((f) => f.endsWith('.woff2'))
  expect(fonts.length).toBeGreaterThan(0)
  expect(fonts.filter((f) => !families.some((family) => f.startsWith(`${family}-`)))).toEqual([])
})

test('the ONNX Runtime and FFmpeg builds ship with their notices and source, and the service worker with its own', () => {
  const assets = readdirSync(ASSETS)
  const text = read('third-party-licenses.txt')

  expect(assets.some((f) => /^ort-wasm.*\.wasm$/.test(f))).toBe(true)
  expect(read('licenses/onnxruntime/LICENSE.txt')).toContain('Copyright (c) Microsoft Corporation')
  expect(read('licenses/onnxruntime/ThirdPartyNotices.txt')).toContain('THIRD PARTY SOFTWARE NOTICES')
  expect(text).toMatch(/github\.com\/microsoft\/onnxruntime\/tree\/[0-9a-f]{40}/)

  expect(assets.some((f) => f.startsWith('mediabunny-aac-encoder'))).toBe(true)
  expect(read('licenses/ffmpeg/COPYING.LGPLv2.1.txt')).toContain('GNU LESSER GENERAL PUBLIC LICENSE')
  expect(read('licenses/ffmpeg/LICENSE.txt')).toContain('FFmpeg')
  expect(text).toMatch(/github\.com\/FFmpeg\/FFmpeg\/commit\/[0-9a-f]{40}/)
  expect(text).toMatch(/mediabunny\/tree\/v[\d.]+\/packages\/aac-encoder#building-and-development/)

  expect(read('coi-serviceworker.js')).toContain('Copyright (c) 2021 Guido Zuidhof')
})
