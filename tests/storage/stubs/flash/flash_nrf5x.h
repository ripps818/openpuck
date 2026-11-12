#pragma once
#include <stdint.h>
#include <string.h>
extern int erases;
// the test's flash is a host array, so the address is a host pointer
inline bool flash_nrf5x_erase(uintptr_t addr)
{
	++erases;
	memset(reinterpret_cast<void *>(addr), 0xFF, 4096);
	return true;
}
