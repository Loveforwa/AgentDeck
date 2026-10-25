#!/bin/sh
# 从 build-resources/icon.svg 生成 icon.icns（打包用）和 icon.png（1024px）。只有改了图标才需要跑，产物提交进仓库。
# 需要 rsvg-convert（brew install librsvg）和 macOS 自带的 iconutil。
set -eu
cd "$(dirname "$0")/../build-resources"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
set_dir="$work/icon.iconset"
mkdir "$set_dir"
for size in 16 32 128 256 512; do
  rsvg-convert -w "$size" -h "$size" icon.svg -o "$set_dir/icon_${size}x${size}.png"
  double=$((size * 2))
  rsvg-convert -w "$double" -h "$double" icon.svg -o "$set_dir/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$set_dir" -o icon.icns
rsvg-convert -w 1024 -h 1024 icon.svg -o icon.png
echo "wrote $(pwd)/icon.icns and icon.png"
