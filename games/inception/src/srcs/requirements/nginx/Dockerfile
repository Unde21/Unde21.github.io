FROM debian:bookworm

RUN apt update && apt install -y \
	nginx \
	openssl && \
	mkdir -p /etc/nginx/ssl && \
	openssl req -x509 -nodes \
	-out /etc/nginx/ssl/inception.crt \
	-keyout /etc/nginx/ssl/inception.key \
	-subj "/C=FR/CN=samaouch.42.fr" &&\
	apt clean && \
	rm -rf /var/lib/apt/lists/* && \
	rm -f /etc/nginx/sites-enabled/default 

COPY conf/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 443 

CMD ["nginx", "-g", "daemon off;"]
