#!/bin/bash

cd /var/www/html

if [ ! -f "/usr/local/bin/wp" ]; then
	wget https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
	chmod +x wp-cli.phar
	mv wp-cli.phar /usr/local/bin/wp
fi

if [ ! -f "index.php" ]; then
	wp core download --version=6.4.3 --allow-root
fi

USER_PASSWORD=$(cat /run/secrets/user_password)
DATABASE=$(cat /run/secrets/database)
USER=$(cat /run/secrets/user)
DOMAIN_NAME=$(cat /run/secrets/domain_name)
ROOT_USER=$(cat /run/secrets/root_user)
ROOT_PASSWORD=$(cat /run/secrets/root_password)


until nc -z mariadb 3306; do
    echo "Waiting for MariaDB..."
    sleep 2
done


if [ ! -f "wp-config.php" ]; then
	echo "<?php" > wp-config.php
	echo "define('DB_NAME', '$DATABASE');" >> wp-config.php
	echo "define('DB_USER', '$USER');" >> wp-config.php
	echo "define('DB_PASSWORD', '$USER_PASSWORD');" >> wp-config.php
	echo "define('DB_HOST', 'mariadb');" >> wp-config.php
	echo "\$table_prefix = 'wp_';" >> wp-config.php
	echo "define('WP_REDIS_HOST', 'redis');" >> wp-config.php
	echo "define('WP_REDIS_PORT', 6379);" >> wp-config.php
	echo "define('WP_REDIS_PASSWORD', '$USER_PASSWORD');" >> wp-config.php
	echo "define('WP_CACHE', true);" >> wp-config.php
	echo "if ( ! defined('ABSPATH')) {" >> wp-config.php
	echo "	define('ABSPATH', __DIR__ . '/');" >> wp-config.php
	echo "}" >> wp-config.php
	echo "require_once ABSPATH . 'wp-settings.php';" >> wp-config.php
fi

echo "Checking DB ..."
until wp db check --allow-root --path=/var/www/html; do
    echo "MariaDB is up but not ready for login yet..."
    sleep 2
done
echo "Mariadb is Up!"

if ! wp core is-installed --allow-root; then
	wp core install --url=$DOMAIN_NAME --title="Inception" --admin_user=$ROOT_USER --admin_password=$ROOT_PASSWORD --admin_email="admin@42.fr" --skip-email --allow-root
	wp user create $USER "$USER@42.fr" --role=author --user_pass=$USER_PASSWORD --allow-root 2>/dev/null
	wp plugin install redis-cache --activate --allow-root
	wp redis enable --allow-root
	echo "wordpress installation finished!"
else
	echo "wordpress is already installed!"
fi

mkdir -p /run/php
chown -R www-data:www-data /var/www/html
exec /usr/sbin/php-fpm8.2 -F

