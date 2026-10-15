/*
** Web build of srcs_bonus/game/sound/init.c (Cub3D, by ale-guel).
** Same behaviour; instead of fork() + execlp("cvlc", ...), each sound is
** played by the browser and gets a fake pid, so the rest of the sound code
** (waitpid / kill / remove_sound) runs unchanged.
*/

#include "struct_bonus.h"
#include "time_bonus.h"
#include "utils_bonus.h"
#include <stdlib.h>
#include <strings.h>
#include <sys/types.h>

pid_t	mlxweb_play(const char *path, int loop);

static void	play_sound(t_sound *sound, int info, const char **tab)
{
	if (info == 26)
		sound->pid = mlxweb_play(DIE_MP3, 1);
	else if (info == 30)
		sound->pid = mlxweb_play(FREEDOM_MP3, 1);
	else if (info == 22)
		sound->pid = mlxweb_play(BACK_SOUND_MP3, 1);
	else
		sound->pid = mlxweb_play(tab[info], 0);
}

t_sound	*create_sound(t_data *data, int info)
{
	t_sound		*sound;
	const char	*tab[] = {LUMOS_MP3, ARANIA_EXUMAI_MP3, PROTEGO_MP3,
		INCENDIO_MP3, GLACIUS_MP3, REPULSO_MP3, AGUAMENTI_MP3,
		EXPELLIARMUS_MP3, EPISKEY_MP3, EXPECTO_PATRONUM_MP3,
		PETRIFICUS_TOTALUS_MP3, SERPENSORTIA_MP3, VENTUS_MP3, BOMBARDA_MP3,
		STUPEFIX_MP3, OPPUGNO_MP3, VULNERA_SANENTUR_MP3,
		VIPERA_EVANESCA_MP3, CONFUNDO_MP3, SECTUMSEMPRA_MP3, ENDOLORIS_MP3,
		AVADA_KEDAVRA_MP3, BACK_SOUND_MP3, THEME_HP_MP3, CRY_MP3, TP_MP3,
		DIE_MP3, PAPER_MP3, COLLECT_WAND_MP3, POPO_MP3, FREEDOM_MP3,
		FLOO_MP3, HEART_MP3, LVL_UP, WALL_MP3};

	sound = malloc(sizeof(t_sound));
	if (!sound)
		f_exit(data, 1);
	bzero(sound, sizeof(t_sound));
	sound->id = info;
	play_sound(sound, info, tab);
	sound->start = get_mtime();
	sound->duration = -1;
	return (sound);
}
