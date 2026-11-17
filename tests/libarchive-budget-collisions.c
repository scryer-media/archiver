#include "../engine/libarchive/budget.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
static struct { const void *pointer; size_t bucket; } assigned[1024];
static size_t assigned_count, next_bucket;
size_t archive_tar_budget_test_bucket(const void *pointer) {
    for (size_t i = 0; i < assigned_count; ++i)
        if (assigned[i].pointer == pointer) return assigned[i].bucket;
    assert(assigned_count < 1024);
    assigned[assigned_count].pointer = pointer;
    assigned[assigned_count++].bucket = next_bucket;
    return next_bucket;
}
int main(void) {
    assert(archive_tar_budget_begin(1024 * 1024));
    next_bucket = 1;
    unsigned char *old = archive_tar_budget_malloc(16);
    assert(old); old[0] = 73; old[15] = 29;
    next_bucket = 0;
    void *nodes[128];
    for (size_t i = 0; i < 128; ++i) {
        nodes[i] = archive_tar_budget_malloc(0);
        assert(nodes[i]);
    }
    size_t used = archive_tar_budget_used();
    assert(!archive_tar_budget_malloc(1));
    assert(archive_tar_budget_used() == used);
    assert(!archive_tar_budget_realloc(old, 128));
    assert(old[0] == 73 && old[15] == 29);
    assert(archive_tar_budget_used() == used);
    int foreign = 0;
    archive_tar_budget_free(&foreign); /* Full collision chain, safe refusal. */
    assert(archive_tar_budget_used() == used);
    /* Oldest-first frees force the longest admitted lookup every time. */
    for (size_t i = 0; i < 128; ++i) archive_tar_budget_free(nodes[i]);
    old = archive_tar_budget_realloc(old, 128);
    assert(old && old[0] == 73 && old[15] == 29);
    archive_tar_budget_free(old);
    assert(!archive_tar_budget_used());
    assert(archive_tar_budget_failed());
    assert(archive_tar_budget_end());
    puts("forced collision ceiling, oldest-first frees and transactional realloc passed");
}
