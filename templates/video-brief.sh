#!/bin/bash
# video-brief.sh — ElianBot template: turn ANY text into a professionally
# finished, narrated MP4 — using only native/free tools. No tokens, no auth.
#
# What "professional" means here:
#   * cards designed at 2560×1440 and filmed with slow Ken Burns moves
#     (alternating zoom-in / zoom-out / drift), so nothing is ever static
#   * real crossfades between slides (video xfade + audio acrossfade)
#   * a title card with gradient type, per-slide progress bar, branded outro
#   * narration timed per slide, with a breath of lead-in and tail
#
# Input (first that exists):
#   $ELIANBOT_INPUT / $ELIANBOT_INPUT_FILE  — from run_job or an @video-brief
#                                             mention in another job's output
#   built-in demo text                      — a bare "Run now" always works
#
# Format: line 1 = title. Every following non-empty line = one slide,
# narrated verbatim (max 8). Lines starting with @ are routing, not content.
# Voice: $ELIANBOT_VIDEO_VOICE (default Samantha).
#
# Tools: say, qlmanage, sips, ffmpeg, awk.

set -u
command -v ffmpeg >/dev/null || { echo "ffmpeg not found (brew install ffmpeg)"; exit 1; }

FPS=30
XFADE=0.6          # crossfade seconds between slides
LEAD=0.9           # extra seconds of card per slide beyond the narration

# ---- 1. gather input ----
TEXT="${ELIANBOT_INPUT:-}"
if [ -z "$TEXT" ] && [ -n "${ELIANBOT_INPUT_FILE:-}" ] && [ -f "${ELIANBOT_INPUT_FILE:-}" ]; then
  TEXT="$(cat "$ELIANBOT_INPUT_FILE")"
fi
if [ -z "$TEXT" ]; then
  TEXT="ElianBot video brief
This is a job result, rendered as a narrated video.
Send any job's output here with an at video-brief mention.
Deterministic, free, and made entirely on this Mac."
fi

CLEAN="$(printf '%s\n' "$TEXT" | grep -v '^[[:space:]]*@' | sed '/^[[:space:]]*$/d')"
TITLE="$(printf '%s\n' "$CLEAN" | head -1 | cut -c1-90)"
BODY="$(printf '%s\n' "$CLEAN" | tail -n +2 | head -8)"
[ -z "$BODY" ] && BODY="$TITLE"

VOICE="${ELIANBOT_VIDEO_VOICE:-Samantha}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DATE_NICE="$(date '+%A, %e %B %Y' | tr -s ' ')"

if [ -n "${ELIANBOT_LOG:-}" ]; then
  DATA_DIR="$(cd "$(dirname "$ELIANBOT_LOG")/../.." && pwd)"
else
  DATA_DIR="$(cd "$(dirname "$0")/.." && pwd)/data"
fi
OUT_DIR="$DATA_DIR/videos"
MP4="$OUT_DIR/brief-$STAMP.mp4"
mkdir -p "$OUT_DIR"

WORK="$(mktemp -d /tmp/elianbot-video.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

esc_html() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }

# ---- 2. design: one 2560×1440 card per slide ----
# kind: title | slide | outro
make_card() { # $1=index $2=kind $3=text $4=slide-no $5=slide-total
  local i="$1" kind="$2" body no="$4" total="$5" main kicker pct size
  body="$(esc_html "$3")"
  pct=$(( no * 100 / total ))
  if [ "$kind" = "title" ]; then
    kicker="VIDEO BRIEF — $DATE_NICE"
    main="<div class=\"title\">$body</div>"
  elif [ "$kind" = "outro" ]; then
    kicker=""
    main="<div class=\"outro\"><div class=\"blob big\"><i></i><i></i></div><div class=\"outro-t\">ElianBot</div><div class=\"outro-s\">rendered on this Mac — no tokens, no cloud</div></div>"
  else
    size="86px"; [ "${#3}" -gt 110 ] && size="64px"
    kicker="$(printf 'SECTION %02d — %02d' "$no" "$total")"
    main="<div class=\"line\" style=\"font-size:$size\">$body</div>"
  fi
  cat > "$WORK/card$i.html" <<HTML
<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:2560px;height:1440px;overflow:hidden;
    font-family:-apple-system,'SF Pro Display','Helvetica Neue',sans-serif;color:#ececec;
    background:
      radial-gradient(1000px 700px at 82% 18%, rgba(160,106,248,.28), transparent 62%),
      radial-gradient(900px 900px at 8% 96%, rgba(84,40,160,.30), transparent 60%),
      radial-gradient(500px 500px at 70% 80%, rgba(240,80,168,.10), transparent 65%),
      linear-gradient(150deg,#111013 0%,#17141f 52%,#221636 100%)}
  .grid{position:absolute;inset:0;
    background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),
      linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);
    background-size:160px 160px}
  .vig{position:absolute;inset:0;background:radial-gradient(1600px 1000px at 50% 46%,transparent 55%,rgba(0,0,0,.42))}
  .wrap{position:absolute;inset:0;box-sizing:border-box;padding:130px 170px;
    display:flex;flex-direction:column}
  .brand{display:flex;align-items:center;gap:30px}
  .blob{width:84px;height:84px;border-radius:50%;background:#a06af8;flex:none;
    box-shadow:0 0 90px rgba(160,106,248,.55);
    display:flex;align-items:center;justify-content:center;gap:15px}
  .blob i{display:block;width:9px;height:25px;border-radius:5px;background:#151217;transform:rotate(8deg)}
  .blob.big{width:190px;height:190px;gap:32px;box-shadow:0 0 160px rgba(160,106,248,.6)}
  .blob.big i{width:20px;height:56px;border-radius:10px}
  .brand b{font-size:44px;font-weight:700;letter-spacing:.01em}
  .kick{margin-left:auto;font-size:30px;font-weight:600;letter-spacing:.22em;color:#a794d6}
  .main{flex:1;display:flex;align-items:center}
  .title{font-size:128px;font-weight:800;letter-spacing:-3px;line-height:1.08;max-width:2100px;
    background:linear-gradient(100deg,#f4f2fa 30%,#b78cff 78%);-webkit-background-clip:text;color:transparent}
  .line{font-weight:600;line-height:1.4;max-width:2080px;color:#f0eef6;
    border-left:10px solid #a06af8;padding-left:64px}
  .outro{width:100%;display:flex;flex-direction:column;align-items:center;gap:44px;text-align:center}
  .outro-t{font-size:96px;font-weight:800;letter-spacing:-2px}
  .outro-s{font-size:36px;color:#9a90ac}
  .foot{display:flex;align-items:center;gap:40px}
  .date{font-size:32px;color:#8f8a9c;white-space:nowrap}
  .bar{flex:1;height:8px;border-radius:99px;background:rgba(255,255,255,.09);overflow:hidden}
  .bar b{display:block;height:100%;width:$pct%;border-radius:99px;
    background:linear-gradient(90deg,#7a4fe0,#a06af8)}
</style></head><body>
  <div class="grid"></div><div class="vig"></div>
  <div class="wrap">
    <div class="brand"><div class="blob"><i></i><i></i></div><b>ElianBot</b><span class="kick">$kicker</span></div>
    <div class="main">$main</div>
    <div class="foot"><span class="date">$DATE_NICE</span><div class="bar"><b></b></div></div>
  </div>
</body></html>
HTML
  qlmanage -t -s 2560 -o "$WORK" "$WORK/card$i.html" >/dev/null 2>&1
  sips -z 1440 2560 "$WORK/card$i.html.png" --out "$WORK/card$i.png" >/dev/null 2>&1
  [ -s "$WORK/card$i.png" ]
}

# ---- 3. film each card: narration + Ken Burns move ----
DUR_FILE="$WORK/durs.txt"; : > "$DUR_FILE"

build_segment() { # $1=index $2=narration
  local i="$1" text="$2" aiff="$WORK/vo$1.aiff" png="$WORK/card$1.png" seg="$WORK/seg$1.mp4"
  local adur len frames move
  say -v "$VOICE" -o "$aiff" "$text" 2>/dev/null || say -o "$aiff" "$text" || return 1
  adur="$(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$aiff")"
  len="$(awk -v d="$adur" -v x="$LEAD" 'BEGIN{printf "%.2f", d + x}')"
  frames="$(awk -v l="$len" -v f="$FPS" 'BEGIN{printf "%d", l * f + 1}')"
  case $((i % 3)) in
    0) move="z='1+0.10*on/$frames':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'" ;;                 # push in
    1) move="z='1.10-0.10*on/$frames':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'" ;;              # pull out
    2) move="z='1.07':x='(iw-iw/zoom)*on/$frames':y='ih/2-(ih/zoom/2)'" ;;                       # drift right
  esac
  ffmpeg -y -i "$png" -i "$aiff" \
    -filter_complex "[0:v]zoompan=$move:d=$frames:s=1280x720:fps=$FPS,format=yuv420p[v];[1:a]adelay=350|350,apad[a]" \
    -map "[v]" -map "[a]" -t "$len" \
    -c:v libx264 -preset veryfast -crf 19 -c:a aac -b:a 160k -ar 44100 "$seg" >/dev/null 2>&1 || return 1
  echo "$len" >> "$DUR_FILE"
}

CONTENT_N="$(printf '%s\n' "$BODY" | grep -c .)"
TOTAL=$((CONTENT_N + 1))

echo "rendering: $TITLE — $TOTAL slides + outro, voice $VOICE"

make_card 0 title "$TITLE" 1 "$TOTAL" || { echo "card 0 failed"; exit 1; }
build_segment 0 "$TITLE" || { echo "segment 0 failed"; exit 1; }

i=1
while IFS= read -r line; do
  make_card "$i" slide "$line" $((i + 1)) "$TOTAL" || { echo "card $i failed"; exit 1; }
  build_segment "$i" "$line" || { echo "segment $i failed"; exit 1; }
  i=$((i+1))
done <<EOF_BODY
$BODY
EOF_BODY

OUTRO=$i
make_card "$OUTRO" outro "" "$TOTAL" "$TOTAL" || { echo "outro card failed"; exit 1; }
build_segment "$OUTRO" "Brief complete." || { echo "outro segment failed"; exit 1; }
N=$((OUTRO + 1))

# ---- 4. assemble with crossfades, global fade in/out ----
INPUTS=""; k=0
while [ $k -lt $N ]; do INPUTS="$INPUTS -i $WORK/seg$k.mp4"; k=$((k+1)); done

FILTER="$(awk -v n="$N" -v F="$XFADE" '
  { d[NR-1] = $1 }
  END {
    vf = ""; af = ""; vprev = "[0:v]"; aprev = "[0:a]"; off = 0
    for (k = 1; k < n; k++) {
      off += d[k-1] - F
      vf = vf sprintf("%s[%d:v]xfade=transition=fade:duration=%.2f:offset=%.2f[v%d];", vprev, k, F, off, k)
      af = af sprintf("%s[%d:a]acrossfade=d=%.2f[a%d];", aprev, k, F, k)
      vprev = sprintf("[v%d]", k); aprev = sprintf("[a%d]", k)
    }
    total = off + d[n-1]
    printf "%s%s%sfade=t=in:st=0:d=0.5,fade=t=out:st=%.2f:d=0.8[vout];%safade=t=out:st=%.2f:d=0.8[aout]",
      vf, af, vprev, total - 0.8, aprev, total - 0.8
  }' "$DUR_FILE")"

ffmpeg -y $INPUTS -filter_complex "$FILTER" -map "[vout]" -map "[aout]" \
  -c:v libx264 -preset veryfast -crf 19 -pix_fmt yuv420p -c:a aac -b:a 160k \
  -movflags +faststart "$MP4" >/dev/null 2>&1

[ -s "$MP4" ] || { echo "assembly failed"; exit 1; }

DUR="$(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$MP4" | cut -d. -f1)"
SIZE="$(du -h "$MP4" | cut -f1 | tr -d ' ')"
echo "video ready: $MP4 (${DUR}s, $SIZE)"
open "$MP4"

# ---- 5. route the result ----
echo "@notify Video brief ready (${DUR}s): $(basename "$MP4")"
echo "@grok video brief rendered → $MP4 (${DUR}s, $SIZE)"
