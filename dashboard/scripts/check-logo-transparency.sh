#!/bin/bash

# Script to check and fix PNG transparency
# Usage: ./check-logo-transparency.sh [path-to-logo.png]

LOGO_PATH="${1:-dashboard/assets/images/logo.png}"

if [ ! -f "$LOGO_PATH" ]; then
    echo "❌ Logo file not found: $LOGO_PATH"
    echo "Please place your logo.png file at: dashboard/assets/images/logo.png"
    exit 1
fi

echo "🔍 Checking logo transparency: $LOGO_PATH"

# Check if ImageMagick is installed
if ! command -v identify &> /dev/null; then
    echo "⚠️  ImageMagick not found. Installing..."
    sudo apt-get update && sudo apt-get install -y imagemagick
fi

# Check file type
FILE_TYPE=$(file "$LOGO_PATH" | grep -o "PNG")
if [ -z "$FILE_TYPE" ]; then
    echo "❌ File is not a PNG. Converting..."
    convert "$LOGO_PATH" "${LOGO_PATH%.*}.png"
    LOGO_PATH="${LOGO_PATH%.*}.png"
fi

# Check if PNG has transparency
HAS_ALPHA=$(identify -format '%A' "$LOGO_PATH" 2>/dev/null | head -1)
ALPHA_CHANNEL=$(identify -format '%[channels]' "$LOGO_PATH" 2>/dev/null)

echo "📊 Image Info:"
identify "$LOGO_PATH"

if [[ "$ALPHA_CHANNEL" == *"rgba"* ]] || [[ "$ALPHA_CHANNEL" == *"srgba"* ]]; then
    echo "✅ PNG has transparency (alpha channel detected)"
else
    echo "⚠️  PNG may not have proper transparency"
    echo "🔧 Attempting to ensure transparency is preserved..."
    
    # Re-save with explicit alpha channel
    convert "$LOGO_PATH" -alpha on -alpha set "${LOGO_PATH%.*}_fixed.png"
    
    if [ -f "${LOGO_PATH%.*}_fixed.png" ]; then
        mv "${LOGO_PATH%.*}_fixed.png" "$LOGO_PATH"
        echo "✅ Fixed transparency - saved back to original file"
    fi
fi

# Verify final result
FINAL_ALPHA=$(identify -format '%[channels]' "$LOGO_PATH" 2>/dev/null)
if [[ "$FINAL_ALPHA" == *"rgba"* ]] || [[ "$FINAL_ALPHA" == *"srgba"* ]]; then
    echo "✅ Transparency verified and working!"
else
    echo "⚠️  Note: Image may not have full transparency support"
fi

echo ""
echo "📁 Logo is ready at: $LOGO_PATH"
echo "💡 The logo will be used throughout the dashboard with animations"

