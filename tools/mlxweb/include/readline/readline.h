/* Minimal GNU readline API for the browser terminal (see mlx_posix.c). */
#ifndef MLXWEB_READLINE_H
# define MLXWEB_READLINE_H
# include <stdio.h>
# define RL_STATE_COMPLETING 0x0004000
typedef int	rl_hook_func_t(void);
extern int				rl_done;
extern int				rl_catch_signals;
extern int				rl_pending_input;
extern unsigned long	rl_readline_state;
extern rl_hook_func_t	*rl_event_hook;
extern char				*rl_line_buffer;
char	*readline(const char *prompt);
void	rl_replace_line(const char *text, int clear_undo);
int		rl_on_new_line(void);
void	rl_redisplay(void);
void	rl_clear_history(void);
#endif
