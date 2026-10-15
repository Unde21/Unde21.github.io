/*
** mlx_sound.c — "processes" that play a sound, for 42 projects that fork a
** player (cvlc, paplay, afplay...). mlxweb_play() starts a sound in the
** browser and returns a fake pid; waitpid()/kill() then behave as usual.
*/
#include <sys/types.h>
#include <sys/wait.h>

__attribute__((import_module("mlxweb"), import_name("sound_play")))
int	js_sound_play(const char *path, int loop);
__attribute__((import_module("mlxweb"), import_name("sound_alive")))
int	js_sound_alive(int pid);
__attribute__((import_module("mlxweb"), import_name("sound_stop")))
void	js_sound_stop(int pid);

pid_t	mlxweb_play(const char *path, int loop)
{
	return (js_sound_play(path, loop));
}

pid_t	mlxweb_sound_waitpid(pid_t pid, int *status, int options)
{
	(void)options;
	if (status)
		*status = 0;
	if (pid > 0 && js_sound_alive(pid))
		return (0);
	return (pid);
}

pid_t	mlxweb_sound_wait(int *status)
{
	if (status)
		*status = 0;
	return (-1);
}

int	mlxweb_sound_kill(pid_t pid, int sig)
{
	(void)sig;
	if (pid > 0)
		js_sound_stop(pid);
	return (0);
}

/* Weak, so the fiber build (mlx_fibers.c) can also emulate child processes. */
__attribute__((weak)) pid_t	waitpid(pid_t pid, int *status, int options)
{
	return (mlxweb_sound_waitpid(pid, status, options));
}

__attribute__((weak)) pid_t	wait(int *status)
{
	return (mlxweb_sound_wait(status));
}

__attribute__((weak)) int	kill(pid_t pid, int sig)
{
	return (mlxweb_sound_kill(pid, sig));
}
