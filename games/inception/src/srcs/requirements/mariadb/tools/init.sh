#!/bin/bash
set -e

echo "--- STARTING INIT SCRIPT ---"

USER_PASSWORD=$(cat /run/secrets/user_password)
ROOT_PASSWORD=$(cat /run/secrets/root_password)
DATABASE=$(cat /run/secrets/database)
USER=$(cat /run/secrets/user)

if [ ! -d "/var/lib/mysql/${DATABASE}" ]; then 
    echo "--- DATABASE ${DATABASE} NOT FOUND, INITIALIZING... ---"
    mysql_install_db --user=mysql --datadir=/var/lib/mysql > /dev/null 2>&1

    echo "--- STARTING TEMPORARY MYSQLD ---"
    mysqld_safe --datadir=/var/lib/mysql &

    echo "--- WAITING FOR PING... ---"
    until mariadb-admin ping --silent; do
        sleep 1
    done

    echo "--- CONFIGURING PRIVILEGES ---"
    mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED BY '${ROOT_PASSWORD}';"
    mysql -u root -p${ROOT_PASSWORD} -e "CREATE DATABASE IF NOT EXISTS \`${DATABASE}\`;"
    mysql -u root -p${ROOT_PASSWORD} -e "CREATE USER IF NOT EXISTS '${USER}'@'%' IDENTIFIED BY '${USER_PASSWORD}';"
    mysql -u root -p${ROOT_PASSWORD} -e "GRANT ALL PRIVILEGES ON \`${DATABASE}\`.* TO '${USER}'@'%';"
    mysql -u root -p${ROOT_PASSWORD} -e "FLUSH PRIVILEGES;"

    echo "--- SHUTTING DOWN TEMPORARY MYSQLD ---"
    mysqladmin -u root -p${ROOT_PASSWORD} shutdowni > /dev/null 2>&1
    sleep 5
    echo "--- INIT DONE ---"
else
    echo "--- DATABASE ALREADY EXISTS, SKIPPING INIT ---"
fi

echo "--- RUNNING FINAL MYSQLD_SAFE ---"
exec mysqld_safe --datadir=/var/lib/mysql
