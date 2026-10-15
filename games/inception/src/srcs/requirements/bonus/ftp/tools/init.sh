#! /bin/bash

set -e

FTP_USER=$(cat /run/secrets/ftpuser)
FTP_PASSWORD=$(cat /run/secrets/ftp-password)

if id "$FTP_USER" &>dev/null; then
	echo "User already exists, skip creation.."
else
	echo "Creating user $FTP_USER..."
	useradd -m -s /bin/bash $FTP_USER
fi

echo "$FTP_USER:$FTP_PASSWORD" | chpasswd

chown -R $FTP_USER:$FTP_USER /var/www/html
chmod -R 777 /var/www/html
mkdir -p /var/run/vsftpd/empty

echo "RUNNING VSFTPD"
exec vsftpd /etc/vsftpd.conf
