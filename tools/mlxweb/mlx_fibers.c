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
#include <semaphore.h>
#include <stdarg.h>
#include <fcntl.h>
#include <sys/types.h>

#undef exit

__attribute__((import_module("mlxweb"), import_name("fiber_switch")))
void	js_fiber_switch(void);
__attribute__((import_module("mlxweb"), import_name("now")))
double	js_now(void);

#define MAX_FIBERS 260
#define FIBER_STACK (256 * 1024)
#define FIBER_ABUF (64 * 1024)

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
	double		wake;
	int			pid;
	int			reaped;
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

static int	runnable(int i, double now)
{
	if (i != 0 && g_f[i].state != F_NEW && g_f[i].state != F_READY)
		return (0);
	return (g_f[i].wake <= now);
}

/* Next fiber to run after the current one blocked or finished, or -1 when
** every live fiber is asleep (JS then waits until mlxweb_fiber_wake_min()). */
__attribute__((export_name("mlxweb_fiber_next")))
int	mlxweb_fiber_next(void)
{
	int		k;
	int		i;
	double	now;

	now = js_now();
	for (k = 1; k <= g_nf; k++)
	{
		i = (g_cur + k) % g_nf;
		if (runnable(i, now))
			return (i);
	}
	return (-1);
}

__attribute__((export_name("mlxweb_fiber_wake_min")))
double	mlxweb_fiber_wake_min(void)
{
	int		i;
	double	m;

	m = g_f[0].wake;
	for (i = 1; i < g_nf; i++)
		if ((g_f[i].state == F_NEW || g_f[i].state == F_READY) && g_f[i].wake < m)
			m = g_f[i].wake;
	return (m);
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

/* ------------------------------------------------ processes
** A "process" is a group of fibers sharing a pid (main program: 1). The
** program's memory is shared, which suits 42 projects where each child
** only uses its own slot of the parent's data before being killed.
*/

#define MAIN_PID 1

static int	g_next_pid = 100;

static int	pid_of(int i)
{
	return (g_f[i].pid ? g_f[i].pid : MAIN_PID);
}

static int	process_alive(int pid)
{
	int	i;

	for (i = 1; i < g_nf; i++)
		if (g_f[i].pid == pid && g_f[i].state != F_DONE)
			return (1);
	return (0);
}

static void	end_process(int pid)
{
	int	i;

	for (i = 1; i < g_nf; i++)
		if (g_f[i].pid == pid)
			g_f[i].state = F_DONE;
}

/* fork() replacement: run fn(arg) as the main thread of a new process. */
pid_t	mlxweb_spawn(void *(*fn)(void *), void *arg)
{
	pthread_t	th;
	int			i;

	if (pthread_create(&th, NULL, fn, arg) != 0)
		return (-1);
	i = (int)th - 1;
	g_f[i].pid = g_next_pid++;
	return (g_f[i].pid);
}

/* exit() for the fiber build (-Dexit=mlxweb_exit): ends only the calling
** process; the main process really exits. */
void	mlxweb_exit(int code)
{
	int	pid;

	pid = pid_of(g_cur);
	if (pid == MAIN_PID)
		exit(code);
	end_process(pid);
	for (;;)
		js_fiber_switch();
}

extern int		mlxweb_sound_kill(pid_t pid, int sig);
extern pid_t	mlxweb_sound_waitpid(pid_t pid, int *status, int options);

int	kill(pid_t pid, int sig)
{
	int	i;

	for (i = 1; i < g_nf; i++)
		if (g_f[i].pid == pid)
		{
			end_process(pid);
			if (pid_of(g_cur) == pid)
				for (;;)
					js_fiber_switch();
			return (0);
		}
	return (mlxweb_sound_kill(pid, sig));
}

static int	is_process(int pid)
{
	int	i;

	for (i = 1; i < g_nf; i++)
		if (g_f[i].pid == pid)
			return (1);
	return (0);
}

static void	reap(int pid)
{
	int	i;

	for (i = 1; i < g_nf; i++)
		if (g_f[i].pid == pid)
			g_f[i].reaped = 1;
}

pid_t	waitpid(pid_t pid, int *status, int options)
{
	if (status)
		*status = 0;
	if (pid > 0 && !is_process(pid))
		return (mlxweb_sound_waitpid(pid, status, options));
	for (;;)
	{
		for (int i = 1; i < g_nf; i++)
		{
			int	p = g_f[i].pid;

			if (p && p != MAIN_PID && !g_f[i].reaped && (pid <= 0 || p == pid)
				&& !process_alive(p))
				return (reap(p), p);
		}
		if (options & 1)
			return (0);
		{
			int	any = 0;

			for (int i = 1; i < g_nf; i++)
				if (g_f[i].pid && g_f[i].pid != MAIN_PID && !g_f[i].reaped
					&& (pid <= 0 || g_f[i].pid == pid))
					any = 1;
			if (!any)
				return (-1);
		}
		block();
	}
}

pid_t	wait(int *status)
{
	return (waitpid(-1, status, 0));
}

/* ------------------------------------------------ named semaphores */
typedef struct s_sem
{
	char	name[64];
	int		value;
	int		linked;
}	t_sem;

#define MAX_SEMS 32

static t_sem	*g_sems[MAX_SEMS];

sem_t	*sem_open(const char *name, int oflag, ...)
{
	va_list		ap;
	unsigned	value;
	int			i;
	t_sem		*s;

	for (i = 0; i < MAX_SEMS; i++)
		if (g_sems[i] && g_sems[i]->linked && !strcmp(g_sems[i]->name, name))
		{
			if ((oflag & O_CREAT) && (oflag & O_EXCL))
				return (SEM_FAILED);
			return ((sem_t *)g_sems[i]);
		}
	if (!(oflag & O_CREAT))
		return (SEM_FAILED);
	va_start(ap, oflag);
	(void)va_arg(ap, int);
	value = va_arg(ap, unsigned);
	va_end(ap);
	s = calloc(1, sizeof(t_sem));
	if (!s)
		return (SEM_FAILED);
	strncpy(s->name, name, sizeof(s->name) - 1);
	s->value = (int)value;
	s->linked = 1;
	for (i = 0; i < MAX_SEMS; i++)
		if (!g_sems[i] || !g_sems[i]->linked)
		{
			g_sems[i] = s;
			return ((sem_t *)s);
		}
	free(s);
	return (SEM_FAILED);
}

int	sem_unlink(const char *name)
{
	for (int i = 0; i < MAX_SEMS; i++)
		if (g_sems[i] && g_sems[i]->linked && !strcmp(g_sems[i]->name, name))
		{
			g_sems[i]->linked = 0;
			return (0);
		}
	return (-1);
}

int	sem_close(sem_t *sem)
{
	(void)sem;
	return (0);
}

/* Every sem_wait() is also a scheduling point, so busy loops that only
** take and release semaphores (supervisors) still let the others run. */
int	sem_wait(sem_t *sem)
{
	t_sem	*s;

	s = (t_sem *)sem;
	block();
	while (s->value <= 0)
		block();
	s->value--;
	return (0);
}

int	sem_trywait(sem_t *sem)
{
	t_sem	*s;

	s = (t_sem *)sem;
	if (s->value <= 0)
		return (errno = EAGAIN, -1);
	s->value--;
	return (0);
}

int	sem_post(sem_t *sem)
{
	((t_sem *)sem)->value++;
	return (0);
}

int	sem_getvalue(sem_t *restrict sem, int *restrict v)
{
	*v = ((t_sem *)sem)->value;
	return (0);
}

/* usleep() lets the other fibers run until this one's wake-up time. */
int	usleep(unsigned int us)
{
	double	wake;

	wake = js_now() + us / 1000.0;
	g_f[g_cur].wake = wake;
	while (js_now() < wake)
		block();
	g_f[g_cur].wake = 0;
	return (0);
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
	f->pid = pid_of(g_cur);
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
