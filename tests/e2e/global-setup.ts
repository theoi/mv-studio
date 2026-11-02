import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/.cache')
const REQUIRED = [
  'song.mp3',
  'song.wav',
  'tagged.mp3',
  'tagged.m4a',
  'clip.mp4',
  'clip1080.mp4',
  'clip4k.mp4',
  'clip-rotated.mp4',
  'clear.webm',
  'frames.mp4',
  'voice.webm',
  'image.png',
  'speech.wav',
]

export default function globalSetup(): void {
  if (REQUIRED.every((f) => existsSync(path.join(FIXTURE_DIR, f)))) return
  execFileSync('sh', [path.resolve(import.meta.dirname, '../../scripts/make-fixtures.sh')], {
    stdio: 'inherit',
  })
}
