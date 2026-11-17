/* TAR-only bridge: no host extraction and no external filters. */
#include <archive.h>
#include <archive_entry.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

typedef int64_t (*tar_read_fn)(void *, void *, size_t);
typedef int64_t (*tar_skip_fn)(void *, int64_t);
typedef int64_t (*tar_seek_fn)(void *, int64_t, int);
typedef int64_t (*tar_write_fn)(void *, const void *, size_t);
struct tar_reader { struct archive *archive; struct archive_entry *entry; void *context; tar_read_fn read; tar_skip_fn skip; tar_seek_fn seek; unsigned char buffer[65536]; };
static la_ssize_t read_callback(struct archive *a, void *opaque, const void **buffer) {
 struct tar_reader *r = opaque; int64_t n = r->read(r->context, r->buffer, sizeof(r->buffer));
 if (n < 0 || n > (int64_t)sizeof(r->buffer)) { archive_set_error(a, 0, "TAR input read failed"); return -1; }
 *buffer = r->buffer; return (la_ssize_t)n;
}
static la_int64_t skip_callback(struct archive *a, void *opaque, la_int64_t request) {
 struct tar_reader *r = opaque; int64_t n = r->skip(r->context, request);
 if (n < 0 || n > request) { archive_set_error(a, 0, "TAR input skip failed"); return -1; } return n;
}
static la_int64_t seek_callback(struct archive *a, void *opaque, la_int64_t offset, int whence) {
 struct tar_reader *r = opaque; int64_t n = r->seek(r->context, offset, whence);
 if (n < 0) archive_set_error(a, 0, "TAR input seek failed"); return n;
}
void *archive_tar_reader_new(void *context, tar_read_fn read, tar_skip_fn skip, tar_seek_fn seek) {
 struct tar_reader *r = calloc(1, sizeof(*r)); if (!r) return NULL;
 r->context = context; r->read = read; r->skip = skip; r->seek = seek;
 r->archive = archive_read_new(); if (!r->archive) { free(r); return NULL; }
 if (archive_read_support_filter_none(r->archive) != ARCHIVE_OK || archive_read_support_format_tar(r->archive) != ARCHIVE_OK || archive_read_set_format_option(r->archive, "tar", "mac-ext", NULL) != ARCHIVE_OK || archive_read_set_seek_callback(r->archive, seek_callback) != ARCHIVE_OK || archive_read_open2(r->archive, r, NULL, read_callback, skip_callback, NULL) != ARCHIVE_OK) { archive_read_free(r->archive); free(r); return NULL; }
 return r;
}
const char *archive_tar_reader_error(void *opaque) { struct tar_reader *r = opaque; const char *s = archive_error_string(r->archive); return s ? s : "TAR operation failed"; }
int archive_tar_reader_next(void *opaque) { struct tar_reader *r = opaque; int status = archive_read_next_header(r->archive, &r->entry); return status == ARCHIVE_OK ? 0 : status == ARCHIVE_EOF ? 1 : -1; }
int archive_tar_reader_block(void *opaque, const void **buffer, size_t *size, int64_t *offset) { struct tar_reader *r = opaque; la_int64_t where = 0; int status = archive_read_data_block(r->archive, buffer, size, &where); *offset = where; return status == ARCHIVE_OK ? 0 : status == ARCHIVE_EOF ? 1 : -1; }
const char *archive_tar_reader_text(void *opaque, int field) { struct archive_entry *e = ((struct tar_reader *)opaque)->entry; switch (field) { case 0: return archive_entry_pathname_utf8(e); case 1: return archive_entry_symlink_utf8(e); case 2: return archive_entry_hardlink_utf8(e); case 3: return archive_entry_uname_utf8(e); case 4: return archive_entry_gname_utf8(e); default: return NULL; } }
int64_t archive_tar_reader_number(void *opaque, int field) { struct archive_entry *e = ((struct tar_reader *)opaque)->entry; switch (field) { case 0: return archive_entry_size(e); case 1: return archive_entry_filetype(e); case 2: return archive_entry_perm(e); case 3: return archive_entry_uid(e); case 4: return archive_entry_gid(e); case 5: return archive_entry_mtime(e); case 6: return archive_entry_mtime_nsec(e); case 7: return archive_entry_mtime_is_set(e); case 8: return archive_entry_atime(e); case 9: return archive_entry_atime_nsec(e); case 10: return archive_entry_atime_is_set(e); case 11: return archive_entry_ctime(e); case 12: return archive_entry_ctime_nsec(e); case 13: return archive_entry_ctime_is_set(e); case 14: return archive_entry_birthtime(e); case 15: return archive_entry_birthtime_nsec(e); case 16: return archive_entry_birthtime_is_set(e); case 17: return archive_entry_sparse_count(e); case 18: return archive_entry_symlink(e) != NULL; case 19: return archive_entry_hardlink(e) != NULL; default: return -1; } }
int archive_tar_reader_sparse_reset(void *opaque) { return archive_entry_sparse_reset(((struct tar_reader *)opaque)->entry); }
int archive_tar_reader_sparse_next(void *opaque, int64_t *offset, int64_t *length) { la_int64_t o = 0, n = 0; int status = archive_entry_sparse_next(((struct tar_reader *)opaque)->entry, &o, &n); *offset = o; *length = n; return status == ARCHIVE_OK ? 0 : -1; }
int archive_tar_reader_free(void *opaque) { struct tar_reader *r = opaque; int status = archive_read_free(r->archive); free(r); return status == ARCHIVE_OK ? 0 : -1; }
struct tar_writer { struct archive *archive; void *context; tar_write_fn write; };
static la_ssize_t write_callback(struct archive *a, void *opaque, const void *buffer, size_t size) { struct tar_writer *w = opaque; if (size > 65536 || (size && !buffer)) { archive_set_error(a, 0, "Invalid TAR output chunk"); return -1; } int64_t n = w->write(w->context, buffer, size); if (n < 0 || (uint64_t)n != size) { archive_set_error(a, 0, "TAR output write failed"); return -1; } return (la_ssize_t)n; }
void *archive_tar_writer_new(void *context, tar_write_fn write) { struct tar_writer *w = calloc(1, sizeof(*w)); if (!w) return NULL; w->context = context; w->write = write; w->archive = archive_write_new(); if (!w->archive) { free(w); return NULL; } if (archive_write_set_format_pax(w->archive) != ARCHIVE_OK || archive_write_add_filter_none(w->archive) != ARCHIVE_OK || archive_write_set_bytes_per_block(w->archive, 65536) != ARCHIVE_OK || archive_write_set_bytes_in_last_block(w->archive, 1) != ARCHIVE_OK || archive_write_open(w->archive, w, NULL, write_callback, NULL) != ARCHIVE_OK) { archive_write_free(w->archive); free(w); return NULL; } return w; }
int archive_tar_writer_header(void *opaque, const char *name, int directory, int64_t size, int64_t seconds, long nanos) { struct tar_writer *w = opaque; struct archive_entry *e = archive_entry_new(); if (!e) return -1; archive_entry_set_pathname_utf8(e, name); archive_entry_set_filetype(e, directory ? AE_IFDIR : AE_IFREG); archive_entry_set_perm(e, directory ? 0755 : 0644); archive_entry_set_size(e, directory ? 0 : size); archive_entry_set_mtime(e, seconds, nanos); int status = archive_write_header(w->archive, e); archive_entry_free(e); return status == ARCHIVE_OK ? 0 : -1; }
int archive_tar_writer_data(void *opaque, const void *buffer, size_t size) { struct tar_writer *w = opaque; la_ssize_t n = archive_write_data(w->archive, buffer, size); return n >= 0 && (size_t)n == size ? 0 : -1; }
const char *archive_tar_writer_error(void *opaque) { struct tar_writer *w = opaque; const char *s = archive_error_string(w->archive); return s ? s : "TAR creation failed"; }
int archive_tar_writer_free(void *opaque, int commit) { struct tar_writer *w = opaque; int close_status = ARCHIVE_OK; if (commit) close_status = archive_write_close(w->archive); else archive_write_fail(w->archive); int free_status = archive_write_free(w->archive); free(w); return close_status == ARCHIVE_OK && free_status == ARCHIVE_OK ? 0 : -1; }
