#!/bin/bash
sudo docker exec casdoor-db mysql -uroot -p'Palink@Cas2026!' casdoor -e "SELECT name, redirect_uris FROM application;"
