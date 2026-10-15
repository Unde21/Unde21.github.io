/* <unistd.h> + the process calls WASI lacks, provided by mlx_posix.c. */
#ifndef MLXWEB_POSIX_UNISTD_H
# define MLXWEB_POSIX_UNISTD_H
# include_next <unistd.h>
# ifdef __cplusplus
extern "C" {
# endif
pid_t	fork(void);
int		execve(const char *path, char *const argv[], char *const envp[]);
int		pipe(int fds[2]);
int		dup(int fd);
int		dup2(int fd, int fd2);
# ifdef __cplusplus
}
# endif
#endif
