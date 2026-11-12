#include "storage.h"
#include "fault_diag.h"
#include "lfs_check.h"
#include <Adafruit_LittleFS.h>
#include <InternalFileSystem.h>
#include <flash/flash_nrf5x.h>
#include <string.h>
using namespace Adafruit_LittleFS_Namespace;

uint8_t g_storageState;

#define STORAGE_FLASH_BASE 0xED000
#define STORAGE_FLASH_PAGE 4096UL
#define STORAGE_FLASH_PAGES 7UL
// the core's InternalFS geometry (InternalFileSystem.cpp)
#define STORAGE_LFS_BLOCK 128UL
#define STORAGE_LFS_BLOCKS \
	(STORAGE_FLASH_PAGES * STORAGE_FLASH_PAGE / STORAGE_LFS_BLOCK)

static bool storageFlashBlank()
{
	const volatile uint32_t *flash =
		reinterpret_cast<const volatile uint32_t *>(STORAGE_FLASH_BASE);
	for (size_t i = 0;
	     i < (STORAGE_FLASH_PAGES * STORAGE_FLASH_PAGE) / sizeof(uint32_t);
	     i++)
		if (flash[i] != 0xFFFFFFFF)
			return false;
	return true;
}

bool storageBegin()
{
	// The core's LittleFS v1 corrupts a directory when a rename has to add an entry to a full metadata block, and
	// on a corrupted image it asserts (on the board: hangs before USB comes up) instead of returning an error.
	// Boards that hit it before storageWriteFile() avoided it would hang on every boot, so an image the library
	// could not walk safely is erased here, before anything mounts it. Settings and pairings on it are lost.
	bool repaired = false;
	if (!storageFlashBlank()) {
		const LfsCheckResult r = lfsCheckImage(
			reinterpret_cast<const uint8_t *>(STORAGE_FLASH_BASE),
			STORAGE_LFS_BLOCK, STORAGE_LFS_BLOCKS);
		if (r != LFS_CHECK_OK) {
			uartPrintf(
				"[UART] settings filesystem corrupt (%u), erasing\r\n",
				(unsigned)r);
			for (uint32_t i = 0; i < STORAGE_FLASH_PAGES; i++)
				flash_nrf5x_erase(STORAGE_FLASH_BASE +
						  i * STORAGE_FLASH_PAGE);
			repaired = storageFlashBlank();
			if (!repaired) {
				g_storageState = 0;
				return false;
			}
		}
	}
	// InternalFileSystem::begin erases on any mount failure. Only blank
	// flash may be initialized automatically; failed mounts retain data.
	if (!repaired && InternalFS.Adafruit_LittleFS::begin()) {
		g_storageState = 1;
		return true;
	}
	if (!storageFlashBlank()) {
		g_storageState = 0;
		return false;
	}
	bool mounted = InternalFS.begin();
	g_storageState = mounted ? (repaired ? 4 : 2) : 0;
	return mounted;
}

bool storageWriteFile(const char *path, const char *temporary,
		      const uint8_t *data, size_t length)
{
	if (g_storageState == 0)
		return false;
	// A rename onto an existing file replaces its directory entry in place. Onto a missing one it adds an entry,
	// and adding one to a full metadata block is the case LittleFS v1 gets wrong (see storageBegin), so the
	// destination is created empty first. A save that fails after this leaves an empty file, which every loader
	// already treats as missing.
	{
		File existing(InternalFS);
		if (existing.open(path, FILE_O_READ))
			existing.close();
		else if (existing.open(path, FILE_O_WRITE))
			existing.close();
	}
	InternalFS.remove(temporary);
	File file(InternalFS);
	bool complete = file.open(temporary, FILE_O_WRITE);
	if (complete)
		complete = file.write(data, length) == length;
	file.close();
	if (complete) {
		complete = file.open(temporary, FILE_O_READ);
		if (complete)
			complete = file.size() == length;
		uint8_t check[32];
		size_t offset = 0;
		while (complete && offset < length) {
			size_t n = length - offset;
			if (n > sizeof check)
				n = sizeof check;
			complete = file.read(check, n) == (int)n &&
				   memcmp(check, data + offset, n) == 0;
			offset += n;
		}
		file.close();
	}
	// LittleFS rename atomically replaces the old file after verification.
	if (complete)
		complete = InternalFS.rename(temporary, path);
	if (!complete) {
		g_storageState = 3;
		return false;
	}
	g_storageState = 1;
	return true;
}
