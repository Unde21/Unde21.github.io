/*
** Web build of philo_bonus/srcs_bonus/init_child_bonus.c (samaouch).
** Same logic; fork() is replaced by mlxweb_spawn(), which starts routine()
** as a new "process" made of fibers (see tools/mlxweb/mlx_fibers.c).
** kill() and exit() keep their usual meaning for those processes.
*/

#include "philo_bonus.h"
#include <signal.h>
#include <stdlib.h>
#include <sys/wait.h>

pid_t	mlxweb_spawn(void *(*fn)(void *), void *arg);

typedef struct s_child
{
	t_data	*data;
	size_t	index;
}	t_child;

static void	*child_main(void *ptr)
{
	t_child	*c;

	c = ptr;
	routine(c->data, c->index);
	return (NULL);
}

void	kill_all(t_data *data)
{
	size_t	i;

	i = 0;
	while (i < data->nb_philo)
	{
		if (data->pid[i] > 0)
			kill(data->pid[i], SIGKILL);
		++i;
	}
}

static int	child_creation_loop(t_data *data)
{
	static t_child	*children;
	size_t			i;

	i = 0;
	children = malloc(sizeof(t_child) * data->nb_philo);
	data->start_time = get_current_time_ms();
	while (children && i < data->nb_philo)
	{
		children[i] = (t_child){data, i};
		data->pid[i] = mlxweb_spawn(child_main, &children[i]);
		if (data->pid[i] < 0)
			break ;
		++i;
	}
	if (!children || i < data->nb_philo)
	{
		data->start = ERR_PROCESS;
		ft_putstr_fd(ERR_FORK, 2);
		data->nb_philo = i;
		kill_all(data);
		sem_post(data->sem_end);
		return (-1);
	}
	return (0);
}

int	init_child(t_data *data)
{
	size_t	i;

	i = 0;
	if (init_semaphores(data) == false)
		return (-1);
	if (child_creation_loop(data) != 0)
		return (-1);
	while (i < data->nb_philo)
	{
		sem_wait(data->sem_end);
		++i;
	}
	clear_semaphores(data);
	kill_all(data);
	clear_data(data);
	return (0);
}
