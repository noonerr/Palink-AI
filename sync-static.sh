#!/bin/bash
sudo docker cp frp-frontend:/usr/share/nginx/html/. /var/www/frp-platform/

cd /var/www/frp-platform/assets/
rm -f *.gz
for f in *.js *.css; do
    if [ -f "$f" ]; then
        gzip -k -9 -f "$f" 2>/dev/null
        echo "Compressed: $f"
    fi
done

cd /var/www/frp-platform/
rm -f index.html.gz
gzip -k -9 -f index.html 2>/dev/null

echo "=== Files ==="
ls -lh /var/www/frp-platform/assets/
echo "=== Total ==="
du -sh /var/www/frp-platform/
