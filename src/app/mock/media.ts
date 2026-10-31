import type { SceneId } from './art.ts'

export interface MediaItem {
  id: string
  name: string
  type: 'video' | 'image' | 'audio' | 'generated'
  scene: SceneId
  duration?: number
  tags: string[]
  subject?: 'large' | 'small' | 'none'
}

export const media: MediaItem[] = [
  {
    id: 'm-city',
    name: 'Night city',
    type: 'video',
    scene: 'city',
    duration: 14.2,
    tags: ['night', 'city', 'lights', 'calm'],
    subject: 'none',
  },
  {
    id: 'm-singer',
    name: 'Singer close-up',
    type: 'video',
    scene: 'portrait',
    duration: 22.6,
    tags: ['person', 'close-up', 'moody'],
    subject: 'large',
  },
  {
    id: 'm-crowd',
    name: 'Concert crowd',
    type: 'video',
    scene: 'crowd',
    duration: 18.0,
    tags: ['crowd', 'stage', 'energetic'],
    subject: 'small',
  },
  {
    id: 'm-neon',
    name: 'Neon grid',
    type: 'video',
    scene: 'neon',
    duration: 10.0,
    tags: ['neon', 'retro', 'energetic'],
    subject: 'none',
  },
  {
    id: 'm-ocean',
    name: 'Ocean drive',
    type: 'video',
    scene: 'ocean',
    duration: 16.4,
    tags: ['water', 'blue', 'motion'],
    subject: 'none',
  },
  {
    id: 'm-tunnel',
    name: 'Tunnel lights',
    type: 'video',
    scene: 'tunnel',
    duration: 8.8,
    tags: ['motion', 'fast', 'lights'],
    subject: 'none',
  },
  {
    id: 'm-sunset',
    name: 'Rooftop sunset',
    type: 'image',
    scene: 'sunset',
    tags: ['sunset', 'warm', 'calm'],
    subject: 'none',
  },
  {
    id: 'm-rain',
    name: 'Rain on glass',
    type: 'video',
    scene: 'rain',
    duration: 12.0,
    tags: ['rain', 'bokeh', 'calm'],
    subject: 'none',
  },
  {
    id: 'm-dancer',
    name: 'Dancer',
    type: 'video',
    scene: 'dancer',
    duration: 9.5,
    tags: ['person', 'motion', 'energetic'],
    subject: 'large',
  },
  {
    id: 'm-aurora',
    name: 'Aurora over the city',
    type: 'generated',
    scene: 'aurora',
    duration: 5.0,
    tags: ['generated', 'sky', 'dreamy'],
    subject: 'none',
  },
]

export const mediaById = Object.fromEntries(media.map((m) => [m.id, m]))
