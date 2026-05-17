#!/bin/bash
# 1. Update Casdoor redirect URI to HTTPS
sudo docker exec casdoor-db mysql -uroot -p'Palink@Cas2026!' casdoor -e "UPDATE application SET redirect_uris='[\"https://104.208.99.17:8081/auth/callback\"]' WHERE name='frp-platform';"
echo "Casdoor redirect URI updated to HTTPS"

# 2. Update Casdoor origin to HTTPS
sudo sed -i 's|origin = https://104.208.99.17:9443|origin = https://104.208.99.17:9443|' /home/azureuser/casdoor/app.conf
echo "Casdoor app.conf checked"

# 3. Restart Casdoor to pick up changes
sudo docker restart casdoor
echo "Casdoor restarted"
