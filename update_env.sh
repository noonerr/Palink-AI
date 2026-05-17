#!/bin/bash
# Update .env to use HTTPS
cd /home/azureuser/frp-platform
sudo sed -i 's|CASDOOR_ENDPOINT=http://104.208.99.17:9443|CASDOOR_ENDPOINT=https://104.208.99.17:9443|' .env
sudo sed -i 's|FRONTEND_URL=http://104.208.99.17:8081|FRONTEND_URL=https://104.208.99.17:8081|' .env
echo "Updated .env:"
grep -E 'CASDOOR_ENDPOINT|FRONTEND_URL' .env
