#!/bin/bash
sudo docker exec frp-backend python3 -c "from casdoor_client import get_signin_url; print(get_signin_url())"
