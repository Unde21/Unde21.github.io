/* <sys/wait.h> for the browser process runtime (Linux status encoding). */
#ifndef MLXWEB_POSIX_SYS_WAIT_H
# define MLXWEB_POSIX_SYS_WAIT_H
# include <sys/types.h>
# define WNOHANG 1
# define WUNTRACED 2
# define WEXITSTATUS(s) (((s) & 0xff00) >> 8)
# define WTERMSIG(s) ((s) & 0x7f)
# define WIFEXITED(s) (!WTERMSIG(s))
# define WIFSIGNALED(s) (((signed char)(((s) & 0x7f) + 1) >> 1) > 0)
# define WCOREDUMP(s) ((s) & 0x80)
# define WIFSTOPPED(s) 0
# ifdef __cplusplus
extern "C" {
# endif
pid_t	waitpid(pid_t pid, int *status, int options);
pid_t	wait(int *status);
# ifdef __cplusplus
}
# endif
#endif
