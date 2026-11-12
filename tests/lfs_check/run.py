# lfsCheckImage against LittleFS v1 images made with the core's own littlefs 1.6 (128-byte blocks, 224 blocks):
# a healthy board after three boots of saves, the directory left by the rename that splits a full metadata block,
# the garbage entry the next boot writes on top of it, and an image whose first flash page was erased.
from pathlib import Path
import gzip, subprocess, tempfile

r = Path(__file__).resolve().parents[2]
here = Path(__file__).resolve().parent
cases = {'healthy': 0, 'split-rename': 2, 'garbage-entry': 3, 'no-superblock': 1}
test = '#include "lfs_check.h"\n#include <cstdio>\n#include <cstdlib>\n#include <vector>\n'
test += '''
static std::vector<uint8_t> load(const char *path)
{
	std::vector<uint8_t> v(224 * 128);
	FILE *f = fopen(path, "rb");
	if (!f || fread(v.data(), 1, v.size(), f) != v.size())
		exit(2);
	fclose(f);
	return v;
}
int main(int argc, char **argv)
{
	int bad = 0;
	for (int i = 1; i + 1 < argc; i += 2) {
		std::vector<uint8_t> v = load(argv[i]);
		int got = lfsCheckImage(v.data(), 128, 224), want = atoi(argv[i + 1]);
		if (got != want) {
			printf("%s: got %d, want %d\\n", argv[i], got, want);
			bad = 1;
		}
	}
	std::vector<uint8_t> blank(224 * 128, 0xFF);
	if (lfsCheckImage(blank.data(), 128, 224) != LFS_CHECK_NO_SUPERBLOCK)
		bad = 1;
	if (lfsCheckImage(nullptr, 128, 224) != LFS_CHECK_NO_SUPERBLOCK)
		bad = 1;
	return bad;
}
'''
with tempfile.TemporaryDirectory() as td:
    args = []
    for name, want in cases.items():
        p = Path(td) / (name + '.bin')
        p.write_bytes(gzip.decompress((here / (name + '.bin.gz')).read_bytes()))
        args += [str(p), str(want)]
    src = Path(td) / 'test.cpp'
    src.write_text(test)
    subprocess.run(['g++', '-std=c++11', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined',
                    '-I' + str(r / 'OpenPuck'), str(src), str(r / 'OpenPuck/lfs_check.cpp'), '-o', td + '/test'],
                   check=True)
    subprocess.run([td + '/test'] + args, check=True, env={'ASAN_OPTIONS': 'detect_leaks=0'})
print('LittleFS image check: healthy, split-rename, garbage-entry and erased-superblock images passed')
