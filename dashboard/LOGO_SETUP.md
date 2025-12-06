# Logo Setup Guide

## 📍 Where to Place Your Logo

**Location:** `dashboard/assets/images/logo.png`

1. Place your 1kx1k PNG logo file at:
   ```
   dashboard/assets/images/logo.png
   ```

2. The file should be:
   - **Format**: PNG
   - **Size**: 1000x1000px (recommended)
   - **Transparency**: Should have alpha channel for transparency

## ✅ Check Transparency

After placing your logo, run the transparency check script:

```bash
cd /home/tj/project-palindrome
./dashboard/scripts/check-logo-transparency.sh
```

Or manually check:
```bash
# Check if ImageMagick is installed
identify dashboard/assets/images/logo.png

# Check for alpha channel
identify -format '%[channels]' dashboard/assets/images/logo.png
# Should show: rgba or srgba (not just rgb)
```

## 🔧 Fix Transparency (if needed)

If transparency isn't working, the script will automatically fix it. Or manually:

```bash
# Ensure alpha channel is preserved
convert dashboard/assets/images/logo.png -alpha on -alpha set dashboard/assets/images/logo.png
```

## 🎨 Where the Logo Appears

The logo is now used in:

1. **Header** - Main dashboard header (animated with pulse glow)
2. **Favicon** - Browser tab icon
3. **Fallback** - If logo fails to load, shows clock icon

## ✨ Animations

The logo has two animations:
- **Float animation** - Gentle up/down movement (3s cycle)
- **Glow pulse** - Orange glow that pulses (2s cycle)

Both animations run simultaneously for a subtle, professional effect.

## 🚀 Quick Start

1. Copy your logo to: `dashboard/assets/images/logo.png`
2. Run: `./dashboard/scripts/check-logo-transparency.sh`
3. Refresh the dashboard - logo should appear with animations!

## 📝 Notes

- Logo automatically falls back to icon if file is missing
- Transparency is preserved and checked automatically
- Logo scales responsively (smaller on mobile, larger on desktop)
- Orange glow effect matches your theme

