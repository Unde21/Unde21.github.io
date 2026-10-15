#!/bin/sh

USER_PASSWORD=$(cat /run/secrets/user_password)

exec redis-server --bind 0.0.0.0 --requirepass "$USER_PASSWORD" --protected-mode no
