# AutoCline Desktop Versioning

## Version Numbers

AutoCline uses two version numbers:
- **Marketing Version** (`CFBundleShortVersionString`): Semantic versioning (e.g., `1.0.0`)
- **Build Number** (`CFBundleVersion`): Integer that increments with each build (e.g., `30`)

## Current Version
- Marketing: **1.0.0**
- Build: **30**

## Files to Update

When releasing a new version, update the following files:

### 1. Marketing Version (1.0.0 → 1.0.1)
```bash
# Update package.json
sed -i '' 's/"version": "1.0.0"/"version": "1.0.1"/' package.json

# Update tauri.conf.json
sed -i '' 's/"version": "1.0.0"/"version": "1.0.1"/' src-tauri/tauri.conf.json

# Update Info.plist
sed -i '' 's/<string>1.0.0<\/string>/<string>1.0.1<\/string>/' src-tauri/Info.plist
```

### 2. Build Number (30 → 31)
```bash
# Update Info.plist CFBundleVersion
# Find the line after CFBundleVersion key and increment the number
sed -i '' '/<key>CFBundleVersion<\/key>/,/<string>[0-9]*<\/string>/{s/<string>[0-9]*<\/string>/<string>31<\/string>/;}' src-tauri/Info.plist
```

## Automated Build Increment

To automatically increment the build number:

```bash
#!/bin/bash
# scripts/increment-build.sh

PLIST="src-tauri/Info.plist"

# Extract current build number
CURRENT_BUILD=$(grep -A1 "CFBundleVersion" "$PLIST" | tail -n1 | sed 's/.*<string>\([0-9]*\)<\/string>.*/\1/')

# Increment
NEW_BUILD=$((CURRENT_BUILD + 1))

# Update
sed -i '' "/<key>CFBundleVersion<\/key>/,/<string>[0-9]*<\/string>/{s/<string>[0-9]*<\/string>/<string>$NEW_BUILD<\/string>/;}" "$PLIST"

echo "Build number incremented: $CURRENT_BUILD → $NEW_BUILD"
```

Usage:
```bash
chmod +x scripts/increment-build.sh
./scripts/increment-build.sh
```

## Release Checklist

1. **Minor/Patch Release** (e.g., 1.0.0 → 1.0.1):
   - Update marketing version in all three files
   - Increment build number
   - Commit: `git commit -m "chore(desktop): bump version to 1.0.1 (build 31)"`

2. **Major Release** (e.g., 1.0.0 → 2.0.0):
   - Update marketing version in all three files
   - Increment build number
   - Update CHANGELOG
   - Commit: `git commit -m "chore(desktop): bump version to 2.0.0 (build 31)"`

3. **Build-Only Update** (e.g., hotfix):
   - Only increment build number
   - Commit: `git commit -m "chore(desktop): increment build to 31"`

## Icon Management

AutoCline uses a **fixed custom brand icon**, not theme-switchable variants (Classic/Midnight/etc).

- Source: `src-tauri/app-icon.png` (1024×1024)
- Canonical copy: `webview/public/autocline-brand-icon.png`
- These files must be identical (verified via SHA256)

To regenerate platform icons from the source:
```bash
# On macOS with Tauri CLI
cd apps/examples/desktop-app
bun tauri icon src-tauri/app-icon.png
```

This generates:
- `src-tauri/icons/icon.icns` (macOS)
- `src-tauri/icons/icon.ico` (Windows)
- `src-tauri/icons/*.png` (various sizes)

**Note**: The runtime icon switching system (`syncAppIcon`) is disabled for AutoCline.
The Dock/taskbar icon is always the custom brand icon baked into the native bundle.
