import { describe, expect, it } from 'vitest'
import { defaultExportSettings, defaultVideoBitrate, exportSize } from '../../../src/engine/export.ts'
import { createProject } from '../../../src/model/factory.ts'

describe('export presets', () => {
  it('names resolutions by the shorter side for every aspect', () => {
    expect(exportSize('16:9', '1080p')).toEqual({ width: 1920, height: 1080 })
    expect(exportSize('9:16', '1080p')).toEqual({ width: 1080, height: 1920 })
    expect(exportSize('4:5', '720p')).toEqual({ width: 720, height: 900 })
    expect(exportSize('1:1', '1440p')).toEqual({ width: 1440, height: 1440 })
    expect(exportSize('16:9', '2160p')).toEqual({ width: 3840, height: 2160 })
  })

  it('scales the bitrate with pixels per second, at a lower density for high frame rates', () => {
    expect(defaultVideoBitrate(1920, 1080, 30)).toBe(9_953_280)
    expect(defaultVideoBitrate(1920, 1080, 60)).toBe(14_929_920)
  })

  it('defaults to the project aspect and frame rate at 1080p', () => {
    const project = createProject({ aspect: '9:16', fps: 24 })
    expect(defaultExportSettings(project)).toEqual({ width: 1080, height: 1920, fps: 24, aspect: '9:16' })
  })
})
