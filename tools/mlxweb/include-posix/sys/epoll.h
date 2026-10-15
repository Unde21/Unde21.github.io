/* sys/epoll.h for posix.js programs (level-triggered, like the default). */
#ifndef MLXWEB_SYS_EPOLL_H
# define MLXWEB_SYS_EPOLL_H
# include <stdint.h>
# ifdef __cplusplus
extern "C" {
# endif
# define EPOLLIN		0x001
# define EPOLLPRI		0x002
# define EPOLLOUT		0x004
# define EPOLLERR		0x008
# define EPOLLHUP		0x010
# define EPOLLRDNORM	0x040
# define EPOLLWRNORM	0x100
# define EPOLLRDHUP		0x2000
# define EPOLLEXCLUSIVE	(1u << 28)
# define EPOLLONESHOT	(1u << 30)
# define EPOLLET		(1u << 31)
# define EPOLL_CTL_ADD	1
# define EPOLL_CTL_DEL	2
# define EPOLL_CTL_MOD	3
# define EPOLL_CLOEXEC	02000000
typedef union epoll_data {
	void		*ptr;
	int			fd;
	uint32_t	u32;
	uint64_t	u64;
}	epoll_data_t;
/* layout used by posix.js: events at 0, data at 8, 16 bytes */
struct epoll_event {
	uint32_t		events;
	epoll_data_t	data;
};
int	epoll_create(int size);
int	epoll_create1(int flags);
int	epoll_ctl(int epfd, int op, int fd, struct epoll_event *ev);
int	epoll_wait(int epfd, struct epoll_event *evs, int max, int timeout);
# ifdef __cplusplus
}
# endif
#endif
