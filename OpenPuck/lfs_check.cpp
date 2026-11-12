#include "lfs_check.h"
#include <string.h>

// LittleFS v1 on-disk layout, as written by the Adafruit core's littlefs 1.6:
// a metadata block is [rev u32][size u32, bit 31 = the directory continues in tail][tail pair 2 x u32], its
// entries, then a CRC32 that makes the CRC over the first `size` bytes come out 0. Each entry is
// [type][entry len][attr len][name len] then those bytes. The superblock pair is blocks 0 and 1.
#define LFSC_TYPE_REG 0x11u
#define LFSC_TYPE_DIR 0x22u
#define LFSC_TYPE_SUPERBLOCK 0x2eu
#define LFSC_MAX_BLOCKS 1024u
#define LFSC_MAX_PENDING_DIRS 16u

static uint32_t rd32(const uint8_t *p)
{
	return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
	       ((uint32_t)p[3] << 24);
}

static uint32_t crc32Raw(const uint8_t *p, uint32_t n)
{
	uint32_t c = 0xFFFFFFFFu;
	for (uint32_t i = 0; i < n; i++) {
		c ^= p[i];
		for (int k = 0; k < 8; k++)
			c = (c >> 1) ^ ((c & 1u) ? 0xEDB88320u : 0u);
	}
	return c;
}

// Of a metadata pair, the block with a valid CRC and the newer revision, or -1.
static int32_t pickBlock(const uint8_t *image, uint32_t blockSize,
			 const uint32_t pair[2])
{
	int32_t best = -1;
	uint32_t bestRev = 0;
	for (int i = 0; i < 2; i++) {
		const uint8_t *b = image + (size_t)pair[i] * blockSize;
		const uint32_t rev = rd32(b), size = rd32(b + 4) & 0x7FFFFFFFu;
		if (size < 20u || size > blockSize || crc32Raw(b, size) != 0)
			continue;
		if (best < 0 || (int32_t)(rev - bestRev) > 0) {
			best = (int32_t)pair[i];
			bestRev = rev;
		}
	}
	return best;
}

LfsCheckResult lfsCheckImage(const uint8_t *image, uint32_t blockSize,
			     uint32_t blockCount)
{
	if (!image || blockSize < 32u || blockCount < 2u ||
	    blockCount > LFSC_MAX_BLOCKS)
		return LFS_CHECK_NO_SUPERBLOCK;
	uint32_t seen[LFSC_MAX_BLOCKS / 32u];
	memset(seen, 0, sizeof seen);
	uint32_t pending[LFSC_MAX_PENDING_DIRS][2];
	uint32_t pendingCount = 0;
	bool superblock = true;

	pending[pendingCount][0] = 0;
	pending[pendingCount][1] = 1;
	pendingCount++;
	while (pendingCount) {
		uint32_t pair[2] = { pending[pendingCount - 1][0],
				     pending[pendingCount - 1][1] };
		pendingCount--;
		for (;;) {
			if (pair[0] >= blockCount || pair[1] >= blockCount)
				return LFS_CHECK_BAD_DIR;
			// a pair visited twice is a loop the library would walk forever
			for (int i = 0; i < 2; i++) {
				const uint32_t bit = 1u << (pair[i] & 31u);
				if (seen[pair[i] >> 5] & bit)
					return LFS_CHECK_BAD_DIR;
				seen[pair[i] >> 5] |= bit;
			}
			const int32_t pick = pickBlock(image, blockSize, pair);
			if (pick < 0)
				return superblock ? LFS_CHECK_NO_SUPERBLOCK :
						    LFS_CHECK_BAD_DIR;
			const uint8_t *b = image + (size_t)pick * blockSize;
			const uint32_t sizeWord = rd32(b + 4);
			const uint32_t size = sizeWord & 0x7FFFFFFFu;
			const uint32_t end = size - 4u;
			uint32_t off = 16u;
			bool sawSuperblock = false;
			while (off + 4u <= end) {
				const uint8_t type = b[off], elen = b[off + 1],
					      alen = b[off + 2],
					      nlen = b[off + 3];
				const uint32_t next =
					off + 4u + elen + alen + nlen;
				if (next > end)
					return LFS_CHECK_BAD_DIR;
				const uint8_t *e = b + off + 4u;
				const uint8_t *name = e + elen + alen;
				switch (type & 0x7Fu) {
				case LFSC_TYPE_REG: {
					if (elen < 8u)
						return LFS_CHECK_BAD_FILE;
					const uint32_t head = rd32(e),
						       fsize = rd32(e + 4);
					if (fsize > blockCount * blockSize ||
					    (fsize && head >= blockCount))
						return LFS_CHECK_BAD_FILE;
					break;
				}
				case LFSC_TYPE_DIR:
					if (elen < 8u ||
					    pendingCount >=
						    LFSC_MAX_PENDING_DIRS)
						return LFS_CHECK_BAD_DIR;
					pending[pendingCount][0] = rd32(e);
					pending[pendingCount][1] = rd32(e + 4);
					pendingCount++;
					break;
				case LFSC_TYPE_SUPERBLOCK:
					if (!superblock || elen < 20u ||
					    nlen != 8u ||
					    memcmp(name, "littlefs", 8) != 0 ||
					    rd32(e + 8) != blockSize ||
					    rd32(e + 12) != blockCount ||
					    pendingCount >=
						    LFSC_MAX_PENDING_DIRS)
						return LFS_CHECK_NO_SUPERBLOCK;
					sawSuperblock = true;
					pending[pendingCount][0] = rd32(e);
					pending[pendingCount][1] = rd32(e + 4);
					pendingCount++;
					break;
				default:
					return LFS_CHECK_BAD_DIR;
				}
				off = next;
			}
			if (superblock && !sawSuperblock)
				return LFS_CHECK_NO_SUPERBLOCK;
			superblock = false;
			if (!(sizeWord & 0x80000000u))
				break;
			pair[0] = rd32(b + 8);
			pair[1] = rd32(b + 12);
		}
	}
	return LFS_CHECK_OK;
}
