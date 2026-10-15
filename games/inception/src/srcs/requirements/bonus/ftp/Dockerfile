FROM debian:bookworm

RUN apt update && apt install -y \
	vsftpd && \
	rm -rf /var/lib/apt/lists/*

COPY ./conf/vsftpd.conf /etc/vsftpd.conf

COPY ./tools/init.sh /usr/local/bin/init.sh

RUN chmod +x /usr/local/bin/init.sh

EXPOSE 21 40000-40005

ENTRYPOINT [ "/usr/local/bin/init.sh" ]
