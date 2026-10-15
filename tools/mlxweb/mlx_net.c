/*
** mlx_net.c — sockets, getaddrinfo and epoll for programs run by posix.js.
** The network is virtual: listening sockets live in the runtime, and the
** web page connects to them (see Posix.net in posix.js). Calls that may
** block (accept, recv, send, epoll_wait) unwind with Asyncify.
**
** Every import returns a value >= 0 or -errno.
*/

#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netdb.h>
#include <sys/socket.h>
#include <sys/epoll.h>

#define IMPORT(name) __attribute__((import_module("posix"), import_name(name)))

IMPORT("socket")		int	js_socket(int domain, int type);
IMPORT("bind")			int	js_bind(int fd, int port);
IMPORT("listen")		int	js_listen(int fd, int backlog);
IMPORT("accept")		int	js_accept(int fd, int flags);
IMPORT("recv")			int	js_recv(int fd, void *buf, int len, int flags);
IMPORT("send")			int	js_send(int fd, const void *buf, int len, int flags);
IMPORT("shutdown")		int	js_shutdown(int fd, int how);
IMPORT("sock_port")		int	js_sock_port(int fd, int peer);
IMPORT("epoll_create")	int	js_epoll_create(void);
IMPORT("epoll_ctl")		int	js_epoll_ctl(int epfd, int op, int fd, void *ev);
IMPORT("epoll_wait")	int	js_epoll_wait(int epfd, void *evs, int max, int timeout);

static int	ret(int r)
{
	if (r < 0)
	{
		errno = -r;
		return (-1);
	}
	return (r);
}

static int	sockaddr_port(const struct sockaddr *addr, socklen_t len)
{
	if (!addr)
		return (-EINVAL);
	if (addr->sa_family == AF_INET && len >= sizeof(struct sockaddr_in))
		return (ntohs(((const struct sockaddr_in *)addr)->sin_port));
	if (addr->sa_family == AF_INET6 && len >= sizeof(struct sockaddr_in6))
		return (ntohs(((const struct sockaddr_in6 *)addr)->sin6_port));
	return (-EAFNOSUPPORT);
}

static void	fill_loopback(struct sockaddr *addr, socklen_t *len, int port)
{
	struct sockaddr_in	in;

	if (!addr || !len)
		return ;
	memset(&in, 0, sizeof(in));
	in.sin_family = AF_INET;
	in.sin_port = htons(port);
	in.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	memcpy(addr, &in, *len < sizeof(in) ? *len : sizeof(in));
	*len = sizeof(in);
}

int	socket(int domain, int type, int protocol)
{
	(void)protocol;
	if (domain != AF_INET && domain != AF_INET6)
		return (errno = EAFNOSUPPORT, -1);
	return (ret(js_socket(domain, type)));
}

int	bind(int fd, const struct sockaddr *addr, socklen_t len)
{
	int	port;

	port = sockaddr_port(addr, len);
	if (port < 0)
		return (errno = -port, -1);
	return (ret(js_bind(fd, port)));
}

int	listen(int fd, int backlog)
{
	return (ret(js_listen(fd, backlog)));
}

int	connect(int fd, const struct sockaddr *addr, socklen_t len)
{
	(void)fd;
	(void)addr;
	(void)len;
	return (errno = ECONNREFUSED, -1);
}

int	mlxweb_accept4(int fd, struct sockaddr *addr, socklen_t *len, int flags)
{
	int	c;

	c = ret(js_accept(fd, flags));
	if (c >= 0)
		fill_loopback(addr, len, 40000 + c);
	return (c);
}

int	mlxweb_accept(int fd, struct sockaddr *addr, socklen_t *len)
{
	return (mlxweb_accept4(fd, addr, len, 0));
}

ssize_t	mlxweb_recv(int fd, void *buf, size_t len, int flags)
{
	return (ret(js_recv(fd, buf, (int)len, flags)));
}

ssize_t	mlxweb_send(int fd, const void *buf, size_t len, int flags)
{
	return (ret(js_send(fd, buf, (int)len, flags)));
}

int	mlxweb_shutdown(int fd, int how)
{
	return (ret(js_shutdown(fd, how)));
}

int	setsockopt(int fd, int level, int name, const void *val, socklen_t len)
{
	(void)fd;
	(void)level;
	(void)name;
	(void)val;
	(void)len;
	return (0);
}

int	mlxweb_getsockopt(int fd, int level, int name, void *val, socklen_t *len)
{
	(void)fd;
	(void)level;
	(void)name;
	if (val && len && *len >= sizeof(int))
	{
		*(int *)val = 0;
		*len = sizeof(int);
	}
	return (0);
}

int	getsockname(int fd, struct sockaddr *addr, socklen_t *len)
{
	int	port;

	port = ret(js_sock_port(fd, 0));
	if (port < 0)
		return (-1);
	fill_loopback(addr, len, port);
	return (0);
}

int	getpeername(int fd, struct sockaddr *addr, socklen_t *len)
{
	int	port;

	port = ret(js_sock_port(fd, 1));
	if (port < 0)
		return (-1);
	fill_loopback(addr, len, port);
	return (0);
}

/* ------------------------------------------------ getaddrinfo */

static int	parse_port(const char *service)
{
	char	*end;
	long	n;

	if (!service || !*service)
		return (0);
	n = strtol(service, &end, 10);
	if (*end || n < 0 || n > 65535)
		return (-1);
	return ((int)n);
}

int	getaddrinfo(const char *node, const char *service,
		const struct addrinfo *hints, struct addrinfo **res)
{
	struct addrinfo		*ai;
	struct sockaddr_in6	*in6;
	struct sockaddr_in	*in;
	int					family;
	int					port;
	unsigned char		buf[16];

	family = hints ? hints->ai_family : AF_UNSPEC;
	port = parse_port(service);
	if (port < 0)
		return (EAI_SERVICE);
	if (!node || !strcmp(node, "localhost"))
		node = family == AF_INET6 ? "::1" : (hints && (hints->ai_flags & AI_PASSIVE)) ? "0.0.0.0" : "127.0.0.1";
	ai = calloc(1, sizeof(*ai) + sizeof(struct sockaddr_in6));
	if (!ai)
		return (EAI_MEMORY);
	ai->ai_socktype = hints && hints->ai_socktype ? hints->ai_socktype : SOCK_STREAM;
	ai->ai_addr = (struct sockaddr *)(ai + 1);
	if (family != AF_INET6 && inet_pton(AF_INET, node, buf) == 1)
	{
		in = (struct sockaddr_in *)ai->ai_addr;
		in->sin_family = AF_INET;
		in->sin_port = htons(port);
		memcpy(&in->sin_addr, buf, 4);
		ai->ai_family = AF_INET;
		ai->ai_addrlen = sizeof(*in);
	}
	else if (family != AF_INET && inet_pton(AF_INET6, node, buf) == 1)
	{
		in6 = (struct sockaddr_in6 *)ai->ai_addr;
		in6->sin6_family = AF_INET6;
		in6->sin6_port = htons(port);
		memcpy(&in6->sin6_addr, buf, 16);
		ai->ai_family = AF_INET6;
		ai->ai_addrlen = sizeof(*in6);
	}
	else
		return (free(ai), EAI_NONAME);
	*res = ai;
	return (0);
}

void	freeaddrinfo(struct addrinfo *res)
{
	struct addrinfo	*next;

	while (res)
	{
		next = res->ai_next;
		free(res);
		res = next;
	}
}

const char	*gai_strerror(int err)
{
	if (err == EAI_NONAME)
		return ("Name or service not known");
	if (err == EAI_SERVICE)
		return ("Servname not supported for ai_socktype");
	if (err == EAI_MEMORY)
		return ("Memory allocation failure");
	return ("Unknown error");
}

/* ------------------------------------------------ epoll */

int	epoll_create1(int flags)
{
	(void)flags;
	return (ret(js_epoll_create()));
}

int	epoll_create(int size)
{
	if (size <= 0)
		return (errno = EINVAL, -1);
	return (epoll_create1(0));
}

int	epoll_ctl(int epfd, int op, int fd, struct epoll_event *ev)
{
	return (ret(js_epoll_ctl(epfd, op, fd, ev)));
}

int	epoll_wait(int epfd, struct epoll_event *evs, int max, int timeout)
{
	if (max <= 0)
		return (errno = EINVAL, -1);
	return (ret(js_epoll_wait(epfd, evs, max, timeout)));
}
