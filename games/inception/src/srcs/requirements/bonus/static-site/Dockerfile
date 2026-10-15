FROM debian:bookworm

RUN apt-get update && apt-get install -y \
	python3 && \
	apt-get clean && \
	rm -rf /var/lib/apt/lists/*

WORKDIR /var/www

COPY www/ .

EXPOSE 8042

CMD ["python3", "-m", "http.server", "8042"]
