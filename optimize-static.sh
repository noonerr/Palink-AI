#!/bin/bash
echo "=== Step 1: Sync static files from container ==="
sudo docker cp frp-frontend:/usr/share/nginx/html/. /var/www/frp-platform/

echo "=== Step 2: Clean old unused assets ==="
cd /var/www/frp-platform/assets/

CURRENT_JS=$(grep -oP 'index-[A-Za-z0-9_-]+\.js' /var/www/frp-platform/index.html | head -1)
CURRENT_CSS=$(grep -oP 'index-[A-Za-z0-9_-]+\.css' /var/www/frp-platform/index.html | head -1)
CURRENT_MAIN_JS=$(grep -oP 'main-[A-Za-z0-9_-]+\.js' /var/www/frp-platform/index.html | head -1)
CURRENT_MAIN_CSS=$(grep -oP 'main-[A-Za-z0-9_-]+\.css' /var/www/frp-platform/index.html | head -1)
CURRENT_RUNTIME=$(grep -oP 'runtime-dom\.esm-bundler-[A-Za-z0-9_-]+\.js' /var/www/frp-platform/index.html | head -1)
CURRENT_VUEROUTER=$(grep -oP 'vue-router-[A-Za-z0-9_-]+\.js' /var/www/frp-platform/index.html | head -1)

echo "Keeping: $CURRENT_JS $CURRENT_CSS $CURRENT_MAIN_JS $CURRENT_MAIN_CSS $CURRENT_RUNTIME $CURRENT_VUEROUTER"

KEEP_FILES="index.html $CURRENT_JS $CURRENT_CSS $CURRENT_MAIN_JS $CURRENT_MAIN_CSS $CURRENT_RUNTIME $CURRENT_VUEROUTER"

for f in *.js *.css; do
    keep=false
    for k in $KEEP_FILES; do
        if [ "$f" = "$k" ]; then
            keep=true
            break
        fi
    done
    if [ "$keep" = false ]; then
        rm -f "$f" "${f}.gz" "${f}.br"
        echo "  Removed: $f"
    fi
done

echo "=== Step 3: Pre-compress with gzip and brotli ==="
for f in *.js *.css; do
    if [ -f "$f" ]; then
        gzip -k -9 -f "$f" 2>/dev/null
        if command -v brotli &>/dev/null; then
            brotli -k -9 -f "$f" 2>/dev/null
        fi
        echo "  Compressed: $f ($(stat -c%s "$f") bytes -> gzip $(stat -c%s "${f}.gz") bytes)"
    fi
done

cd /var/www/frp-platform/
if [ -f "index.html" ]; then
    gzip -k -9 -f index.html 2>/dev/null
    echo "  Compressed: index.html"
fi

echo "=== Step 4: Final size ==="
du -sh /var/www/frp-platform/
du -sh /var/www/frp-platform/assets/
echo "=== DONE ==="
