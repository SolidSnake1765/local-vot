#!/usr/bin/env bash
# Своя сборка ffmpeg для Local VOT — только то, что нужно программе (вместо полной сборки ffmpeg-static).
# Запуск: в MSYS2 MINGW64, установленном по пути без пробелов (у автора — D:\msys64): сборщик ffmpeg не умеет
# пути с пробелами, поэтому и сама сборка идёт не в папке проекта, а в $WORK (по умолчанию — домашняя папка MSYS2):
#   D:\msys64\msys2_shell.cmd -mingw64 -defterm -no-start -here -c "bash scripts/build-ffmpeg.sh"
# Нужны пакеты: make diffutils nasm pkgconf mingw-w64-x86_64-gcc mingw-w64-x86_64-pkgconf
#   mingw-w64-x86_64-libx264 mingw-w64-x86_64-lame mingw-w64-x86_64-opus (zlib приходит вместе с gcc).
# Итог: vendor/ffmpeg/ffmpeg.exe — один файл, без DLL (всё связано статически).
#
# Что внутри и зачем:
# - разбор файлов (демультиплексоры), декодеры, парсеры, bsf — все встроенные в ffmpeg: видео пользователя
#   может быть любым, а звук из него надо прочитать; внешних библиотек декодирования нет (AV1 — только
#   через миниатюры Windows);
# - кодировщики: aac (дорожка перевода, облегчённая копия), libmp3lame (AVI), libopus (WebM/OGV), ac3 (MPG/VOB),
#   wmav2 (WMV), libx264 (чёрная картинка облегчённой копии), mjpeg (миниатюра), srt/mov_text/webvtt (субтитры);
# - запись (мультиплексоры) — форматы итогов и служебные: mp4/mov/3gp/ipod(m4a)/matroska/webm/avi/asf/mpegts/
#   vob/ogg/adts/null/image2pipe/framecrc;
# - фильтры — те, что строит media.js, и те, что ffmpeg вставляет сам;
# - lavfi (чёрная картинка, источник color), протоколы file и pipe; сети нет.
# Строку настройки ffmpeg вшивает в себя (ffmpeg -version) — поэтому --prefix нейтральный, без пути сборки
# с именем пользователя, а после сборки проверяем, что имени в файле нет.
# Лицензия итога — GPL (из-за x264); исходники: https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz +
# пакеты MSYS2 выше, этот сценарий — как собрано.
set -euo pipefail

VERSION=9.0.2
SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$HOME/local-vot-ffmpeg}"
case "$WORK" in *" "*) echo "Путь сборки с пробелом ($WORK) — задайте WORK без пробелов" >&2; exit 1 ;; esac
OUT="$ROOT/vendor/ffmpeg"
# не больше 8 потоков: на 24 GCC 16.2 из MSYS2 один раз упал с internal compiler error (повтор прошёл)
JOBS="${JOBS:-$(( $(nproc) < 8 ? $(nproc) : 8 ))}"

mkdir -p "$WORK" "$OUT"
cd "$WORK"
TARBALL="ffmpeg-$VERSION.tar.xz"
[ -f "$TARBALL" ] || curl -fsSL -o "$TARBALL" "https://ffmpeg.org/releases/$TARBALL"
echo "$SHA256  $TARBALL" | sha256sum -c -
rm -rf "ffmpeg-$VERSION"
tar -xJf "$TARBALL"
cd "ffmpeg-$VERSION"

list() { local IFS=,; echo "$*"; }
# pcm_s16le, wrapped_avframe, rawvideo — их берут по умолчанию служебные выходы «-f null» (замер громкости, поиск
# пауз) и «-f framecrc» (задержка звука): без них эти команды не работают
ENCODERS=(aac libmp3lame libopus ac3 wmav2 libx264 mjpeg srt subrip movtext webvtt pcm_s16le wrapped_avframe rawvideo)
# имена — как в configure --list-muxers (3gp — tgp, vob — mpeg2vob); незнакомое имя configure молча пропускает!
# ipod — это .m4a, matroska_audio — .mka (копия звука оригинала): выбираются по расширению файла
MUXERS=(mp4 mov tgp ipod matroska matroska_audio webm avi asf mpegts mpeg2vob ogg adts null image2pipe framecrc)
FILTERS=(aresample aformat volume amix atrim alimiter adelay asetpts ebur128 silencedetect anull
  color scale format null trim setpts)

# configure молча пропускает незнакомые имена — сверяем сами, иначе в сборке не окажется нужного
known() { local kind=$1; shift; local all; all="$(./configure --list-"$kind" | tr -s ' \t' '\n')"
  for n in "$@"; do grep -qx "$n" <<<"$all" || { echo "В ffmpeg нет ($kind): $n" >&2; exit 1; }; done; }
known muxers "${MUXERS[@]}"
known encoders "${ENCODERS[@]}"
known filters "${FILTERS[@]}"

./configure \
  --prefix=/usr/local \
  --arch=x86_64 --target-os=mingw32 \
  --pkg-config-flags=--static \
  --extra-ldflags=-static \
  --enable-gpl --enable-version3 \
  --disable-everything --disable-autodetect --disable-network \
  --disable-doc --disable-ffplay --disable-ffprobe --disable-debug \
  --disable-hwaccels --disable-devices --enable-indev=lavfi \
  --enable-avdevice --enable-avfilter --enable-swresample --enable-swscale \
  --enable-zlib --enable-libx264 --enable-libmp3lame --enable-libopus \
  --enable-w32threads \
  --enable-protocol=file,pipe \
  --enable-demuxers --enable-decoders --enable-parsers --enable-bsfs \
  --enable-encoder="$(list "${ENCODERS[@]}")" \
  --enable-muxer="$(list "${MUXERS[@]}")" \
  --enable-filter="$(list "${FILTERS[@]}")"

make -j"$JOBS"
strip -o "$OUT/ffmpeg.exe" ffmpeg.exe
if grep -a -q -e "$WORK" -e "$(whoami)" "$OUT/ffmpeg.exe"; then
  echo "В ffmpeg.exe попал путь сборки или имя пользователя — не выкладывать" >&2; exit 1
fi
cp COPYING.GPLv3 "$OUT/LICENSE.txt" # рядом лежит README.txt: версия, исходники, как собрано
ls -la "$OUT/ffmpeg.exe"
"$OUT/ffmpeg.exe" -hide_banner -version | head -1
