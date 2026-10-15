/* Minimal <sys/wait.h> for the browser port: child "processes" are sounds. */
#ifndef MLXWEB_SYS_WAIT_H
# define MLXWEB_SYS_WAIT_H
# include <sys/types.h>
# define WNOHANG 1
# define WUNTRACED 2
pid_t	waitpid(pid_t pid, int *status, int options);
pid_t	wait(int *status);
int		kill(pid_t pid, int sig);
#endif
