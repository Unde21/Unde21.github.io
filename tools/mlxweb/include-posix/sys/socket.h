/* sys/socket.h for programs run by posix.js: the WASI header plus the calls
** it leaves out. Sockets live in the runtime's virtual network (posix.js). */
#ifndef MLXWEB_SYS_SOCKET_H
# define MLXWEB_SYS_SOCKET_H
# include_next <sys/socket.h>
# ifndef MSG_NOSIGNAL
#  define MSG_NOSIGNAL 0x4000
# endif
# ifndef MSG_DONTWAIT
#  define MSG_DONTWAIT 0x0040
# endif
# ifndef SO_REUSEADDR
#  define SO_REUSEADDR 2
#  define SO_ERROR 4
#  define SO_KEEPALIVE 9
#  define SO_REUSEPORT 15
# endif
# ifndef SOMAXCONN
#  define SOMAXCONN 128
# endif
# ifdef __cplusplus
extern "C" {
# endif
int		socket(int domain, int type, int protocol);
int		bind(int fd, const struct sockaddr *addr, socklen_t len);
int		listen(int fd, int backlog);
int		connect(int fd, const struct sockaddr *addr, socklen_t len);
int		setsockopt(int fd, int level, int name, const void *val, socklen_t len);
int		getsockname(int fd, struct sockaddr *addr, socklen_t *len);
int		getpeername(int fd, struct sockaddr *addr, socklen_t *len);
int		mlxweb_accept(int fd, struct sockaddr *addr, socklen_t *len);
int		mlxweb_accept4(int fd, struct sockaddr *addr, socklen_t *len, int flags);
ssize_t	mlxweb_recv(int fd, void *buf, size_t len, int flags);
ssize_t	mlxweb_send(int fd, const void *buf, size_t len, int flags);
int		mlxweb_getsockopt(int fd, int level, int name, void *val, socklen_t *len);
int		mlxweb_shutdown(int fd, int how);
# ifdef __cplusplus
}
# endif
/* WASI libc has its own versions of these, tied to WASI sockets */
# define accept(...) mlxweb_accept(__VA_ARGS__)
# define accept4(...) mlxweb_accept4(__VA_ARGS__)
# define recv(...) mlxweb_recv(__VA_ARGS__)
# define send(...) mlxweb_send(__VA_ARGS__)
# define getsockopt(...) mlxweb_getsockopt(__VA_ARGS__)
# define shutdown(...) mlxweb_shutdown(__VA_ARGS__)
#endif
