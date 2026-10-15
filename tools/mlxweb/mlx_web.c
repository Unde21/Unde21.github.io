/*
** mlx_web.c — MiniLibX re-implemented on top of an HTML canvas.
**
** Same API as minilibx-linux (include/mlx.h), so 42 projects compile
** unchanged to WebAssembly (wasi-sdk). Images live in linear memory,
** windows are canvases, X11 events come from the browser through a
** small JS runtime (runtime.js). mlx_loop() yields to the browser once
** per animation frame thanks to Binaryen's Asyncify.
*/

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <ctype.h>
#include "mlx.h"

#define IMPORT(name) __attribute__((import_module("mlxweb"), import_name(name)))

IMPORT("window")	void	js_window(int w, int h, const char *title);
IMPORT("present")	void	js_present(const uint8_t *rgba, int w, int h);
IMPORT("poll")		int		js_poll(int *ev);
IMPORT("yield")		void	js_yield(void);
IMPORT("now")		double	js_now(void);
IMPORT("screen")	void	js_screen(int *w, int *h);
IMPORT("cursor")	void	js_cursor(int visible);
IMPORT("autorepeat")	void	js_autorepeat(int on);

typedef int	(*t_hook)();

typedef struct s_img
{
	int			w;
	int			h;
	uint32_t	*px;
	uint8_t		*mask;
}	t_img;

typedef struct s_hookslot
{
	t_hook	f;
	void	*param;
}	t_hookslot;

/* Last place each image was put this frame (see replay_puts). */
typedef struct s_put
{
	void		*img;
	int			x;
	int			y;
}	t_put;

typedef struct s_win
{
	int			w;
	int			h;
	uint32_t	*fb;
	uint8_t		*rgba;
	t_hookslot	hooks[36];
	struct s_put	*puts;
	int			nputs;
	int			capputs;
	int			mx;
	int			my;
}	t_win;

typedef struct s_mlx
{
	t_win	*win;
	t_hook	loop_hook;
	void	*loop_param;
	int		running;
}	t_mlx;

static t_win	*g_windows[8];

/* Loop-hook pacing, tunable from JS (see runtime.js `loopRate`). */
static double	g_iter_per_sec = 0;		/* 0 = as many as fit in budget */
static double	g_budget_ms = 10;

__attribute__((export_name("mlxweb_set_pacing")))
void	mlxweb_set_pacing(double iter_per_sec, double budget_ms)
{
	g_iter_per_sec = iter_per_sec;
	g_budget_ms = budget_ms;
}

/* Scratch area for the Asyncify state (stack of saved locals). */
static uint8_t	g_async_buf[256 * 1024] __attribute__((aligned(16)));

__attribute__((export_name("mlxweb_async_buf")))
void	*mlxweb_async_buf(void)
{
	return (g_async_buf);
}

__attribute__((export_name("mlxweb_async_size")))
int	mlxweb_async_size(void)
{
	return (sizeof(g_async_buf));
}

/* Small buffer JS uses to pass a file path (for mlx_xpm_file_to_image tests). */

void	*mlx_init(void)
{
	t_mlx	*m;

	m = calloc(1, sizeof(t_mlx));
	return (m);
}

void	*mlx_new_window(void *mlx_ptr, int w, int h, char *title)
{
	t_mlx	*m;
	t_win	*win;

	m = mlx_ptr;
	if (!m || w <= 0 || h <= 0)
		return (NULL);
	win = calloc(1, sizeof(t_win));
	if (!win)
		return (NULL);
	win->w = w;
	win->h = h;
	win->fb = calloc((size_t)w * h, 4);
	win->rgba = calloc((size_t)w * h, 4);
	if (!win->fb || !win->rgba)
		return (free(win->fb), free(win->rgba), free(win), NULL);
	win->mx = w / 2;
	win->my = h / 2;
	m->win = win;
	for (int k = 0; k < 8; k++)
		if (!g_windows[k])
		{
			g_windows[k] = win;
			break ;
		}
	js_window(w, h, title ? title : "");
	return (win);
}

int	mlx_clear_window(void *mlx_ptr, void *win_ptr)
{
	t_win	*win;

	(void)mlx_ptr;
	win = win_ptr;
	if (win)
		memset(win->fb, 0, (size_t)win->w * win->h * 4);
	return (0);
}

int	mlx_pixel_put(void *mlx_ptr, void *win_ptr, int x, int y, int color)
{
	t_win	*win;

	(void)mlx_ptr;
	win = win_ptr;
	if (win && x >= 0 && y >= 0 && x < win->w && y < win->h)
		win->fb[y * win->w + x] = (uint32_t)color & 0xFFFFFF;
	return (0);
}

void	*mlx_new_image(void *mlx_ptr, int w, int h)
{
	t_img	*img;

	(void)mlx_ptr;
	if (w <= 0 || h <= 0)
		return (NULL);
	img = calloc(1, sizeof(t_img));
	if (!img)
		return (NULL);
	img->w = w;
	img->h = h;
	img->px = calloc((size_t)w * h, 4);
	if (!img->px)
		return (free(img), NULL);
	return (img);
}

char	*mlx_get_data_addr(void *img_ptr, int *bpp, int *size_line, int *endian)
{
	t_img	*img;

	img = img_ptr;
	if (!img)
		return (NULL);
	if (bpp)
		*bpp = 32;
	if (size_line)
		*size_line = img->w * 4;
	if (endian)
		*endian = 0;
	return ((char *)img->px);
}

static void	blit(t_win *win, t_img *img, int x, int y);

static void	record_put(t_win *win, void *img, int x, int y)
{
	int		i;
	t_put	*grown;

	for (i = 0; i < win->nputs; i++)
		if (win->puts[i].img == img)
			break ;
	if (i < win->nputs)
	{
		memmove(win->puts + i, win->puts + i + 1,
			(win->nputs - i - 1) * sizeof(t_put));
		win->nputs--;
	}
	if (win->nputs == win->capputs)
	{
		grown = realloc(win->puts, sizeof(t_put) * (win->capputs * 2 + 16));
		if (!grown)
			return ;
		win->puts = grown;
		win->capputs = win->capputs * 2 + 16;
	}
	win->puts[win->nputs++] = (t_put){img, x, y};
}

/*
** X11's MiniLibX uses shared memory: the server reads an image's pixels
** a moment after mlx_put_image_to_window(), so pixels a program draws into
** an image right after putting it still reach the screen (Cub3D's menus do
** this). Each image's last put is replayed, in order, before presenting.
*/
static void	replay_puts(t_win *win)
{
	int	i;

	for (i = 0; i < win->nputs; i++)
		blit(win, win->puts[i].img, win->puts[i].x, win->puts[i].y);
	win->nputs = 0;
}

static void	forget_image(void *img)
{
	int		w;
	int		i;
	t_win	*win;

	for (w = 0; w < 8; w++)
	{
		win = g_windows[w];
		if (!win)
			continue ;
		for (i = 0; i < win->nputs; i++)
			if (win->puts[i].img == img)
			{
				memmove(win->puts + i, win->puts + i + 1,
					(win->nputs - i - 1) * sizeof(t_put));
				win->nputs--;
				i--;
			}
	}
}

int	mlx_put_image_to_window(void *mlx_ptr, void *win_ptr, void *img_ptr,
		int x, int y)
{
	(void)mlx_ptr;
	if (!win_ptr || !img_ptr)
		return (0);
	blit(win_ptr, img_ptr, x, y);
	record_put(win_ptr, img_ptr, x, y);
	return (0);
}

static void	blit(t_win *win, t_img *img, int x, int y)
{
	int			sx0, sy0, sx1, sy1, i, j;
	uint32_t	*src, *dst;
	uint8_t		*msk;

	sx0 = x < 0 ? -x : 0;
	sy0 = y < 0 ? -y : 0;
	sx1 = img->w;
	sy1 = img->h;
	if (x + sx1 > win->w)
		sx1 = win->w - x;
	if (y + sy1 > win->h)
		sy1 = win->h - y;
	if (sx0 >= sx1 || sy0 >= sy1)
		return ;
	j = sy0;
	while (j < sy1)
	{
		src = img->px + (size_t)j * img->w;
		dst = win->fb + (size_t)(y + j) * win->w + x;
		if (!img->mask)
			memcpy(dst + sx0, src + sx0, (size_t)(sx1 - sx0) * 4);
		else
		{
			msk = img->mask + (size_t)j * img->w;
			i = sx0;
			while (i < sx1)
			{
				if (msk[i])
					dst[i] = src[i];
				i++;
			}
		}
		j++;
	}
	return ;
}

int	mlx_get_color_value(void *mlx_ptr, int color)
{
	(void)mlx_ptr;
	return (color);
}

/* ---------------------------------------------------------------- hooks */

int	mlx_hook(void *win_ptr, int x_event, int x_mask, int (*f)(), void *param)
{
	t_win	*win;

	(void)x_mask;
	win = win_ptr;
	if (!win || x_event < 0 || x_event >= 36)
		return (0);
	win->hooks[x_event].f = f;
	win->hooks[x_event].param = param;
	return (0);
}

int	mlx_key_hook(void *win_ptr, int (*f)(), void *param)
{
	return (mlx_hook(win_ptr, 3, 0, f, param));
}

int	mlx_mouse_hook(void *win_ptr, int (*f)(), void *param)
{
	return (mlx_hook(win_ptr, 4, 0, f, param));
}

int	mlx_expose_hook(void *win_ptr, int (*f)(), void *param)
{
	return (mlx_hook(win_ptr, 12, 0, f, param));
}

int	mlx_loop_hook(void *mlx_ptr, int (*f)(), void *param)
{
	t_mlx	*m;

	m = mlx_ptr;
	if (m)
	{
		m->loop_hook = f;
		m->loop_param = param;
	}
	return (0);
}

static void	dispatch(t_win *win, int *ev)
{
	t_hookslot	*h;
	int			type;

	type = ev[0];
	if (type == 6)
	{
		if (ev[3])
		{
			win->mx += ev[1];
			win->my += ev[2];
			win->mx = win->mx < 0 ? 0 : win->mx >= win->w ? win->w - 1 : win->mx;
			win->my = win->my < 0 ? 0 : win->my >= win->h ? win->h - 1 : win->my;
		}
		else
		{
			win->mx = ev[1];
			win->my = ev[2];
		}
	}
	if (type < 0 || type >= 36)
		return ;
	h = &win->hooks[type];
	if (!h->f)
		return ;
	if (type == 2 || type == 3)
		h->f(ev[1], h->param);
	else if (type == 4 || type == 5)
		h->f(ev[1], ev[2], ev[3], h->param);
	else if (type == 6)
		h->f(win->mx, win->my, h->param);
	else
		h->f(h->param);
}

static void	present(t_win *win)
{
	size_t		n;
	size_t		i;
	uint32_t	c;
	uint8_t		*o;

	replay_puts(win);
	n = (size_t)win->w * win->h;
	o = win->rgba;
	i = 0;
	while (i < n)
	{
		c = win->fb[i];
		o[0] = (c >> 16) & 0xFF;
		o[1] = (c >> 8) & 0xFF;
		o[2] = c & 0xFF;
		o[3] = 0xFF;
		o += 4;
		i++;
	}
	js_present(win->rgba, win->w, win->h);
}

int	mlx_loop(void *mlx_ptr)
{
	t_mlx	*m;
	int		ev[4];
	double	t0;
	double	last;
	double	now;
	double	credit;
	long	n;
	long	max_n;

	m = mlx_ptr;
	if (!m)
		return (1);
	m->running = 1;
	last = js_now();
	credit = 0;
	while (m->running)
	{
		if (m->win)
			while (js_poll(ev))
				dispatch(m->win, ev);
		now = js_now();
		t0 = now;
		if (m->loop_hook && m->running)
		{
			max_n = -1;
			if (g_iter_per_sec > 0)
			{
				credit += (now - last > 100 ? 100 : now - last)
					* g_iter_per_sec / 1000.0;
				max_n = (long)credit;
				credit -= max_n;
			}
			n = 0;
			while (m->running && (max_n < 0 || n < max_n))
			{
				m->loop_hook(m->loop_param);
				n++;
				if ((n & 63) == 0 && js_now() - t0 > g_budget_ms)
					break ;
				if (max_n < 0 && n >= 1 && js_now() - t0 > g_budget_ms)
					break ;
			}
		}
		last = now;
		if (m->win)
			present(m->win);
		js_yield();
	}
	return (0);
}

int	mlx_loop_end(void *mlx_ptr)
{
	t_mlx	*m;

	m = mlx_ptr;
	if (m)
		m->running = 0;
	return (1);
}

/* ---------------------------------------------------------------- misc */

int	mlx_string_put(void *mlx_ptr, void *win_ptr, int x, int y, int color,
		char *string)
{
	(void)mlx_ptr; (void)win_ptr; (void)x; (void)y; (void)color; (void)string;
	return (0);
}

void	mlx_set_font(void *mlx_ptr, void *win_ptr, char *name)
{
	(void)mlx_ptr; (void)win_ptr; (void)name;
}

int	mlx_destroy_window(void *mlx_ptr, void *win_ptr)
{
	t_mlx	*m;
	t_win	*win;

	m = mlx_ptr;
	win = win_ptr;
	if (!win)
		return (0);
	if (m && m->win == win)
		m->win = NULL;
	for (int k = 0; k < 8; k++)
		if (g_windows[k] == win)
			g_windows[k] = NULL;
	free(win->puts);
	free(win->fb);
	free(win->rgba);
	free(win);
	return (0);
}

int	mlx_destroy_image(void *mlx_ptr, void *img_ptr)
{
	t_img	*img;

	(void)mlx_ptr;
	img = img_ptr;
	if (!img)
		return (0);
	free(img->px);
	forget_image(img);
	free(img->mask);
	free(img);
	return (0);
}

int	mlx_destroy_display(void *mlx_ptr)
{
	(void)mlx_ptr;
	return (0);
}

int	mlx_do_key_autorepeatoff(void *mlx_ptr)
{
	(void)mlx_ptr;
	js_autorepeat(0);
	return (0);
}

int	mlx_do_key_autorepeaton(void *mlx_ptr)
{
	(void)mlx_ptr;
	js_autorepeat(1);
	return (0);
}

int	mlx_do_sync(void *mlx_ptr)
{
	(void)mlx_ptr;
	return (0);
}

int	mlx_mouse_get_pos(void *mlx_ptr, void *win_ptr, int *x, int *y)
{
	t_win	*win;

	(void)mlx_ptr;
	win = win_ptr;
	if (!win)
		return (0);
	if (x)
		*x = win->mx;
	if (y)
		*y = win->my;
	return (0);
}

int	mlx_mouse_move(void *mlx_ptr, void *win_ptr, int x, int y)
{
	t_win	*win;

	(void)mlx_ptr;
	win = win_ptr;
	if (win)
	{
		win->mx = x;
		win->my = y;
	}
	return (0);
}

int	mlx_mouse_hide(void *mlx_ptr, void *win_ptr)
{
	(void)mlx_ptr; (void)win_ptr;
	js_cursor(0);
	return (0);
}

int	mlx_mouse_show(void *mlx_ptr, void *win_ptr)
{
	(void)mlx_ptr; (void)win_ptr;
	js_cursor(1);
	return (0);
}

int	mlx_get_screen_size(void *mlx_ptr, int *sizex, int *sizey)
{
	(void)mlx_ptr;
	js_screen(sizex, sizey);
	return (0);
}

/* ---------------------------------------------------------------- XPM */

struct s_col_name	{ char *name; int color; };
extern struct s_col_name	mlx_col_name[];

static int	hexval(int c)
{
	if (c >= '0' && c <= '9')
		return (c - '0');
	c = tolower(c);
	if (c >= 'a' && c <= 'f')
		return (c - 'a' + 10);
	return (0);
}

/* Returns 0xRRGGBB, or -1 for transparent. */
static int	parse_color(const char *s, size_t len)
{
	char	buf[64];
	int		i;
	int		n;

	while (len && isspace((unsigned char)*s))
		s++, len--;
	while (len && isspace((unsigned char)s[len - 1]))
		len--;
	if (len && s[0] == '#')
	{
		s++;
		len--;
		if (len == 6)
			return (hexval(s[0]) << 20 | hexval(s[1]) << 16 | hexval(s[2]) << 12
				| hexval(s[3]) << 8 | hexval(s[4]) << 4 | hexval(s[5]));
		if (len == 3)
			return (hexval(s[0]) * 17 << 16 | hexval(s[1]) * 17 << 8
				| hexval(s[2]) * 17);
		if (len == 12)
			return (hexval(s[0]) << 20 | hexval(s[1]) << 16 | hexval(s[4]) << 12
				| hexval(s[5]) << 8 | hexval(s[8]) << 4 | hexval(s[9]));
		return (0);
	}
	n = len < sizeof(buf) - 1 ? (int)len : (int)sizeof(buf) - 1;
	for (i = 0; i < n; i++)
		buf[i] = tolower((unsigned char)s[i]);
	buf[n] = 0;
	for (i = 0; mlx_col_name[i].name; i++)
		if (!strcmp(mlx_col_name[i].name, buf))
			return (mlx_col_name[i].color);
	return (0);
}

/* Collect the C strings of an XPM file, in order. */
static char	**xpm_strings(char *text, int *count)
{
	char	**v;
	int		cap;
	int		n;
	char	*p;
	char	*start;

	cap = 1024;
	n = 0;
	v = malloc(sizeof(char *) * cap);
	p = text;
	while (v && *p)
	{
		if (p[0] == '/' && p[1] == '*')
		{
			p = strstr(p + 2, "*/");
			if (!p)
				break ;
			p += 2;
			continue ;
		}
		if (*p == '"')
		{
			start = ++p;
			while (*p && *p != '"')
				p++;
			if (!*p)
				break ;
			*p++ = 0;
			if (n == cap)
			{
				cap *= 2;
				v = realloc(v, sizeof(char *) * cap);
				if (!v)
					return (NULL);
			}
			v[n++] = start;
			continue ;
		}
		p++;
	}
	*count = n;
	return (v);
}

static void	*xpm_build(char **s, int count, int *width, int *height)
{
	int			w, h, nc, cpp, i, x, y, key, has_none;
	int			*table;
	char		(*keys)[8];
	int			*vals;
	t_img		*img;
	const char	*p;
	const char	*c;

	if (count < 1 || sscanf(s[0], "%d %d %d %d", &w, &h, &nc, &cpp) != 4
		|| w <= 0 || h <= 0 || nc <= 0 || cpp <= 0 || cpp > 7
		|| count < 1 + nc + h)
		return (NULL);
	table = NULL;
	keys = NULL;
	vals = malloc(sizeof(int) * nc);
	if (cpp <= 2)
	{
		table = malloc(sizeof(int) * 65536);
		if (table)
			for (i = 0; i < 65536; i++)
				table[i] = 0;
	}
	else
		keys = malloc(8 * nc);
	if (!vals || (!table && !keys))
		return (free(vals), free(table), free(keys), NULL);
	has_none = 0;
	for (i = 0; i < nc; i++)
	{
		p = s[1 + i];
		if ((int)strlen(p) < cpp)
			continue ;
		/* find the "c" visual key */
		c = p + cpp;
		vals[i] = 0;
		while (*c)
		{
			while (*c && isspace((unsigned char)*c))
				c++;
			if (c[0] == 'c' && isspace((unsigned char)c[1]))
			{
				const char	*e;

				c += 2;
				e = c;
				/* colour runs until next key ( m / s / g / g4 ) or end */
				while (*e && !(isspace((unsigned char)e[-1])
						&& (e[0] == 'm' || e[0] == 's' || e[0] == 'g')
						&& (isspace((unsigned char)e[1])
							|| (e[0] == 'g' && e[1] == '4'))))
					e++;
				vals[i] = parse_color(c, e - c);
				break ;
			}
			while (*c && !isspace((unsigned char)*c))
				c++;
		}
		if (vals[i] == -1)
			has_none = 1;
		if (table)
		{
			key = (unsigned char)p[0] | (cpp == 2 ? (unsigned char)p[1] << 8 : 0);
			table[key] = i;
		}
		else
			memcpy(keys[i], p, cpp);
	}
	img = mlx_new_image(NULL, w, h);
	if (img && has_none)
	{
		img->mask = malloc((size_t)w * h);
		if (!img->mask)
		{
			mlx_destroy_image(NULL, img);
			img = NULL;
		}
	}
	if (img)
	{
		for (y = 0; y < h; y++)
		{
			p = s[1 + nc + y];
			for (x = 0; x < w; x++, p += cpp)
			{
				int	idx;
				int	col;

				idx = 0;
				if ((int)strnlen(p, cpp) < cpp)
					break ;
				if (table)
					idx = table[(unsigned char)p[0]
						| (cpp == 2 ? (unsigned char)p[1] << 8 : 0)];
				else
				{
					for (idx = 0; idx < nc; idx++)
						if (!memcmp(keys[idx], p, cpp))
							break ;
					if (idx == nc)
						idx = 0;
				}
				col = vals[idx];
				if (col == -1)
				{
					img->px[y * w + x] = 0xFF000000;
					img->mask[y * w + x] = 0;
				}
				else
				{
					img->px[y * w + x] = (uint32_t)col & 0xFFFFFF;
					if (img->mask)
						img->mask[y * w + x] = 1;
				}
			}
		}
		if (width)
			*width = w;
		if (height)
			*height = h;
	}
	free(vals);
	free(table);
	free(keys);
	return (img);
}

/* MLXB: XPM pre-converted by pack.py — "MLXB" w h ncolors flags,
** palette (u32 0xRRGGBB, 0xFFFFFFFF = None), then u8/u16 indices. */
static void	*mlxb_build(const uint8_t *d, long size, int *width, int *height)
{
	uint32_t		hdr[4];
	const uint32_t	*pal;
	const uint8_t	*ix;
	t_img			*img;
	size_t			n;
	size_t			i;
	uint32_t		c;
	int				wide;

	memcpy(hdr, d + 4, 16);
	n = (size_t)hdr[0] * hdr[1];
	wide = hdr[2] > 256;
	if (hdr[0] == 0 || hdr[1] == 0 || hdr[2] == 0
		|| 20 + hdr[2] * 4 + n * (wide ? 2 : 1) > (size_t)size)
		return (NULL);
	pal = (const uint32_t *)(d + 20);
	ix = d + 20 + hdr[2] * 4;
	img = mlx_new_image(NULL, hdr[0], hdr[1]);
	if (!img)
		return (NULL);
	if (hdr[3] & 1)
	{
		img->mask = malloc(n);
		if (!img->mask)
			return (mlx_destroy_image(NULL, img), NULL);
	}
	for (i = 0; i < n; i++)
	{
		c = wide ? pal[ix[2 * i] | ix[2 * i + 1] << 8] : pal[ix[i]];
		if (c == 0xFFFFFFFF)
		{
			img->px[i] = 0xFF000000;
			img->mask[i] = 0;
		}
		else
		{
			img->px[i] = c;
			if (img->mask)
				img->mask[i] = 1;
		}
	}
	if (width)
		*width = hdr[0];
	if (height)
		*height = hdr[1];
	return (img);
}

void	*mlx_xpm_to_image(void *mlx_ptr, char **xpm_data, int *width, int *height)
{
	int	n;

	(void)mlx_ptr;
	if (!xpm_data)
		return (NULL);
	n = 0;
	while (xpm_data[n])
		n++;
	return (xpm_build(xpm_data, n, width, height));
}

void	*mlx_xpm_file_to_image(void *mlx_ptr, char *filename, int *width,
		int *height)
{
	FILE	*f;
	long	size;
	char	*text;
	char	**strs;
	int		count;
	void	*img;

	(void)mlx_ptr;
	f = fopen(filename, "rb");
	if (!f)
		return (NULL);
	fseek(f, 0, SEEK_END);
	size = ftell(f);
	fseek(f, 0, SEEK_SET);
	text = malloc(size + 1);
	if (!text || fread(text, 1, size, f) != (size_t)size)
		return (fclose(f), free(text), NULL);
	fclose(f);
	text[size] = 0;
	if (size >= 20 && !memcmp(text, "MLXB", 4))
	{
		img = mlxb_build((uint8_t *)text, size, width, height);
		free(text);
		return (img);
	}
	strs = xpm_strings(text, &count);
	img = strs ? xpm_build(strs, count, width, height) : NULL;
	free(strs);
	free(text);
	return (img);
}
