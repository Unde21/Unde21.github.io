/*
** mlx_threads.c — futex primitives for wasi-threads in a browser.
**
** wasi-libc implements every blocking pthread call (mutex, barrier, join,
** cond) on top of __wasilibc_futex_wait(), which uses the wasm
** `memory.atomic.wait32` instruction. Browsers forbid blocking on the main
** thread, where mlx_loop() runs, so this file replaces those two symbols:
** Web Workers block for real, the main thread spins instead.
*/

#include <stdint.h>
#include <errno.h>

__attribute__((import_module("mlxweb"), import_name("can_block")))
int		js_can_block(void);
__attribute__((import_module("mlxweb"), import_name("now")))
double	js_now(void);

static int	can_block(void)
{
	static _Thread_local int	cached = -1;

	if (cached < 0)
		cached = js_can_block();
	return (cached);
}

int	__wasilibc_futex_wait(volatile void *addr, int op, int val,
		int64_t max_wait_ns)
{
	volatile int	*p;
	double			deadline;
	int				ret;

	(void)op;
	if (((intptr_t)addr & 3) != 0)
		return (-EINVAL);
	p = addr;
	if (can_block())
	{
		ret = __builtin_wasm_memory_atomic_wait32((int *)addr, val,
				max_wait_ns);
		if (ret == 0)
			return (0);
		if (ret == 1)
			return (-EAGAIN);
		return (-ETIMEDOUT);
	}
	if (__atomic_load_n(p, __ATOMIC_SEQ_CST) != val)
		return (-EAGAIN);
	deadline = max_wait_ns < 0 ? -1 : js_now() + max_wait_ns / 1e6;
	while (__atomic_load_n(p, __ATOMIC_SEQ_CST) == val)
	{
		if (deadline >= 0 && js_now() >= deadline)
			return (-ETIMEDOUT);
	}
	return (0);
}

void	__wait(volatile int *addr, volatile int *waiters, int val, int priv)
{
	int	spins;

	(void)priv;
	spins = 100;
	while (spins-- && (!waiters || !*waiters))
	{
		if (*addr == val)
			__asm__ volatile ("" ::: "memory");
		else
			return ;
	}
	if (waiters)
		__atomic_fetch_add(waiters, 1, __ATOMIC_SEQ_CST);
	while (*addr == val)
		__wasilibc_futex_wait(addr, 0, val, -1);
	if (waiters)
		__atomic_fetch_sub(waiters, 1, __ATOMIC_SEQ_CST);
}
