FROM debian:bookworm

RUN apt update && apt install -y \
	mariadb-server \
	mariadb-client && \
	mkdir -p /var/run/mysqld && \
	chown -R mysql:mysql /var/run/mysqld && \
	chmod 777 /var/run/mysqld && \
	apt clean && \
	rm -rf /var/lib/apt/lists/*

COPY ./conf/mariadb.cnf /etc/mysql/mariadb.conf.d/50-server.cnf

COPY ./tools/init.sh /usr/local/bin/init.sh

RUN rm -rf /var/lib/mysql/* && \
	chmod +x /usr/local/bin/init.sh && \
	mkdir -p /var/log/mysql && \
	chown -R mysql:mysql /var/log/mysql

EXPOSE 3306

ENTRYPOINT ["sh", "/usr/local/bin/init.sh"]
