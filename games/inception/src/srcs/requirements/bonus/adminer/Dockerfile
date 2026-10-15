FROM debian:bookworm 

RUN apt-get update && apt-get install -y \
	php8.2 \
	php8.2-mysql \
	wget && \
	apt-get clean && \
	rm -rf /var/lib/apt/lists/*

WORKDIR /var/www/html

RUN wget https://github.com/vrana/adminer/releases/download/v4.17.1/adminer-4.17.1-mysql.php -O index.php \
	&& chown -R www-data:www-data /var/www/html

EXPOSE 8080

CMD ["php", "-S", "0.0.0.0:8080", "-t", "/var/www/html"]
