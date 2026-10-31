#!/bin/sh
# Generates synthetic e2e test media with ffmpeg (no copyrighted material). Output: tests/fixtures/.cache/
set -e
out="$(dirname "$0")/../tests/fixtures/.cache"
mkdir -p "$out"
cd "$out"
q="-y -hide_banner -loglevel error"
# 8 s "song": kick every 0.5 s (120 BPM) over a chord pad, 44.1 kHz stereo MP3
ffmpeg $q -f lavfi -i "aevalsrc='0.6*sin(2*PI*(45+120*exp(-25*mod(t,0.5)))*t)*exp(-7*mod(t,0.5)) + 0.1*(sin(2*PI*220*t)+sin(2*PI*277.2*t)+sin(2*PI*329.6*t))|0.6*sin(2*PI*(45+120*exp(-25*mod(t,0.5)))*t)*exp(-7*mod(t,0.5)) + 0.1*(sin(2*PI*220.5*t)+sin(2*PI*277.7*t)+sin(2*PI*330.1*t))':s=44100:d=8" -c:a libmp3lame -b:a 128k song.mp3
ffmpeg $q -i song.mp3 -c:a pcm_s16le song.wav
# 4 s 640x360 30 fps H.264 clip with an AAC tone
ffmpeg $q -f lavfi -i "testsrc2=size=640x360:rate=30" -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 4 -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 30 -c:a aac -b:a 96k -shortest -movflags +faststart clip.mp4
# 4 s 320x180 30 fps gray clip whose pixels encode the frame number N: left half (N mod 16)*16+8, right half
# floor(N/16)*16+8. Gray survives any YUV matrix, so tests can read which source frame was shown.
ffmpeg $q -f lavfi -i "color=c=black:s=320x180:r=30:d=4,format=gray,geq=lum='if(lt(X,W/2),mod(N,16)*16+8,floor(N/16)*16+8)'" -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 30 -movflags +faststart frames.mp4
# 2 s audio-only Opus WebM, like a MediaRecorder voice recording
ffmpeg $q -f lavfi -i "sine=frequency=330:sample_rate=48000:duration=2" -c:a libopus -b:a 64k voice.webm
ffmpeg $q -f lavfi -i "testsrc2=size=640x360:rate=1" -frames:v 1 image.png
ls -la
