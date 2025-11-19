#!/bin/bash
# Test script to debug TikTok downloads with yt-dlp

echo "=== TikTok yt-dlp Diagnostic Test ==="
echo ""

if [ -z "$1" ]; then
    echo "Usage: ./test-tiktok.sh <tiktok_url>"
    echo "Example: ./test-tiktok.sh https://vt.tiktok.com/ZSfL5fk1v/"
    exit 1
fi

URL="$1"

echo "Testing URL: $URL"
echo "======================================"
echo ""

echo "[1] Testing yt-dlp version:"
yt-dlp --version
echo ""

echo "[2] Testing video info extraction (--dump-json):"
echo "Command: yt-dlp --verbose --dump-json --socket-timeout 30 \"$URL\""
echo "--------------------------------------"
yt-dlp --verbose --dump-json --socket-timeout 30 "$URL" 2>&1 | head -100
echo ""

echo "[3] Testing actual download (same args as bot):"
echo "Command: yt-dlp --verbose --format 'bestvideo*+bestaudio/best' --referer 'https://www.tiktok.com/' --no-check-certificates --http-chunk-size 10M -o test_download.mp4 \"$URL\""
echo "--------------------------------------"
yt-dlp --verbose \
    --format "bestvideo*+bestaudio/best" \
    --no-playlist \
    --socket-timeout 60 \
    --retries 10 \
    --fragment-retries 20 \
    --add-header "Accept:*/*" \
    --add-header "Accept-Language:en-US,en;q=0.9" \
    --merge-output-format mp4 \
    --concurrent-fragments 32 \
    --buffer-size 32K \
    --no-part \
    --referer "https://www.tiktok.com/" \
    --no-check-certificates \
    --http-chunk-size 10M \
    -o test_download.mp4 \
    "$URL"

RESULT=$?

echo ""
echo "======================================"
echo "Exit code: $RESULT"

if [ $RESULT -eq 0 ]; then
    echo "✅ SUCCESS! Download completed."
    if [ -f test_download.mp4 ]; then
        SIZE=$(du -h test_download.mp4 | cut -f1)
        echo "File size: $SIZE"
        ls -lh test_download.mp4
    fi
else
    echo "❌ FAILED! Exit code: $RESULT"
    echo ""
    echo "Common issues:"
    echo "- HTTP 403/404: Video deleted or private"
    echo "- Network timeout: Server connection issue"
    echo "- Format not available: Try without format selection"
fi

echo ""
echo "To clean up test file: rm -f test_download.mp4"
