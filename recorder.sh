#!/bin/bash
# 전체 스트림 자동 녹화 스크립트

SRS_HOST="srs"
SRS_API="http://$SRS_HOST:1985"
RECORDING_PATH="/recordings"
SEGMENT_TIME=600

cleanup() {
    echo "[$(date)] Stopping all recordings..."
    kill $(jobs -p) 2>/dev/null
    exit 0
}

trap cleanup SIGTERM SIGINT

while true; do
    STREAMS=$(curl -s "$SRS_API/api/v1/streams/" 2>/dev/null)

    if [ -n "$STREAMS" ] && [ "$STREAMS" != "null" ]; then
        # 각 스트림 정보 가져오기 (tcUrl에서 vhost 추출, app, name)
        # tcUrl 형식: srt://kr.example.com/live
        echo "$STREAMS" | jq -r '.streams[] | select(.publish.active==true) | "\(.tcUrl)|\(.app)|\(.name)"' 2>/dev/null | while IFS='|' read -r tcurl app stream; do
            [ -z "$stream" ] && continue
            # tcUrl에서 vhost 추출 (srt://vhost/app -> vhost)
            vhost=$(echo "$tcurl" | sed -E 's|^srt://([^/]+)/.*|\1|')

            # 이미 녹화 중인지 확인
            if pgrep -f "h=$vhost/$app/$stream,m=request" > /dev/null 2>&1; then
                continue
            fi

            # 폴더 생성: /recordings/[vhost]/[app]/[stream]/Y/m/d/
            RECORD_DIR="$RECORDING_PATH/$vhost/$app/$stream/$(date +%Y/%m/%d)"
            mkdir -p "$RECORD_DIR"

            # 녹화 시작
            ffmpeg -i "srt://$SRS_HOST:10080?streamid=#!::h=$vhost/$app/$stream,m=request" \
                -c:v copy -c:a copy \
                -f segment -segment_time $SEGMENT_TIME -segment_format mp4 \
                -reset_timestamps 1 -strftime 1 \
                "$RECORD_DIR/%H-%M-%S.mp4" \
                </dev/null >/dev/null 2>&1 &

            echo "[$(date)] Recording started: $vhost/$app/$stream"
        done
    fi

    sleep 10
done
