/// <reference lib="webworker" />
import { ALL_FORMATS, BlobSource, CanvasSink, Input, type InputVideoTrack } from 'mediabunny'
import { JobError } from '../../shared/jobs.ts'
import { exposeWorker, transfer } from '../../shared/worker.ts'
import { fitSize } from '../runtime/frames.ts'

/** Video files opened for small frames (thumbnails), decoded with WebCodecs off the page's thread. */

interface Opened {
  input: Input
  track: InputVideoTrack
  width: number
  height: number
  first: number
  /** One sink per output size. */
  sinks: Map<string, CanvasSink>
}

const opened = new Map<string, Opened>()

const api = {
  async open({ id, file }: { id: string; file: Blob }) {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
    try {
      const track = await input.getPrimaryVideoTrack()
      if (!track || !(await track.canDecode()))
        throw new JobError('decode', 'No video this browser can decode')
      const [width, height, first, duration] = await Promise.all([
        track.getDisplayWidth(),
        track.getDisplayHeight(),
        track.getFirstTimestamp(),
        track.computeDuration(),
      ])
      opened.set(id, { input, track, width, height, first, sinks: new Map() })
      return { width, height, duration }
    } catch (error) {
      input.dispose()
      throw error
    }
  },

  /** The frame shown at `t`, scaled so its longer side is at most `maxSide`. */
  async frame({ id, t, maxSide }: { id: string; t: number; maxSide?: number }) {
    const video = opened.get(id)
    if (!video) throw new JobError('decode', 'The video is not open')
    const size = fitSize(video, maxSide ?? Infinity)
    const key = `${size.width}x${size.height}`
    let sink = video.sinks.get(key)
    if (!sink) {
      sink = new CanvasSink(video.track, { width: size.width, height: size.height, fit: 'fill' })
      video.sinks.set(key, sink)
    }
    const wrapped = await sink.getCanvas(Math.max(t, video.first))
    if (!wrapped) throw new JobError('decode', `No frame at ${t.toFixed(3)} s`)
    const canvas = wrapped.canvas as OffscreenCanvas
    const bitmap = canvas.transferToImageBitmap()
    return transfer(bitmap, [bitmap])
  },

  close({ id }: { id: string }) {
    opened.get(id)?.input.dispose()
    opened.delete(id)
  },
}

export type FramesWorkerApi = typeof api

exposeWorker(api)
