/// <reference lib="webworker" />
import { ALL_FORMATS, BlobSource, Input, VideoSample, VideoSampleSink } from 'mediabunny'
import { previewColorSpace, retag } from '../../engine/frames.ts'
import { JobError } from '../../shared/jobs.ts'
import { exposeWorker, transfer } from '../../shared/worker.ts'
import { fitSize } from '../runtime/frames.ts'

/** Video files opened for small frames (thumbnails), decoded with WebCodecs off the page's thread. */

interface Opened {
  input: Input
  samples: VideoSampleSink
  width: number
  height: number
  first: number
  /** Set when frames need another color tag to look as they do in the preview's <video>. */
  colorSpace: VideoColorSpaceInit | null
}

const opened = new Map<string, Opened>()

const api = {
  async open({ id, file }: { id: string; file: Blob }) {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
    try {
      const track = await input.getPrimaryVideoTrack()
      if (!track || !(await track.canDecode()))
        throw new JobError('decode', 'No video this browser can decode')
      const [width, height, first, duration, colorSpace] = await Promise.all([
        track.getDisplayWidth(),
        track.getDisplayHeight(),
        track.getFirstTimestamp(),
        track.computeDuration(),
        previewColorSpace(track),
      ])
      opened.set(id, { input, samples: new VideoSampleSink(track), width, height, first, colorSpace })
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
    const sample = await video.samples.getSample(Math.max(t, video.first))
    if (!sample) throw new JobError('decode', `No frame at ${t.toFixed(3)} s`)
    let shown: VideoSample | null = null
    try {
      const frame = sample.toVideoFrame()
      const tagged = video.colorSpace ? await retag(frame, video.colorSpace) : frame
      shown = new VideoSample(tagged, { rotation: sample.rotation, flip: sample.flip })
      const size = fitSize(video, maxSide ?? Infinity)
      const canvas = new OffscreenCanvas(size.width, size.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new JobError('internal', 'No 2D canvas for a frame')
      shown.drawWithFit(ctx, { fit: 'fill' })
      const bitmap = canvas.transferToImageBitmap()
      return transfer(bitmap, [bitmap])
    } finally {
      shown?.close()
      sample.close()
    }
  },

  close({ id }: { id: string }) {
    opened.get(id)?.input.dispose()
    opened.delete(id)
  },
}

export type FramesWorkerApi = typeof api

exposeWorker(api)
