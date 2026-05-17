#!/bin/bash
# Update .env - backend uses internal HTTP to talk to Casdoor
cd /home/azureuser/frp-platform
sudo sed -i 's|CASDOOR_ENDPOINT=https://104.208.99.17:9443|CASDOOR_ENDPOINT=http://127.0.0.1:8444|' .env
echo "Updated .env:"
grep -E 'CASDOOR_ENDPOINT|FRONTEND_URL' .env
