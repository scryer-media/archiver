#ifdef ARCHIVE_TAR_BUDGET_REMAP
#error "Compile budget.c without libarchive allocator remapping"
#endif
#include "budget.h"
#include <errno.h>
#include <stdint.h>

/* Fixed TLS registry storage is bounded independently of input. Looking up a
 * pointer before inspecting its header makes foreign and cross-thread frees
 * fail safely instead of reading memory before an arbitrary pointer. */
#define BUCKET_COUNT 4096u
#define MAX_BUCKET_CHAIN 128u

typedef union Allocation Allocation;
union Allocation {
    max_align_t alignment;
    struct {
        size_t charge;
        Allocation *next;
    } record;
};

typedef struct {
    int active;
    int failed;
    size_t limit;
    size_t used;
    size_t peak;
    size_t count;
    Allocation *buckets[BUCKET_COUNT];
} Budget;

static _Thread_local Budget budget;

static void fail(int reason) {
    budget.failed = 1;
    errno = reason;
}

static size_t bucket_index(const void *pointer) {
#ifdef ARCHIVE_TAR_BUDGET_TEST_HASH
    extern size_t archive_tar_budget_test_bucket(const void *);
    return archive_tar_budget_test_bucket(pointer) & (BUCKET_COUNT - 1u);
#else
    uintptr_t value = (uintptr_t)pointer >> 4;
    value ^= value >> 13;
    value *= (uintptr_t)0x9e3779b1u;
    value ^= value >> 17;
    return (size_t)(value & (BUCKET_COUNT - 1u));
#endif
}

static Allocation **find_allocation(const void *pointer) {
    Allocation **slot = &budget.buckets[bucket_index(pointer)];
    size_t visited = 0;
    while (*slot && (const void *)(*slot + 1) != pointer) {
        if (++visited >= MAX_BUCKET_CHAIN) {
            fail(EINVAL);
            return NULL;
        }
        slot = &(*slot)->record.next;
    }
    return slot;
}

/* A hard per-bucket bound makes even deliberately colliding pointer lookup
 * and adversarial free order bounded independently of the live-node limit. */
static int bucket_admits(size_t index, const Allocation *replacing) {
    size_t count = 0;
    for (Allocation *node = budget.buckets[index]; node; node = node->record.next) {
        if (node != replacing && ++count >= MAX_BUCKET_CHAIN) {
            fail(ENOMEM);
            return 0;
        }
    }
    return 1;
}

static int allocation_charge(size_t size, size_t *charge) {
    size_t payload = size ? size : 1;
    if (payload > SIZE_MAX - sizeof(Allocation)) {
        fail(ENOMEM);
        return 0;
    }
    *charge = sizeof(Allocation) + payload;
    return 1;
}

static int admit(size_t charge, size_t replacing) {
    if (!budget.active || replacing > budget.used) {
        fail(EINVAL);
        return 0;
    }
    size_t retained = budget.used - replacing;
    if (retained > budget.limit || charge > budget.limit - retained) {
        fail(ENOMEM);
        return 0;
    }
    return 1;
}

static void record_peak(void) {
    if (budget.used > budget.peak)
        budget.peak = budget.used;
}

int archive_tar_budget_begin(size_t limit) {
    if (budget.active || budget.used || budget.count) {
        fail(EBUSY);
        return 0;
    }
    for (size_t index = 0; index < BUCKET_COUNT; ++index) {
        if (budget.buckets[index]) {
            fail(EINVAL);
            return 0;
        }
    }
    budget.active = 1;
    budget.failed = 0;
    budget.limit = limit;
    budget.peak = 0;
    return 1;
}

size_t archive_tar_budget_used(void) { return budget.used; }
size_t archive_tar_budget_peak(void) { return budget.peak; }
int archive_tar_budget_failed(void) { return budget.failed; }

int archive_tar_budget_end(void) {
    if (!budget.active) {
        fail(EINVAL);
        return 0;
    }
    budget.active = 0;
    if (budget.used || budget.count) {
        fail(EBUSY);
        return 0;
    }
    return 1;
}

void *archive_tar_budget_malloc(size_t size) {
    if (budget.count >= ARCHIVE_TAR_BUDGET_MAX_ALLOCATIONS) {
        fail(ENOMEM);
        return NULL;
    }
    size_t charge;
    if (!allocation_charge(size, &charge) || !admit(charge, 0))
        return NULL;
    Allocation *allocation = malloc(charge);
    if (!allocation) {
        fail(ENOMEM);
        return NULL;
    }
    allocation->record.charge = charge;
    void *pointer = allocation + 1;
    size_t bucket = bucket_index(pointer);
    if (!bucket_admits(bucket, NULL)) {
        free(allocation);
        return NULL;
    }
    allocation->record.next = budget.buckets[bucket];
    budget.buckets[bucket] = allocation;
    budget.used += charge;
    ++budget.count;
    record_peak();
    return pointer;
}

void *archive_tar_budget_calloc(size_t count, size_t size) {
    if (size && count > SIZE_MAX / size) {
        fail(ENOMEM);
        return NULL;
    }
    size_t bytes = count * size;
    void *pointer = archive_tar_budget_malloc(bytes);
    if (pointer)
        memset(pointer, 0, bytes ? bytes : 1);
    return pointer;
}

void archive_tar_budget_free(void *pointer) {
    if (!pointer)
        return;
    Allocation **slot = find_allocation(pointer);
    Allocation *allocation = slot ? *slot : NULL;
    if (!allocation || !budget.count || allocation->record.charge > budget.used) {
        fail(EINVAL);
        return;
    }
    *slot = allocation->record.next;
    budget.used -= allocation->record.charge;
    --budget.count;
    free(allocation);
}

void *archive_tar_budget_realloc(void *pointer, size_t size) {
    if (!pointer)
        return archive_tar_budget_malloc(size);
    if (!size) {
        archive_tar_budget_free(pointer);
        return NULL;
    }
    Allocation **slot = find_allocation(pointer);
    Allocation *allocation = slot ? *slot : NULL;
    if (!allocation) {
        fail(EINVAL);
        return NULL;
    }
    size_t charge;
    size_t previous_charge = allocation->record.charge;
    /* Include temporary replacement storage in the byte ceiling. Failure
     * must preserve the old allocation, bytes and registry membership. */
    if (!allocation_charge(size, &charge) || !admit(charge, 0))
        return NULL;
    Allocation *resized = malloc(charge);
    if (!resized) {
        fail(ENOMEM);
        return NULL;
    }
    void *result = resized + 1;
    size_t bucket = bucket_index(result);
    if (!bucket_admits(bucket, allocation)) {
        free(resized);
        return NULL;
    }
    size_t previous_payload = previous_charge - sizeof(Allocation);
    memcpy(result, pointer, size < previous_payload ? size : previous_payload);
    budget.used += charge;
    record_peak();
    *slot = allocation->record.next;
    resized->record.next = budget.buckets[bucket];
    resized->record.charge = charge;
    budget.buckets[bucket] = resized;
    budget.used -= previous_charge;
    free(allocation);
    return result;
}

char *archive_tar_budget_strndup(const char *source, size_t maximum) {
    if (!source || !budget.active || budget.used > budget.limit) {
        fail(EINVAL);
        return NULL;
    }
    size_t remaining = budget.limit - budget.used;
    if (remaining <= sizeof(Allocation)) {
        fail(ENOMEM);
        return NULL;
    }
    /* Inspect at most the remaining admitted payload, even for strdup. */
    size_t available = remaining - sizeof(Allocation);
    size_t bound = maximum < available ? maximum : available;
    size_t length = 0;
    while (length < bound && source[length])
        ++length;
    if (length == available || length == SIZE_MAX) {
        fail(ENOMEM);
        return NULL;
    }
    char *copy = archive_tar_budget_malloc(length + 1);
    if (!copy)
        return NULL;
    memcpy(copy, source, length);
    copy[length] = '\0';
    return copy;
}

char *archive_tar_budget_strdup(const char *source) {
    return archive_tar_budget_strndup(source, SIZE_MAX);
}
