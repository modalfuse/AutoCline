#!/bin/bash
# Increment the CFBundleVersion (build number) in Info.plist

set -e

PLIST="src-tauri/Info.plist"

if [ ! -f "$PLIST" ]; then
    echo "Error: $PLIST not found"
    exit 1
fi

# Extract current build number
CURRENT_BUILD=$(grep -A1 "CFBundleVersion" "$PLIST" | tail -n1 | sed 's/.*<string>\([0-9]*\)<\/string>.*/\1/')

if [ -z "$CURRENT_BUILD" ]; then
    echo "Error: Could not find CFBundleVersion in $PLIST"
    exit 1
fi

# Increment
NEW_BUILD=$((CURRENT_BUILD + 1))

# Update using platform-independent sed
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    sed -i '' "/<key>CFBundleVersion<\/key>/,/<string>[0-9]*<\/string>/{s/<string>[0-9]*<\/string>/<string>$NEW_BUILD<\/string>/;}" "$PLIST"
else
    # Linux
    sed -i "/<key>CFBundleVersion<\/key>/,/<string>[0-9]*<\/string>/{s/<string>[0-9]*<\/string>/<string>$NEW_BUILD<\/string>/;}" "$PLIST"
fi

echo "✓ Build number incremented: $CURRENT_BUILD → $NEW_BUILD"
