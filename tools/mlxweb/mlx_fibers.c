/*
** mlx_fibers.c — pthreads as cooperative fibers, for browsers without
** cross-origin isolation (no SharedArrayBuffer, so no real threads).
**
** Every pthread gets its own C stack and Asyncify buffer. A thread runs
** until it has to wait (barrier, mutex, join); it then unwinds back to the
** JS scheduler in runtime.js, which rewinds the next runnable fiber.
** The program's code is unchanged: it still calls pthread_create(),
** pthread_barrier_wait() and friends, it just runs on one core.
*/

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <pthread.h>

__attribute__((import_module("mlxweb"), import_name("fiber_switch")))
void	js_fiber_switch(void);

#define MAX_FIBERS 64
#define FIBER_STACK (1024 * 1024)
#define FIBER_ABUF (128 * 1024)

enum { F_FREE, F_NEW, F_READY, F_DONE };

typedef struct s_fiber
{
	void		*(*fn)(void *);
	void		*arg;
	void		*ret;
	int			state;
	uint8_t		*stack;
	uint8_t		*abuf;
	uint32_t	sp;
}	t_fiber;

static t_fiber	g_f[MAX_FIBERS];
static int		g_nf = 1;
static int		g_cur = 0;

extern void		*mlxweb_async_buf(void);
extern int		mlxweb_async_size(void);

/* ------------------------------------------------ scheduler interface (JS) */

__attribute__((export_name("mlxweb_fiber_set")))
void	mlxweb_fiber_set(int i)
{
	g_cur = i;
	if (i == 0 && g_f[0].state == F_FREE)
		g_f[0].state = F_READY;
}

__attribute__((export_name("mlxweb_fiber_state")))
int	mlxweb_fiber_state(int i)
{
	if (i == 0)
		return (F_READY);
	return (g_f[i].state);
}

__attribute__((export_name("mlxweb_fiber_abuf")))
void	*mlxweb_fiber_abuf(int i)
{
	return (i == 0 ? mlxweb_async_buf() : g_f[i].abuf);
}

__attribute__((export_name("mlxweb_fiber_abuf_size")))
int	mlxweb_fiber_abuf_size(int i)
{
	return (i == 0 ? mlxweb_async_size() : FIBER_ABUF);
}

__attribute__((export_name("mlxweb_fiber_stack_top")))
uint32_t	mlxweb_fiber_stack_top(int i)
{
	return ((uint32_t)(uintptr_t)(g_f[i].stack + FIBER_STACK) & ~15u);
}

/* Next fiber to run after the current one blocked or finished. */
__attribute__((export_name("mlxweb_fiber_next")))
int	mlxweb_fiber_next(void)
{
	int	k;
	int	i;

	for (k = 1; k <= g_nf; k++)
	{
		i = (g_cur + k) % g_nf;
		if (i == 0 || g_f[i].state == F_NEW || g_f[i].state == F_READY)
			return (i);
	}
	return (0);
}

/* Entry of every non-main fiber (called by JS on a fresh stack). */
__attribute__((export_name("mlxweb_fiber_start")))
void	mlxweb_fiber_start(int i)
{
	t_fiber	*f;

	f = &g_f[i];
	f->state = F_READY;
	f->ret = f->fn(f->arg);
	f->state = F_DONE;
}

static void	block(void)
{
	js_fiber_switch();
}

/* ------------------------------------------------ pthreads */

int	pthread_create(pthread_t *th, const pthread_attr_t *attr,
		void *(*fn)(void *), void *arg)
{
	t_fiber	*f;

	(void)attr;
	if (g_nf >= MAX_FIBERS)
		return (EAGAIN);
	f = &g_f[g_nf];
	memset(f, 0, sizeof(*f));
	f->stack = malloc(FIBER_STACK);
	f->abuf = malloc(FIBER_ABUF);
	if (!f->stack || !f->abuf)
		return (free(f->stack), free(f->abuf), EAGAIN);
	f->fn = fn;
	f->arg = arg;
	f->state = F_NEW;
	*th = (pthread_t)(g_nf + 1);
	g_nf++;
	return (0);
}

int	pthread_join(pthread_t th, void **ret)
{
	int	i;

	i = (int)th - 1;
	if (i <= 0 || i >= g_nf)
		return (ESRCH);
	while (g_f[i].state != F_DONE)
		block();
	if (ret)
		*ret = g_f[i].ret;
	return (0);
}

int	pthread_detach(pthread_t th)
{
	(void)th;
	return (0);
}

pthread_t	pthread_self(void)
{
	return ((pthread_t)(g_cur + 1));
}

#undef pthread_equal
int	pthread_equal(pthread_t a, pthread_t b)
{
	return (a == b);
}

/* barriers */
typedef struct s_bar
{
	unsigned	n;
	unsigned	count;
	unsigned	gen;
}	t_bar;

_Static_assert(sizeof(t_bar) <= sizeof(pthread_barrier_t), "barrier size");

int	pthread_barrier_init(pthread_barrier_t *b, const pthread_barrierattr_t *a,
		unsigned n)
{
	t_bar	*x;

	(void)a;
	if (n == 0)
		return (EINVAL);
	x = (t_bar *)b;
	x->n = n;
	x->count = 0;
	x->gen = 0;
	return (0);
}

int	pthread_barrier_destroy(pthread_barrier_t *b)
{
	(void)b;
	return (0);
}

int	pthread_barrier_wait(pthread_barrier_t *b)
{
	t_bar		*x;
	unsigned	gen;

	x = (t_bar *)b;
	gen = x->gen;
	if (++x->count >= x->n)
	{
		x->count = 0;
		x->gen++;
		return (PTHREAD_BARRIER_SERIAL_THREAD);
	}
	while (x->gen == gen)
		block();
	return (0);
}

/* mutexes (every symbol of libc's mutex.o, so it is never pulled in) */
typedef struct s_mtx
{
	int	locked;
	int	owner;
}	t_mtx;

_Static_assert(sizeof(t_mtx) <= sizeof(pthread_mutex_t), "mutex size");

int	pthread_mutex_init(pthread_mutex_t *m, const pthread_mutexattr_t *a)
{
	(void)a;
	memset(m, 0, sizeof(*m));
	return (0);
}

int	pthread_mutex_destroy(pthread_mutex_t *m)
{
	(void)m;
	return (0);
}

int	pthread_mutex_trylock(pthread_mutex_t *m)
{
	t_mtx	*x;

	x = (t_mtx *)m;
	if (x->locked && x->owner != g_cur)
		return (EBUSY);
	x->locked = 1;
	x->owner = g_cur;
	return (0);
}

int	pthread_mutex_lock(pthread_mutex_t *m)
{
	while (pthread_mutex_trylock(m) == EBUSY)
		block();
	return (0);
}

int	pthread_mutex_timedlock(pthread_mutex_t *restrict m,
		const struct timespec *restrict t)
{
	(void)t;
	return (pthread_mutex_lock(m));
}

int	pthread_mutex_unlock(pthread_mutex_t *m)
{
	((t_mtx *)m)->locked = 0;
	return (0);
}

int	pthread_mutex_consistent(pthread_mutex_t *m)
{
	(void)m;
	return (0);
}

int	__pthread_mutex_lock(pthread_mutex_t *m) { return (pthread_mutex_lock(m)); }
int	__pthread_mutex_unlock(pthread_mutex_t *m) { return (pthread_mutex_unlock(m)); }
int	__pthread_mutex_trylock(pthread_mutex_t *m) { return (pthread_mutex_trylock(m)); }
int	__pthread_mutex_timedlock(pthread_mutex_t *restrict m,
		const struct timespec *restrict t) { return (pthread_mutex_timedlock(m, t)); }
int	__pthread_mutex_consistent(pthread_mutex_t *m) { return (0); (void)m; }
