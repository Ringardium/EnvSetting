#!/bin/bash
# H.265 → H.264 트랜스코더 (WebRTC 호환용)
# H.265 스트림 감지 시 H.264로 변환 후 _h264 suffix로 재발행

SRS_HOST="srs"
SRS_API="http://$SRS_HOST:1985"

# 트랜스코딩 설정
VIDEO_CODEC="${VIDEO_CODEC:-libx264}"  # Docker: libx264, 로컬 M1: h264_videotoolbox
PRESET="${PRESET:-veryfast}"
BITRATE="${BITRATE:-2000k}"

# 트랜스코딩 중인 스트림 추적
declare -A TRANSCODING_PIDS

cleanup() {
    echo "[$(date)] Stopping all transcoders..."
    for pid in "${TRANSCODING_PIDS[@]}"; do
        kill "$pid" 2>/dev/null
    done
    exit 0
}

trap cleanup SIGTERM SIGINT

get_codec() {
    local vhost=$1
    local app=$2
    local stream=$3

    # SRS API로 스트림 정보 조회
    local info=$(curl -s "$SRS_API/api/v1/streams/" 2>/dev/null)

    # 해당 스트림의 비디오 코덱 확인
    echo "$info" | jq -r ".streams[] | select(.vhost==\"$vhost\" and .app==\"$app\" and .name==\"$stream\") | .video.codec" 2>/dev/null
}

is_hevc() {
    local codec=$1
    # H.265/HEVC 코덱 확인 (hevc, h265, hev1, hvc1 등)
    [[ "$codec" == "hevc" || "$codec" == "h265" || "$codec" == "hev1" || "$codec" == "hvc1" || "$codec" == "HEVC" ]]
}

start_transcoder() {
    local vhost=$1
    local app=$2
    local stream=$3
    local key="${vhost}/${app}/${stream}"

    # 이미 트랜스코딩 중인지 확인
    if [[ -n "${TRANSCODING_PIDS[$key]}" ]] && kill -0 "${TRANSCODING_PIDS[$key]}" 2>/dev/null; then
        return
    fi

    # 출력 스트림 이름 (원본에 _h264 suffix 추가)
    local output_stream="${stream}_h264"

    echo "[$(date)] Starting transcoder: $key → $output_stream"

    # SRT로 원본 수신 → H.264 트랜스코딩 → RTMP로 재발행
    ffmpeg -hide_banner -loglevel warning \
        -i "srt://$SRS_HOST:10080?streamid=#!::h=$vhost/$app/$stream,m=request" \
        -c:v "$VIDEO_CODEC" \
        -preset "$PRESET" \
        -b:v "$BITRATE" \
        -profile:v main \
        -level 4.1 \
        -g 60 \
        -keyint_min 60 \
        -c:a aac \
        -b:a 128k \
        -ar 44100 \
        -f flv \
        "rtmp://$SRS_HOST:1935/$app/$output_stream?vhost=$vhost" \
        </dev/null 2>&1 &

    TRANSCODING_PIDS[$key]=$!
    echo "[$(date)] Transcoder started: $key (PID: ${TRANSCODING_PIDS[$key]})"
}

stop_transcoder() {
    local key=$1
    if [[ -n "${TRANSCODING_PIDS[$key]}" ]]; then
        kill "${TRANSCODING_PIDS[$key]}" 2>/dev/null
        unset TRANSCODING_PIDS[$key]
        echo "[$(date)] Transcoder stopped: $key"
    fi
}

echo "[$(date)] H.265→H.264 Transcoder started"
echo "[$(date)] Video codec: $VIDEO_CODEC, Preset: $PRESET, Bitrate: $BITRATE"

while true; do
    STREAMS=$(curl -s "$SRS_API/api/v1/streams/" 2>/dev/null)

    if [ -n "$STREAMS" ] && [ "$STREAMS" != "null" ]; then
        # 현재 활성 스트림 목록
        declare -A ACTIVE_STREAMS

        # 각 스트림 확인
        echo "$STREAMS" | jq -r '.streams[] | "\(.vhost)|\(.app)|\(.name)|\(.video.codec)"' 2>/dev/null | while IFS='|' read -r vhost app stream codec; do
            [ -z "$stream" ] && continue

            # _h264 suffix가 붙은 트랜스코딩된 스트림은 무시
            [[ "$stream" == *"_h264" ]] && continue

            key="${vhost}/${app}/${stream}"
            ACTIVE_STREAMS[$key]=1

            # H.265 코덱인 경우 트랜스코딩 시작
            if is_hevc "$codec"; then
                start_transcoder "$vhost" "$app" "$stream"
            fi
        done

        # 종료된 스트림의 트랜스코더 정리
        for key in "${!TRANSCODING_PIDS[@]}"; do
            if [[ -z "${ACTIVE_STREAMS[$key]}" ]]; then
                stop_transcoder "$key"
            fi
        done
    fi

    sleep 5
done
