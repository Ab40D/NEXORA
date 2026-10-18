#!/usr/bin/env bash
# Builds a fake-webcam Y4M video from the hand-pose fixtures, for Chromium's
# --use-file-for-fake-video-capture (gesture E2E tests). Requires ffmpeg.
# Timeline (s): 0-2 empty wall, 2-5 open palm, 5-8 fist, 8-11 thumb up, 11-14 victory, 14-16 empty wall.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
src="$here/tests/fixtures/hands"
out="${1:-${XDG_CACHE_HOME:-$HOME/.cache}/se7enx-test/poses.y4m}"
mkdir -p "$(dirname "$out")"
ffmpeg -v error -y \
  -f lavfi -t 2 -i "color=c=0xc9c9c7:s=640x360:r=15" \
  -loop 1 -t 3 -framerate 15 -i "$src/open_palm.jpg" \
  -loop 1 -t 3 -framerate 15 -i "$src/fist.jpg" \
  -loop 1 -t 3 -framerate 15 -i "$src/thumb_up.jpg" \
  -loop 1 -t 3 -framerate 15 -i "$src/victory.jpg" \
  -f lavfi -t 2 -i "color=c=0xc9c9c7:s=640x360:r=15" \
  -filter_complex "[1]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=0xc9c9c7,setsar=1,fps=15[a];\
[2]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=0xc9c9c7,setsar=1,fps=15[b];\
[3]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=0xc9c9c7,setsar=1,fps=15[c];\
[4]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=0xc9c9c7,setsar=1,fps=15[d];\
[0]setsar=1[z0];[5]setsar=1[z1];[z0][a][b][c][d][z1]concat=n=6:v=1:a=0,format=yuv420p[v]" \
  -map "[v]" -r 15 "$out"
echo "$out"
