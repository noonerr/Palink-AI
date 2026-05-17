#!/bin/bash
# Copy SSL certs to Casdoor config directory
sudo mkdir -p /home/azureuser/casdoor/ssl
sudo cp /etc/nginx/ssl/server.crt /home/azureuser/casdoor/ssl/
sudo cp /etc/nginx/ssl/server.key /home/azureuser/casdoor/ssl/
sudo chmod 644 /home/azureuser/casdoor/ssl/server.crt
sudo chmod 600 /home/azureuser/casdoor/ssl/server.key
echo "SSL certs copied to Casdoor config dir"
