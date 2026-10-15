/* <signal.h> + sigaction(), which WASI lacks; see mlx_posix.c. */
#ifndef MLXWEB_POSIX_SIGNAL_H
# define MLXWEB_POSIX_SIGNAL_H
# include_next <signal.h>
# include <sys/types.h>
struct sigaction
{
	union
	{
		void	(*sa_handler)(int);
		void	(*sa_sigaction)(int, void *, void *);
	}		__sa_handler;
	sigset_t	sa_mask;
	int			sa_flags;
	void		(*sa_restorer)(void);
};
# define sa_handler __sa_handler.sa_handler
# define sa_sigaction __sa_handler.sa_sigaction
# define SA_NOCLDSTOP 1
# define SA_NOCLDWAIT 2
# define SA_SIGINFO 4
# define SA_ONSTACK 0x08000000
# define SA_RESTART 0x10000000
# define SA_NODEFER 0x40000000
# define SA_RESETHAND 0x80000000
int	sigaction(int sig, const struct sigaction *act, struct sigaction *old);
int	sigemptyset(sigset_t *set);
int	sigfillset(sigset_t *set);
int	sigaddset(sigset_t *set, int sig);
int	sigdelset(sigset_t *set, int sig);
int	sigismember(const sigset_t *set, int sig);
int	kill(pid_t pid, int sig);
#endif
