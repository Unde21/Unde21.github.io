FROM debian:bookworm

RUN apt-get update && apt-get install -y \
	redis-server && \
	apt-get clean && \
	rm -rf /var/lib/apt/lists/*

COPY ./tools/init.sh /usr/local/bin/init.sh

RUN chmod +x /usr/local/bin/init.sh

ENTRYPOINT ["sh", "/usr/local/bin/init.sh"]
