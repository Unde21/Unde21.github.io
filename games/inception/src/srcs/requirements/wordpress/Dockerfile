FROM debian:bookworm

RUN apt update && apt install -y \
	php8.2-fpm \
	php8.2-mysql \
	php8.2-gd \
	php8.2-mbstring \
	php8.2-xml \
	mariadb-client \
	net-tools \
	netcat-openbsd \
	wget \
	php-redis \
	curl && \
	apt clean && \
	rm -rf /var/lib/apt/lists/* && \
	mkdir -p /run/php && \
	mkdir -p /var/www/html && \
	chown -R www-data:www-data /var/www/html && \
	chmod -R 777 /var/www/html

COPY conf/www.conf /etc/php/8.2/fpm/pool.d/www.conf

WORKDIR /var/www/html

COPY tools/init.sh /usr/local/bin 

RUN chmod +x /usr/local/bin/init.sh

EXPOSE 9000

ENTRYPOINT ["sh", "/usr/local/bin/init.sh"]
