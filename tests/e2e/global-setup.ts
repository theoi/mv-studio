import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/.cache')
const REQUIRED = ['song.mp3', 'song.wav', 'clip.mp4', 'clip1080.mp4', 'frames.mp4', 'voice.webm', 'image.png']

export default function globalSetup(): void {
  if (REQUIRED.every((f) => existsSync(path.join(FIXTURE_DIR, f)))) return
  execFileSync('sh', [path.resolve(import.meta.dirname, '../../scripts/make-fixtures.sh')], {
    stdio: 'inherit',
  })
}
