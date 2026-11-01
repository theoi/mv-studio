import { create } from 'zustand'
import {
  BEAT_THIS_MODEL,
  DEMUCS_MODEL,
  MODEL_TITLES,
  WAV2VEC2_MODEL,
  WHISPER_MODELS,
  whisperFileUrls,
} from '../../analysis/models.ts'
import { detectCapabilities } from '../../shared/capabilities.ts'
import { modelCache, type ModelDescriptor, type ModelFile } from '../../shared/models.ts'
import {
  allVisionModelFiles,
  VISION_MODEL_TITLES,
  visionDtype,
  visionModelFiles,
  type VisionDtype,
  type VisionModel,
} from '../../vision/runtime/models.ts'

/** A model a feature downloads on first use, as Settings › This device lists it. */
export interface LocalModel {
  id: string
  title: string
  desc: string
  urls: string[]
  /** Where a file in `urls` was cached before its URL was pinned; the copy moves to its URL when next used. */
  formerUrls?: Record<string, string[]>
  bytes: number
  /** More URLs Remove deletes: the model's files for other devices, and where they were cached before. */
  otherUrls?: string[]
}

function local(id: string, title: string, desc: string, ...models: ModelDescriptor[]): LocalModel {
  return fromFiles(
    id,
    title,
    desc,
    models.flatMap((m) => Object.values(m.files)),
  )
}

function fromFiles(id: string, title: string, desc: string, files: readonly ModelFile[]): LocalModel {
  return {
    id,
    title,
    desc,
    urls: files.map((f) => f.url),
    formerUrls: Object.fromEntries(files.flatMap((f) => (f.formerUrls ? [[f.url, f.formerUrls]] : []))),
    bytes: files.reduce((s, f) => s + (f.bytes ?? 0), 0),
  }
}

/** A vision model as a device loading `dtype` weights downloads it, with its other weights for Remove. */
function vision(id: VisionModel, desc: string, dtype: VisionDtype = 'q8'): LocalModel {
  const model = fromFiles(id, VISION_MODEL_TITLES[id], desc, visionModelFiles(id, dtype))
  const others = allVisionModelFiles(id).filter((f) => !model.urls.includes(f.url))
  return { ...model, otherUrls: others.flatMap((f) => [f.url, ...(f.formerUrls ?? [])]) }
}

const isVisionModel = (id: string): id is VisionModel => id in VISION_MODEL_TITLES

async function isCached(model: LocalModel, url: string): Promise<boolean> {
  for (const u of [url, ...(model.formerUrls?.[url] ?? [])]) if (await modelCache.has(u)) return true
  return false
}

async function fileCached(file: ModelFile): Promise<boolean> {
  for (const u of [file.url, ...(file.formerUrls ?? [])])
    if (await modelCache.has(u).catch(() => false)) return true
  return false
}

/** The weights the vision models load on this device (`visionDtype`). */
async function deviceDtype(): Promise<VisionDtype> {
  return visionDtype(await detectCapabilities())
}

/** Bytes a vision model still has to download on this device, for the cost lines; 0 when it is cached. */
export async function visionDownloadBytes(id: VisionModel): Promise<number> {
  const files = visionModelFiles(id, await deviceDtype())
  const cached = await Promise.all(files.map(fileCached))
  return files.reduce((sum, f, i) => sum + (cached[i] ? 0 : (f.bytes ?? 0)), 0)
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
  vision('cutout', 'Text behind the subject'),
  vision('matte', 'Cleaner edges where text overlaps the person'),
  vision('picker', 'Pick an object to put text behind'),
  vision('depth', '3D camera on stills'),
  vision('tagger', 'Search and match clips'),
]

/** The models with the vision models' files for a device loading `dtype` weights; `LOCAL_MODELS` are q8. */
export function localModels(dtype: VisionDtype): LocalModel[] {
  return LOCAL_MODELS.map((m) => (isVisionModel(m.id) ? vision(m.id, m.desc, dtype) : m))
}

/** How much of a model is in the browser's model cache: every file, some (an interrupted download) or none. */
export type ModelDownload = 'all' | 'some' | 'none'

interface ModelsState {
  /** The models as this device downloads them (`localModels`); `LOCAL_MODELS` until checked. */
  models: LocalModel[]
  /** How much of each model is downloaded (null until checked). */
  cached: Record<string, ModelDownload> | null
  /** Bytes the model cache holds, every model included (null until checked). */
  bytes: number | null
}

export const useModels = create<ModelsState>(() => ({ models: LOCAL_MODELS, cached: null, bytes: null }))

export async function refreshModels(): Promise<void> {
  const models = localModels(await deviceDtype())
  const [entries, usage] = await Promise.all([
    Promise.all(
      models.map(async (m) => {
        const has = await Promise.all(m.urls.map((u) => isCached(m, u)))
        const download: ModelDownload = has.every(Boolean) ? 'all' : has.some(Boolean) ? 'some' : 'none'
        return [m.id, download] as const
      }),
    ),
    modelCache.usage(),
  ])
  useModels.setState({ models, cached: Object.fromEntries(entries), bytes: usage.bytes })
}

/** Deletes one downloaded model; its feature downloads it again when next used. */
export async function removeModel(id: string): Promise<void> {
  const model = useModels.getState().models.find((m) => m.id === id)
  if (!model) return
  const urls = [...model.urls, ...Object.values(model.formerUrls ?? {}).flat(), ...(model.otherUrls ?? [])]
  await Promise.all(urls.map((url) => modelCache.remove(url)))
  await refreshModels()
}

/** Deletes every downloaded model; features download them again when next used. Returns the bytes freed. */
export async function clearModels(): Promise<number> {
  const { bytes } = await modelCache.usage()
  await modelCache.clear()
  await refreshModels()
  return bytes
}
