/*
** mlx_posix.c — the process side of POSIX for programs run by posix.js:
** fork, execve, waitpid, pipe, dup, dup2, kill, sigaction and a small
** GNU-readline API. Each call goes to the JS runtime, which keeps one
** WebAssembly instance (with its own memory) per process. Calls that may
** block (fork, waitpid, readline, read) unwind with Asyncify and resume
** later; fork() copies the whole memory into the child, like a real fork.
**
** Every import returns a value >= 0 or -errno.
*/

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>
#include <readline/readline.h>
#include <readline/history.h>

#define IMPORT(name) __attribute__((import_module("posix"), import_name(name)))

IMPORT("fork")			int	js_fork(void);
IMPORT("execve")		int	js_execve(const char *p, char *const *a, char *const *e);
IMPORT("waitpid")		int	js_waitpid(int pid, int *status, int options);
IMPORT("pipe")			int	js_pipe(int *fds);
IMPORT("dup")			int	js_dup(int fd);
IMPORT("dup2")			int	js_dup2(int fd, int fd2);
IMPORT("kill")			int	js_kill(int pid, int sig);
IMPORT("getpid")		int	js_getpid(void);
IMPORT("sigaction")		int	js_sigaction(int sig, int handler);
IMPORT("readline")		int	js_readline(const char *prompt, char *buf, int cap,
							volatile int *done);
IMPORT("rl_replace_line")	void	js_rl_replace_line(const char *text);
IMPORT("rl_redisplay")	void	js_rl_redisplay(void);
IMPORT("add_history")	void	js_add_history(const char *line);
IMPORT("clear_history")	void	js_clear_history(void);

static int	ret(int r)
{
	if (r < 0)
	{
		errno = -r;
		return (-1);
	}
	return (r);
}

pid_t	fork(void)
{
	return (ret(js_fork()));
}

int	execve(const char *path, char *const argv[], char *const envp[])
{
	return (ret(js_execve(path, argv, envp)));
}

pid_t	waitpid(pid_t pid, int *status, int options)
{
	return (ret(js_waitpid(pid, status, options)));
}

pid_t	wait(int *status)
{
	return (waitpid(-1, status, 0));
}

int	pipe(int fds[2])
{
	return (ret(js_pipe(fds)));
}

int	dup(int fd)
{
	return (ret(js_dup(fd)));
}

int	dup2(int fd, int fd2)
{
	return (ret(js_dup2(fd, fd2)));
}

int	kill(pid_t pid, int sig)
{
	return (ret(js_kill(pid, sig)));
}

pid_t	getpid(void)
{
	return (js_getpid());
}

pid_t	getppid(void)
{
	return (1);
}

/* ------------------------------------------------ signals */

static struct sigaction	g_act[65];

int	sigaction(int sig, const struct sigaction *act, struct sigaction *old)
{
	int	h;

	if (sig <= 0 || sig > 64 || sig == SIGKILL || sig == SIGSTOP)
		return (errno = EINVAL, -1);
	if (old)
		*old = g_act[sig];
	if (act)
	{
		g_act[sig] = *act;
		if (act->sa_handler == SIG_DFL)
			h = 0;
		else if (act->sa_handler == SIG_IGN)
			h = 1;
		else
			h = (int)(uintptr_t)act->sa_handler;
		/* function pointers are indexes into the exported table */
		return (ret(js_sigaction(sig, h == 0 ? -1 : h == 1 ? -2 : h)));
	}
	return (0);
}

int	sigemptyset(sigset_t *set)
{
	memset(set, 0, sizeof(*set));
	return (0);
}

int	sigfillset(sigset_t *set)
{
	memset(set, 0xff, sizeof(*set));
	return (0);
}

int	sigaddset(sigset_t *set, int sig)
{
	(void)set;
	(void)sig;
	return (0);
}

int	sigdelset(sigset_t *set, int sig)
{
	(void)set;
	(void)sig;
	return (0);
}

int	sigismember(const sigset_t *set, int sig)
{
	(void)set;
	(void)sig;
	return (0);
}

/* Called by the runtime to run a handler while the process is waiting. */
__attribute__((export_name("mlxweb_call_handler")))
void	mlxweb_call_handler(void (*fn)(int), int sig)
{
	fn(sig);
}

/* ------------------------------------------------ readline */

int				rl_done = 0;
int				rl_catch_signals = 1;
int				rl_pending_input = 0;
unsigned long	rl_readline_state = 0;
rl_hook_func_t	*rl_event_hook = NULL;
char			*rl_line_buffer = NULL;

char	*readline(const char *prompt)
{
	int		cap;
	int		n;
	char	*buf;

	cap = 4096;
	buf = malloc(cap);
	if (!buf)
		return (NULL);
	rl_done = 0;
	n = js_readline(prompt ? prompt : "", buf, cap, &rl_done);
	rl_done = 0;
	if (n < 0)
		return (free(buf), NULL);
	buf[n < cap ? n : cap - 1] = 0;
	return (buf);
}

void	rl_replace_line(const char *text, int clear_undo)
{
	(void)clear_undo;
	js_rl_replace_line(text ? text : "");
}

int	rl_on_new_line(void)
{
	return (0);
}

void	rl_redisplay(void)
{
	js_rl_redisplay();
}

void	add_history(const char *line)
{
	if (line && *line)
		js_add_history(line);
}

void	clear_history(void)
{
	js_clear_history();
}

void	rl_clear_history(void)
{
	js_clear_history();
}

/* ------------------------------------------------ start-up */

/* Start in $PWD (WASI programs start in "/"). */
__attribute__((constructor))
static void	mlxweb_init_cwd(void)
{
	char	*pwd;

	pwd = getenv("PWD");
	if (pwd && *pwd == '/')
		chdir(pwd);
}

/* Used by the runtime when a process execs a built-in command. */
__attribute__((export_name("mlxweb_cwd")))
char	*mlxweb_cwd(void)
{
	static char	buf[4096];

	if (!getcwd(buf, sizeof(buf)))
		strcpy(buf, "/");
	return (buf);
}

/* WASI's start-up code only calls main(argc, argv). Programs that use
** main(argc, argv, envp) are built with -Dmain=mlxweb_user_main
** -DMLXWEB_MAIN_ENVP and started through this wrapper. */
#ifdef MLXWEB_MAIN_ENVP
# undef main

extern char	**environ;
int			mlxweb_user_main(int ac, char **av, char **envp);

int	main(int ac, char **av)
{
	return (mlxweb_user_main(ac, av, environ));
}
#endif

/* Asyncify state of this process (copied along with memory by fork). */
static char	g_async_buf[64 * 1024] __attribute__((aligned(16)));

__attribute__((export_name("mlxweb_async_buf")))
void	*mlxweb_async_buf(void)
{
	return (g_async_buf);
}

/* wasi-libc keeps the cwd as typed ("/tmp/.."); the kernel normalises it.
** Programs are built with -Dchdir=mlxweb_chdir to get that behaviour. */
#undef chdir

int	mlxweb_chdir(const char *path)
{
	char	buf[4096];
	char	out[4096];
	char	*part;
	char	*save;
	size_t	len;

	if (!path || !*path)
		return (errno = ENOENT, -1);
	if (path[0] == '/')
		snprintf(buf, sizeof(buf), "%s", path);
	else
	{
		if (!getcwd(out, sizeof(out)))
			return (-1);
		snprintf(buf, sizeof(buf), "%s/%s", out, path);
	}
	out[0] = 0;
	len = 0;
	for (part = strtok_r(buf, "/", &save); part; part = strtok_r(NULL, "/", &save))
	{
		if (!strcmp(part, "."))
			continue ;
		if (!strcmp(part, ".."))
		{
			while (len > 0 && out[len - 1] != '/')
				len--;
			if (len > 0)
				len--;
			out[len] = 0;
			continue ;
		}
		len += snprintf(out + len, sizeof(out) - len, "/%s", part);
	}
	if (!len)
		strcpy(out, "/");
	return (chdir(out));
}
