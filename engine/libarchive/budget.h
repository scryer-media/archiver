#ifndef ARCHIVE_TAR_BUDGET_H
#define ARCHIVE_TAR_BUDGET_H

#include <stddef.h>
#include <stdlib.h>
#include <string.h>

/* Independent bound on registry lookup and live metadata nodes. */
#define ARCHIVE_TAR_BUDGET_MAX_ALLOCATIONS 262144u

#ifdef __cplusplus
extern "C" {
#endif

/* Begin must precede every libarchive allocation; end follows reader cleanup.
 * A failed end retains live-allocation accounting and blocks another begin.
 * Check failed() even when end() reports that every allocation was freed. */
int archive_tar_budget_begin(size_t limit);
size_t archive_tar_budget_used(void);
size_t archive_tar_budget_peak(void);
int archive_tar_budget_failed(void);
int archive_tar_budget_end(void);

void *archive_tar_budget_malloc(size_t size);
void *archive_tar_budget_calloc(size_t count, size_t size);
void *archive_tar_budget_realloc(void *pointer, size_t size);
void archive_tar_budget_free(void *pointer);
char *archive_tar_budget_strdup(const char *source);
char *archive_tar_budget_strndup(const char *source, size_t maximum);

#ifdef __cplusplus
}
#endif

/* Define this only while compiling libarchive, never the allocator shim or
 * Rust/engine code. Function-like macros leave allocator attributes intact. */
#ifdef ARCHIVE_TAR_BUDGET_REMAP
#define malloc(size) archive_tar_budget_malloc(size)
#define calloc(count, size) archive_tar_budget_calloc(count, size)
#define realloc(pointer, size) archive_tar_budget_realloc(pointer, size)
#define free(pointer) archive_tar_budget_free(pointer)
#define strdup(source) archive_tar_budget_strdup(source)
#define strndup(source, maximum) archive_tar_budget_strndup(source, maximum)
#endif

#endif
