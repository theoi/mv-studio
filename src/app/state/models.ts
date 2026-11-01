import { create } from 'zustand'
import {
  BEAT_THIS_MODEL,
  DEMUCS_MODEL,
  MODEL_TITLES,
  WAV2VEC2_MODEL,
  WHISPER_MODELS,
  whisperFileUrls,
} from '../../analysis/models.ts'
import { modelCache, type ModelDescriptor } from '../../shared/models.ts'
import { VISION_MODELS } from '../../vision/runtime/models.ts'

/** A model a feature downloads on first use, as Settings › This device lists it. */
export interface LocalModel {
  id: string
  title: string
  desc: string
  urls: string[]
  bytes: number
}

function local(id: string, title: string, desc: string, ...models: ModelDescriptor[]): LocalModel {
  const files = models.flatMap((m) => Object.values(m.files))
  return {
    id,
    title,
    desc,
    urls: files.map((f) => f.url),
    bytes: files.reduce((s, f) => s + (f.bytes ?? 0), 0),
  }
}

const whisper = WHISPER_MODELS.small

export const LOCAL_MODELS: LocalModel[] = [
  local('beats', MODEL_TITLES.beats, 'Tempo, beats and bar starts', BEAT_THIS_MODEL),
  local('stems', MODEL_TITLES.stems, 'Vocals, drums, bass and other', DEMUCS_MODEL),
  {
    id: 'transcriber',
    title: MODEL_TITLES.transcriber,
    desc: 'Drafts lyrics from the vocals',
    urls: whisperFileUrls(whisper),
    bytes: whisper.bytes,
  },
  local('aligner', MODEL_TITLES.aligner, 'Times each word to the vocals', WAV2VEC2_MODEL),
  local(
    'cutout',
    'Person cutout',
    'Text behind the subject',
    VISION_MODELS.selfieLandscape,
    VISION_MODELS.faceShortRange,
    VISION_MODELS.personDetector,
  ),
  local('matte', 'Cutout edges', 'Cleaner edges where text overlaps the person', VISION_MODELS.modnet),
  local('depth', 'Depth', '3D camera on stills', VISION_MODELS.depthAnythingSmall),
  local('tagger', 'Footage tagger', 'Search and match clips', VISION_MODELS.clipB32),
]

/** How much of a model is in the browser's model cache: every file, some (an interrupted download) or none. */
export type ModelDownload = 'all' | 'some' | 'none'

interface ModelsState {
  /** How much of each model is downloaded (null until checked). */
  cached: Record<string, ModelDownload> | null
  /** Bytes the model cache holds, every model included (null until checked). */
  bytes: number | null
}

export const useModels = create<ModelsState>(() => ({ cached: null, bytes: null }))

export async function refreshModels(): Promise<void> {
  const [entries, usage] = await Promise.all([
    Promise.all(
      LOCAL_MODELS.map(async (m) => {
        const has = await Promise.all(m.urls.map((u) => modelCache.has(u)))
        const download: ModelDownload = has.every(Boolean) ? 'all' : has.some(Boolean) ? 'some' : 'none'
        return [m.id, download] as const
      }),
    ),
    modelCache.usage(),
  ])
  useModels.setState({ cached: Object.fromEntries(entries), bytes: usage.bytes })
}

/** Deletes one downloaded model; its feature downloads it again when next used. */
export async function removeModel(id: string): Promise<void> {
  const model = LOCAL_MODELS.find((m) => m.id === id)
  if (!model) return
  await Promise.all(model.urls.map((url) => modelCache.remove(url)))
  await refreshModels()
}

/** Deletes every downloaded model; features download them again when next used. Returns the bytes freed. */
export async function clearModels(): Promise<number> {
  const { bytes } = await modelCache.usage()
  await modelCache.clear()
  await refreshModels()
  return bytes
}
