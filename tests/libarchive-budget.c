#include "../engine/libarchive/budget.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <pthread.h>

static void *foreign;
static void *thread_check(void *unused) {
    (void)unused;
    assert(archive_tar_budget_begin(4096));
    archive_tar_budget_free(foreign);
    assert(archive_tar_budget_failed());
    assert(archive_tar_budget_used() == 0);
    assert(archive_tar_budget_end());
    return NULL;
}
int main(void) {
    assert(archive_tar_budget_begin(4096));
    unsigned char *p = archive_tar_budget_calloc(16, 1);
    assert(p && (uintptr_t)p % _Alignof(max_align_t) == 0);
    for (size_t i = 0; i < 16; ++i) assert(p[i] == 0);
    p[0] = 71;
    size_t original = archive_tar_budget_used();
    assert(!archive_tar_budget_realloc(p, SIZE_MAX));
    assert(archive_tar_budget_used() == original && p[0] == 71);
    assert(!archive_tar_budget_calloc(SIZE_MAX, 2));
    assert(!archive_tar_budget_malloc(4096));
    p = archive_tar_budget_realloc(p, 128);
    assert(p && p[0] == 71);
    foreign = p;
    pthread_t thread;
    assert(!pthread_create(&thread, NULL, thread_check, NULL));
    assert(!pthread_join(thread, NULL));
    assert(p[0] == 71);
    archive_tar_budget_free(p);
    archive_tar_budget_free(p); /* Refuse stale pointers without dereference. */
    int stack = 0;
    archive_tar_budget_free(&stack);
    char *s = archive_tar_budget_strdup("payload");
    char *t = archive_tar_budget_strndup("payload", 3);
    assert(s && t && !strcmp(s, "payload") && !strcmp(t, "pay"));
    archive_tar_budget_free(s);
    archive_tar_budget_free(t);
    p = archive_tar_budget_malloc(0);
    assert(p && archive_tar_budget_used());
    assert(!archive_tar_budget_realloc(p, 0));
    assert(!archive_tar_budget_used());
    assert(archive_tar_budget_peak() <= 4096);
    assert(archive_tar_budget_failed());
    assert(archive_tar_budget_end());
    assert(archive_tar_budget_begin(64));
    assert(!archive_tar_budget_failed());
    p = archive_tar_budget_malloc(1);
    assert(p);
    assert(!archive_tar_budget_end());
    assert(!archive_tar_budget_begin(4096));
    archive_tar_budget_free(p);
    assert(archive_tar_budget_begin(64 * 1024 * 1024));
    static void *nodes[ARCHIVE_TAR_BUDGET_MAX_ALLOCATIONS];
    for (size_t i = 0; i < ARCHIVE_TAR_BUDGET_MAX_ALLOCATIONS; ++i) {
        nodes[i] = archive_tar_budget_malloc(0);
        assert(nodes[i]);
    }
    assert(!archive_tar_budget_malloc(0));
    nodes[0] = archive_tar_budget_realloc(nodes[0], 2);
    assert(nodes[0]); /* Reallocation replaces rather than adding a node. */
    assert(!archive_tar_budget_end());
    assert(!archive_tar_budget_begin(4096));
    for (size_t i = 0; i < ARCHIVE_TAR_BUDGET_MAX_ALLOCATIONS; ++i)
        archive_tar_budget_free(nodes[i]);
    assert(archive_tar_budget_begin(1));
    assert(!archive_tar_budget_malloc(0));
    assert(archive_tar_budget_end());
    assert(archive_tar_budget_failed());
    puts("allocation accounting, overflow, alignment, lifecycle and TLS ownership passed");
    return 0;
}
