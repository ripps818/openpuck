#pragma once
#include <stddef.h>
#include <stdint.h>

// Why a settings filesystem image was judged unusable (0 = sound).
enum LfsCheckResult : uint8_t {
	LFS_CHECK_OK = 0,
	LFS_CHECK_NO_SUPERBLOCK,
	LFS_CHECK_BAD_DIR,
	LFS_CHECK_BAD_FILE,
};

// Walks a LittleFS v1 image read straight from flash, without the library, and reports whether the library could
// mount it and still walk it without following a bad block pointer. LittleFS v1 asserts (on the device: hangs)
// instead of returning an error on those, so this runs before anything opens a file.
LfsCheckResult lfsCheckImage(const uint8_t *image, uint32_t blockSize,
			     uint32_t blockCount);
