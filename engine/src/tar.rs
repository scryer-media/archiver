//! Bounded TAR-only libarchive integration. Host unpack APIs are never used.
use super::{BoundedOutput, Request, Selection, create_output, err, links, member_output, safe};
use serde_json::{Value, json};
use std::{
    ffi::{CStr, CString, c_char, c_int, c_long, c_void},
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    ptr::NonNull,
};
unsafe extern "C" {
    fn archive_tar_budget_begin(limit: usize) -> c_int;
    fn archive_tar_budget_end() -> c_int;
    fn archive_tar_budget_failed() -> c_int;
    fn archive_tar_reader_new(
        context: *mut c_void,
        read: extern "C" fn(*mut c_void, *mut c_void, usize) -> i64,
        skip: extern "C" fn(*mut c_void, i64) -> i64,
        seek: extern "C" fn(*mut c_void, i64, c_int) -> i64,
    ) -> *mut c_void;
    fn archive_tar_reader_error(reader: *mut c_void) -> *const c_char;
    fn archive_tar_reader_next(reader: *mut c_void) -> c_int;
    fn archive_tar_reader_block(
        reader: *mut c_void,
        buffer: *mut *const c_void,
        size: *mut usize,
        offset: *mut i64,
    ) -> c_int;
    fn archive_tar_reader_text(reader: *mut c_void, field: c_int) -> *const c_char;
    fn archive_tar_reader_number(reader: *mut c_void, field: c_int) -> i64;
    fn archive_tar_reader_free(reader: *mut c_void) -> c_int;
    fn archive_tar_reader_sparse_reset(reader: *mut c_void) -> c_int;
    fn archive_tar_reader_sparse_next(
        reader: *mut c_void,
        offset: *mut i64,
        length: *mut i64,
    ) -> c_int;
    fn archive_tar_writer_new(
        context: *mut c_void,
        write: extern "C" fn(*mut c_void, *const c_void, usize) -> i64,
    ) -> *mut c_void;
    fn archive_tar_writer_header(
        writer: *mut c_void,
        name: *const c_char,
        directory: c_int,
        size: i64,
        seconds: i64,
        nanos: c_long,
    ) -> c_int;
    fn archive_tar_writer_data(writer: *mut c_void, buffer: *const c_void, size: usize) -> c_int;
    fn archive_tar_writer_error(writer: *mut c_void) -> *const c_char;
    fn archive_tar_writer_free(writer: *mut c_void, commit: c_int) -> c_int;
}
struct Budget {
    ended: bool,
}
impl Budget {
    fn new() -> Result<Self, String> {
        if unsafe { archive_tar_budget_begin(64 * 1024 * 1024) } != 1 {
            return Err("TAR metadata allocation budget is unavailable".into());
        }
        Ok(Self { ended: false })
    }
    fn finish(mut self) -> Result<(), String> {
        let failed = unsafe { archive_tar_budget_failed() } != 0;
        let drained = unsafe { archive_tar_budget_end() } == 1;
        self.ended = true;
        if failed || !drained {
            return Err("TAR allocation budget exceeded or cleanup incomplete".into());
        }
        Ok(())
    }
}
impl Drop for Budget {
    fn drop(&mut self) {
        if !self.ended {
            unsafe {
                archive_tar_budget_end();
            }
        }
    }
}
struct Source {
    file: File,
    size: u64,
}
extern "C" fn read(context: *mut c_void, buffer: *mut c_void, size: usize) -> i64 {
    if size == 0 {
        return 0;
    }
    if size > 65536 || buffer.is_null() {
        return -1;
    }
    let s = unsafe { &mut *context.cast::<Source>() };
    let bytes = unsafe { std::slice::from_raw_parts_mut(buffer.cast::<u8>(), size) };
    s.file
        .read(bytes)
        .ok()
        .and_then(|n| i64::try_from(n).ok())
        .unwrap_or(-1)
}
extern "C" fn seek(context: *mut c_void, offset: i64, whence: c_int) -> i64 {
    let s = unsafe { &mut *context.cast::<Source>() };
    let base = match whence {
        0 => 0,
        1 => match s.file.stream_position() {
            Ok(n) => i128::from(n),
            Err(_) => return -1,
        },
        2 => i128::from(s.size),
        _ => return -1,
    };
    let target = base + i128::from(offset);
    if target < 0 || target > i128::from(s.size) {
        return -1;
    }
    s.file
        .seek(SeekFrom::Start(target as u64))
        .ok()
        .and_then(|n| i64::try_from(n).ok())
        .unwrap_or(-1)
}
extern "C" fn skip(context: *mut c_void, amount: i64) -> i64 {
    let s = unsafe { &mut *context.cast::<Source>() };
    if amount < 0 {
        return -1;
    }
    let position = match s.file.stream_position() {
        Ok(n) => n,
        Err(_) => return -1,
    };
    let count = (amount as u64).min(s.size.saturating_sub(position));
    s.file
        .seek(SeekFrom::Start(position + count))
        .map(|_| count as i64)
        .unwrap_or(-1)
}
struct Reader {
    handle: NonNull<c_void>,
    _source: Box<Source>,
    headers: usize,
}
impl Reader {
    fn open(path: &str) -> Result<Self, String> {
        let file = File::open(path).map_err(err)?;
        let size = file.metadata().map_err(err)?.len();
        if size > i64::MAX as u64 {
            return Err("TAR input exceeds supported seek range".into());
        }
        let mut source = Box::new(Source { file, size });
        let handle = NonNull::new(unsafe {
            archive_tar_reader_new((&mut *source as *mut Source).cast(), read, skip, seek)
        })
        .ok_or("Invalid TAR header or TAR metadata budget exhausted")?;
        Ok(Self {
            handle,
            _source: source,
            headers: 0,
        })
    }
    fn error(&self) -> String {
        unsafe { CStr::from_ptr(archive_tar_reader_error(self.handle.as_ptr())) }
            .to_string_lossy()
            .into_owned()
    }
    fn next(&mut self) -> Result<bool, String> {
        loop {
            match unsafe { archive_tar_reader_next(self.handle.as_ptr()) } {
                0 => {}
                1 => return Ok(false),
                _ => return Err(self.error()),
            }
            if self.headers >= 250000 {
                return Err("TAR entry limit exceeded".into());
            }
            self.headers += 1;
            let name = self
                .text(0)?
                .ok_or("TAR path is missing or not valid UTF-8")?;
            let root = !name.is_empty()
                && !name.starts_with('/')
                && name.split('/').all(|part| part.is_empty() || part == ".");
            if root
                && self.number(1) == 0o040000
                && self.number(0) == 0
                && self.number(18) == 0
                && self.number(19) == 0
            {
                continue;
            }
            return Ok(true);
        }
    }
    fn number(&self, field: i32) -> i64 {
        unsafe { archive_tar_reader_number(self.handle.as_ptr(), field) }
    }
    fn text(&self, field: i32) -> Result<Option<String>, String> {
        let pointer = unsafe { archive_tar_reader_text(self.handle.as_ptr(), field) };
        if pointer.is_null() {
            return Ok(None);
        }
        unsafe { CStr::from_ptr(pointer) }
            .to_str()
            .map(|text| Some(text.to_owned()))
            .map_err(|_| "Invalid UTF-8 TAR metadata".into())
    }
    fn copy(&mut self, output: &mut impl Write, size: u64) -> Result<(), String> {
        let mut position = 0u64;
        let zero = [0u8; 65536];
        loop {
            let mut pointer = std::ptr::null();
            let mut count = 0usize;
            let mut offset = 0i64;
            match unsafe {
                archive_tar_reader_block(
                    self.handle.as_ptr(),
                    &mut pointer,
                    &mut count,
                    &mut offset,
                )
            } {
                1 => break,
                0 => {}
                _ => return Err(self.error()),
            }
            let offset = u64::try_from(offset).map_err(|_| "Negative TAR sparse offset")?;
            let end = offset
                .checked_add(count as u64)
                .ok_or("TAR sparse extent overflow")?;
            if offset < position || end > size || count > 0 && pointer.is_null() {
                return Err("Invalid TAR sparse extent".into());
            }
            while position < offset {
                let n = (offset - position).min(zero.len() as u64) as usize;
                output.write_all(&zero[..n]).map_err(err)?;
                position += n as u64
            }
            if count > 0 {
                let bytes = unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), count) };
                output.write_all(bytes).map_err(err)?
            }
            position = end;
        }
        while position < size {
            let n = (size - position).min(zero.len() as u64) as usize;
            output.write_all(&zero[..n]).map_err(err)?;
            position += n as u64
        }
        Ok(())
    }
}
impl Drop for Reader {
    fn drop(&mut self) {
        unsafe {
            archive_tar_reader_free(self.handle.as_ptr());
        }
    }
}
struct Entry {
    header_count: usize,
    member: links::Member,
    metadata: Value,
}
fn millis(seconds: i64, nanos: i64) -> Option<i64> {
    let value = i128::from(seconds) * 1000 + i128::from(nanos) / 1_000_000;
    (value.abs() <= 9_007_199_254_740_991).then_some(value as i64)
}
const RETAINED_METADATA_LIMIT: usize = 64 * 1024 * 1024;
fn retained_metadata(
    current: usize,
    text_and_entry: usize,
    extents: usize,
) -> Result<usize, String> {
    // A JSON extent owns a map allocation, keys and a vector slot. Charge
    // conservatively across native/wasm layouts before constructing objects.
    let retained = current
        .checked_add(text_and_entry)
        .and_then(|bytes| {
            extents
                .checked_mul(2048)
                .and_then(|extent_bytes| bytes.checked_add(extent_bytes))
        })
        .ok_or("TAR metadata budget overflow")?;
    if retained > RETAINED_METADATA_LIMIT {
        return Err("TAR retained metadata budget exceeded".into());
    }
    Ok(retained)
}
fn inventory(path: &str) -> Result<Vec<Entry>, String> {
    let mut reader = Reader::open(path)?;
    let mut entries = Vec::new();
    let mut budget = 0usize;
    let mut target_bytes = 0usize;
    let mut total_extents = 0usize;
    while reader.next()? {
        if entries.len() >= 250000 {
            return Err("TAR entry limit exceeded".into());
        }
        let name = reader
            .text(0)?
            .ok_or("TAR path is missing or not valid UTF-8")?;
        let name = safe(&name)?
            .strip_prefix("/out")
            .map_err(err)?
            .to_str()
            .ok_or("Invalid UTF-8 TAR path")?
            .to_owned();
        let kind = reader.number(1);
        let symbolic = reader.text(1)?;
        let hard = reader.text(2)?;
        if (reader.number(18) != 0 && symbolic.is_none())
            || (reader.number(19) != 0 && hard.is_none())
        {
            return Err("Invalid UTF-8 TAR link target".into());
        }
        let link = if let Some(target) = symbolic {
            Some((target, true))
        } else {
            hard.map(|target| (target, false))
        };
        if !matches!(kind, 0o100000 | 0o040000 | 0o120000) && link.is_none() {
            return Err("Unsupported special TAR member".into());
        }
        if kind == 0o120000 && link.is_none() {
            return Err("Missing or invalid UTF-8 TAR link target".into());
        }
        if let Some((target, _)) = &link {
            if target.len() > 16 * 1024 {
                return Err("TAR link target exceeds 16 KiB limit".into());
            }
            target_bytes = target_bytes
                .checked_add(target.len())
                .ok_or("TAR target budget overflow")?;
            if target_bytes > 4 * 1024 * 1024 {
                return Err("TAR cumulative link target budget exceeded".into());
            }
        }
        let size = u64::try_from(reader.number(0)).map_err(|_| "Invalid TAR member size")?;
        if size > 9_007_199_254_740_991 {
            return Err("TAR member size exceeds exact browser byte range".into());
        }
        let directory = kind == 0o040000;
        let owner = reader.text(3)?;
        let group = reader.text(4)?;
        let extents =
            usize::try_from(reader.number(17)).map_err(|_| "Invalid TAR sparse extent count")?;
        total_extents = total_extents
            .checked_add(extents)
            .ok_or("TAR sparse extent budget overflow")?;
        if extents > 65536 || total_extents > 262144 {
            return Err("TAR sparse extent budget exceeded".into());
        }
        budget = retained_metadata(
            budget,
            256 + name.len()
                + link.as_ref().map_or(0, |value| value.0.len())
                + owner.as_ref().map_or(0, String::len)
                + group.as_ref().map_or(0, String::len),
            extents,
        )?;
        let mut metadata = json!({"unixMode":reader.number(2)});
        for (key, field) in [("uid", 3), ("gid", 4)] {
            let value = reader.number(field);
            if i128::from(value).abs() <= 9_007_199_254_740_991 {
                metadata[key] = json!(value);
            }
        }
        if extents > 0 {
            if unsafe { archive_tar_reader_sparse_reset(reader.handle.as_ptr()) } != extents as i32
            {
                return Err("TAR sparse extent inventory mismatch".into());
            }
            let mut map = Vec::with_capacity(extents);
            let mut end = 0_u64;
            for _ in 0..extents {
                let mut offset = 0_i64;
                let mut length = 0_i64;
                if unsafe {
                    archive_tar_reader_sparse_next(reader.handle.as_ptr(), &mut offset, &mut length)
                } != 0
                {
                    return Err("TAR sparse extent inventory truncated".into());
                }
                let offset = u64::try_from(offset).map_err(|_| "Negative TAR sparse offset")?;
                let length = u64::try_from(length).map_err(|_| "Negative TAR sparse length")?;
                let next = offset
                    .checked_add(length)
                    .ok_or("TAR sparse extent overflow")?;
                if offset < end || next > size {
                    return Err("Invalid TAR sparse map".into());
                }
                end = next;
                if length > 0 {
                    map.push(json!({"offset":offset,"length":length}));
                }
            }
            metadata["sparse"] = json!({"logicalSize":size,"extents":map});
        }
        for (key, sec, nano, set) in [
            ("modifiedTime", 5, 6, 7),
            ("accessedTime", 8, 9, 10),
            ("changedTime", 11, 12, 13),
            ("createdTime", 14, 15, 16),
        ] {
            if reader.number(set) != 0
                && let Some(value) = millis(reader.number(sec), reader.number(nano))
            {
                metadata[key] = json!(value);
            }
        }
        if let Some(value) = owner {
            metadata["owner"] = json!(value)
        }
        if let Some(value) = group {
            metadata["group"] = json!(value)
        }
        if let Some((target, relative)) = &link {
            metadata["link"] = json!({"kind":if *relative{"symbolic"}else{"hard"},"target":target})
        }
        entries.push(Entry {
            header_count: reader.headers,
            member: links::Member {
                name,
                size,
                directory,
                link,
            },
            metadata,
        });
    }
    Ok(entries)
}
pub fn run(request: &Request) -> Result<Value, String> {
    let budget = Budget::new()?;
    let result = run_inner(request);
    let cleanup = budget.finish();
    match result {
        Err(error) => Err(error),
        Ok(value) => {
            cleanup?;
            Ok(value)
        }
    }
}
fn run_inner(request: &Request) -> Result<Value, String> {
    if !matches!(request.links.as_str(), "" | "reject" | "copy-safe") {
        return Err("Unknown TAR link policy".into());
    }
    if request.op == "create" {
        return create(request);
    }
    let path = request.paths.first().ok_or("No TAR input")?;
    let mut inventory = inventory(path)?;
    let members: Vec<_> = inventory.iter().map(|e| e.member.clone()).collect();
    let has_links = members.iter().any(|m| m.link.is_some());
    if has_links && request.links != "copy-safe" {
        return Err(
            "Archive links are rejected by default; enable safe file copies explicitly".into(),
        );
    }
    let output_limit = if request.op == "list" {
        u64::MAX
    } else {
        request.max_output
    };
    let copies = links::resolve(&members, output_limit)?;
    links::regular_quota(
        members
            .iter()
            .filter(|m| !m.directory && m.link.is_none())
            .map(|m| m.size),
        output_limit,
    )?;
    let copy_map: std::collections::HashMap<_, _> = copies.iter().copied().collect();
    let entries: Vec<_> = inventory.iter_mut().enumerate().map(|(index,entry)| {
        let size=copy_map.get(&index).map_or(entry.member.size,|source|members[*source].size);
        let mut result=json!({"name":entry.member.name,"size":size,"isDirectory":entry.member.directory,"isLink":entry.member.link.is_some()});
        result["metadata"]=std::mem::take(&mut entry.metadata);
        result
    }).collect();
    if request.op == "list" {
        return Ok(json!({"entries":entries}));
    }
    if request.op != "extract" {
        return Err("Unsupported TAR operation".into());
    }
    let mut prefix = 0_u64;
    let costs: Vec<_> = members
        .iter()
        .map(|member| {
            prefix = prefix.saturating_add(member.size);
            prefix
        })
        .collect();
    let plan = links::ReplayPlan::new(&members, &copies, &costs)?;
    let selection = Selection::new(
        request.only.as_deref(),
        members
            .iter()
            .map(|m| (m.name.as_str(), m.directory, m.link.is_some())),
    )?;
    let replay_headers = copies
        .iter()
        .filter(|(_, source)| !plan.cacheable.contains(source))
        .try_fold(0_u64, |sum, (_, source)| {
            sum.checked_add(inventory[*source].header_count as u64)
        })
        .ok_or("TAR link replay work overflow")?;
    if replay_headers > 1_000_000 {
        return Err("TAR link-copy metadata work budget exceeded".into());
    }

    let mut caches = std::collections::HashMap::new();
    let mut crcs = std::collections::HashMap::new();
    let mut reader = Reader::open(path)?;
    for (index, entry) in inventory.iter().enumerate() {
        if !reader.next()? {
            return Err("TAR member disappeared during extraction".into());
        }
        if entry.member.link.is_some() {
            continue;
        }
        let output = safe(&entry.member.name)?;
        if entry.member.directory {
            if selection.everything() {
                fs::create_dir_all(output).map_err(err)?;
            }
            continue;
        }
        let mut writer = BoundedOutput::new(
            member_output(&output, selection.wants(&entry.member.name))?,
            entry.member.size,
        );
        let cache = plan
            .cacheable
            .contains(&index)
            .then_some(entry.member.size as usize);
        let mut capture = links::CapturingWriter::new(&mut writer, cache);
        reader.copy(&mut capture, entry.member.size)?;
        let (crc, bytes) = capture.finish();
        if plan.sources.contains(&index) {
            crcs.insert(index, crc);
        }
        if let Some(bytes) = bytes {
            caches.insert(index, bytes);
        }
        if writer.written != entry.member.size {
            return Err("TAR output size mismatch".into());
        }
    }
    if reader.next()? {
        return Err("TAR member inventory changed during extraction".into());
    }
    drop(reader);
    for (index, source) in copies {
        if !selection.wants(&members[index].name) {
            continue;
        }
        let output = safe(&members[index].name)?;
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(err)?;
        }
        let mut writer = BoundedOutput::new(create_output(&output)?, members[source].size);
        if let Some(bytes) = caches.get(&source) {
            writer.write_all(bytes).map_err(err)?;
        } else {
            let mut reader = Reader::open(path)?;
            for _ in 0..=source {
                if !reader.next()? {
                    return Err("TAR replay member disappeared".into());
                }
            }
            let mut capture = links::CapturingWriter::new(&mut writer, None);
            reader.copy(&mut capture, members[source].size)?;
            let (crc, _) = capture.finish();
            if crcs.get(&source) != Some(&crc) {
                return Err("TAR replay differs from verified source".into());
            }
        }
        if writer.written != members[source].size {
            return Err("TAR copied output size mismatch".into());
        }
    }
    Ok(json!({"entries":entries}))
}
extern "C" fn write(context: *mut c_void, buffer: *const c_void, size: usize) -> i64 {
    if size == 0 {
        return 0;
    }
    if size > 65536 || buffer.is_null() {
        return -1;
    }
    let output = unsafe { &mut *context.cast::<BoundedOutput<File>>() };
    let bytes = unsafe { std::slice::from_raw_parts(buffer.cast::<u8>(), size) };
    output.write_all(bytes).map(|_| size as i64).unwrap_or(-1)
}
fn create(request: &Request) -> Result<Value, String> {
    if !request.password.is_empty() || !request.file_options.is_empty() {
        return Err("TAR does not support encryption or per-file compression".into());
    }
    let mut metadata_names = std::collections::HashSet::new();
    for metadata in &request.input_metadata {
        if !metadata_names.insert(metadata.name.as_str()) {
            return Err("Duplicate TAR input metadata path".into());
        }
        if metadata
            .modified_time
            .is_some_and(|time| i128::from(time).abs() > 9_007_199_254_740_991)
        {
            return Err("TAR input modification time exceeds exact browser range".into());
        }
        if !request
            .paths
            .iter()
            .any(|path| path.strip_prefix("/input/") == Some(metadata.name.as_str()))
            && !request.directories.contains(&metadata.name)
        {
            return Err("Unknown TAR input metadata path".into());
        }
    }
    let path = safe("archive.tar")?;
    let mut output = BoundedOutput::new(create_output(&path)?, request.max_output);
    let writer = NonNull::new(unsafe {
        archive_tar_writer_new((&mut output as *mut BoundedOutput<File>).cast(), write)
    })
    .ok_or("TAR writer initialization failed")?;
    let result = (|| {
        let mut names: Vec<_> = request
            .directories
            .iter()
            .map(|n| (n.as_str(), None))
            .collect();
        for name in &request.paths {
            names.push((
                name.strip_prefix("/input/")
                    .ok_or("Invalid TAR creation path")?,
                Some(name.as_str()),
            ))
        }
        let mut buffer = [0u8; 65536];
        for (name, path) in names {
            safe(name)?;
            let size = match path {
                Some(path) => File::open(path)
                    .and_then(|file| file.metadata())
                    .map_err(err)?
                    .len(),
                None => 0,
            };
            let size =
                i64::try_from(size).map_err(|_| "TAR file size exceeds signed 64-bit range")?;
            let modified = request
                .input_metadata
                .iter()
                .find(|entry| entry.name == name)
                .and_then(|entry| entry.modified_time)
                .unwrap_or(0);
            let seconds = modified.div_euclid(1000);
            let nanos = modified.rem_euclid(1000) * 1_000_000;
            let name = CString::new(name).map_err(err)?;
            if unsafe {
                archive_tar_writer_header(
                    writer.as_ptr(),
                    name.as_ptr(),
                    i32::from(path.is_none()),
                    size,
                    seconds,
                    nanos as c_long,
                )
            } != 0
            {
                return Err(
                    unsafe { CStr::from_ptr(archive_tar_writer_error(writer.as_ptr())) }
                        .to_string_lossy()
                        .into_owned(),
                );
            }
            if let Some(path) = path {
                let mut input = File::open(path).map_err(err)?;
                let mut remaining = size as u64;
                while remaining > 0 {
                    let count = input
                        .read(&mut buffer[..remaining.min(65536) as usize])
                        .map_err(err)?;
                    if count == 0 {
                        return Err("TAR input truncated during creation".into());
                    }
                    if unsafe {
                        archive_tar_writer_data(writer.as_ptr(), buffer.as_ptr().cast(), count)
                    } != 0
                    {
                        return Err("TAR output write failed".into());
                    }
                    remaining -= count as u64
                }
            }
        }
        Ok(json!({"message":"TAR archive created"}))
    })();
    let closed = unsafe { archive_tar_writer_free(writer.as_ptr(), i32::from(result.is_ok())) };
    if closed != 0 && result.is_ok() {
        return Err("TAR finalization failed".into());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    struct Temporary(std::path::PathBuf);
    impl Temporary {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "archive-tar-{}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            )))
        }
    }
    impl Drop for Temporary {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    #[test]
    fn dot_root_and_canonical_names_preserve_metadata_and_replay_indices() {
        for fixture in [
            include_bytes!("../../tests/fixtures/tar-dot-paths/bsdtar-pax.tar").as_slice(),
            include_bytes!("../../tests/fixtures/tar-dot-paths/python-gnu.tar").as_slice(),
        ] {
            let budget = Budget::new().unwrap();
            let path = Temporary::new();
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path.0)
                .unwrap()
                .write_all(fixture)
                .unwrap();
            let entries = inventory(path.0.to_str().unwrap()).unwrap();
            assert_eq!(entries.len(), 6);
            assert!(
                entries
                    .iter()
                    .all(|entry| !entry.member.name.starts_with("./")
                        && !entry.member.name.ends_with('/'))
            );
            let members: Vec<_> = entries.iter().map(|entry| entry.member.clone()).collect();
            let copies = links::resolve(&members, 1024).unwrap();
            assert_eq!(copies.len(), 2);
            let mut reader = Reader::open(path.0.to_str().unwrap()).unwrap();
            for entry in &entries {
                assert!(reader.next().unwrap());
                assert_eq!(reader.headers, entry.header_count);
                if entry.member.directory || entry.member.link.is_some() {
                    continue;
                }
                let mut output = Vec::new();
                reader.copy(&mut output, entry.member.size).unwrap();
                assert_eq!(
                    output,
                    if entry.member.name == "nested/beta.txt" {
                        b"nested oracle\n".as_slice()
                    } else {
                        b"dot root oracle\n".as_slice()
                    }
                );
                assert!(entry.metadata["modifiedTime"].as_i64().is_some());
            }
            assert!(!reader.next().unwrap());
            drop(reader);
            for (_, source) in copies {
                let mut reader = Reader::open(path.0.to_str().unwrap()).unwrap();
                for _ in 0..=source {
                    assert!(reader.next().unwrap());
                }
                let mut output = Vec::new();
                reader.copy(&mut output, members[source].size).unwrap();
                assert_eq!(output, b"dot root oracle\n");
            }
            budget.finish().unwrap();
        }
    }
    #[test]
    fn retained_sparse_metadata_is_admitted_before_json_allocation() {
        assert_eq!(
            retained_metadata(0, 0, 32768).unwrap(),
            RETAINED_METADATA_LIMIT
        );
        assert!(
            retained_metadata(0, 1, 32768)
                .unwrap_err()
                .contains("budget")
        );
        assert_eq!(
            retained_metadata(0, 256, 32767).unwrap(),
            RETAINED_METADATA_LIMIT - 1792
        );
        assert!(retained_metadata(usize::MAX, 1, 0).is_err());
        assert!(retained_metadata(0, 0, usize::MAX).is_err());
    }
    #[test]
    fn virtual_hundred_gibibyte_hole_is_bounded_and_stops_on_sink_cancel() {
        fn header(name: &str, size: usize, kind: u8) -> Vec<u8> {
            let mut bytes = vec![0; 512];
            bytes[..name.len()].copy_from_slice(name.as_bytes());
            bytes[100..108].copy_from_slice(b"0000644\0");
            bytes[108..116].copy_from_slice(b"0000000\0");
            bytes[116..124].copy_from_slice(b"0000000\0");
            bytes[124..136].copy_from_slice(format!("{size:011o}\0").as_bytes());
            bytes[136..148].copy_from_slice(b"00000000000\0");
            bytes[148..156].fill(32);
            bytes[156] = kind;
            bytes[257..263].copy_from_slice(b"ustar\0");
            bytes[263..265].copy_from_slice(b"00");
            let checksum: usize = bytes.iter().map(|byte| usize::from(*byte)).sum();
            bytes[148..156].copy_from_slice(format!("{checksum:06o}\0 ").as_bytes());
            bytes
        }
        fn record(key: &str, value: &str) -> String {
            let body = format!("{key}={value}\n");
            let mut length = body.len() + 2;
            loop {
                let next = length.to_string().len() + 1 + body.len();
                if next == length {
                    return format!("{length} {body}");
                }
                length = next
            }
        }
        let logical = 100_u64 * 1024 * 1024 * 1024;
        let body = record("GNU.sparse.size", &logical.to_string())
            + &record("GNU.sparse.map", &format!("{logical},0"));
        let mut bytes = header("PaxHeaders/hole", body.len(), b'x');
        bytes.extend_from_slice(body.as_bytes());
        bytes.resize(bytes.len().div_ceil(512) * 512, 0);
        bytes.extend(header("hole", 0, b'0'));
        bytes.extend([0; 1024]);
        let path = Temporary::new();
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path.0)
            .unwrap()
            .write_all(&bytes)
            .unwrap();
        struct Sink {
            bytes: usize,
        }
        impl Write for Sink {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if self.bytes >= 3 * 65536 {
                    return Err(std::io::Error::other("sink cancelled"));
                }
                assert!(bytes.len() <= 65536);
                assert!(bytes.iter().all(|byte| *byte == 0));
                self.bytes += bytes.len();
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let budget = Budget::new().unwrap();
        let mut reader = Reader::open(path.0.to_str().unwrap()).unwrap();
        assert!(reader.next().unwrap());
        assert_eq!(reader.number(0), logical as i64);
        let mut sink = Sink { bytes: 0 };
        assert!(
            reader
                .copy(&mut sink, logical)
                .unwrap_err()
                .contains("sink cancelled")
        );
        assert_eq!(sink.bytes, 3 * 65536);
        drop(reader);
        budget.finish().unwrap();
    }
    #[test]
    fn callbacks_preserve_offsets_above_four_gibibytes() {
        let path = Temporary::new();
        let mut file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path.0)
            .unwrap();
        let length = 5_u64 * 1024 * 1024 * 1024 + 17;
        file.set_len(length).unwrap();
        file.seek(SeekFrom::Start(length - 1)).unwrap();
        file.write_all(&[123]).unwrap();
        let mut source = Source { file, size: length };
        let context = (&mut source as *mut Source).cast();
        assert_eq!(seek(context, -1, 2), length as i64 - 1);
        let mut byte = 0u8;
        assert_eq!(read(context, (&mut byte as *mut u8).cast(), 1), 1);
        assert_eq!(byte, 123);
        assert_eq!(seek(context, 1, 2), -1);
        assert_eq!(seek(context, -1, 0), -1);
        assert_eq!(seek(context, 0, 0), 0);
        assert_eq!(skip(context, length as i64 + 1), length as i64);
    }
    #[test]
    fn failed_writer_does_not_pad_a_large_unwritten_member() {
        let budget = Budget::new().unwrap();
        let path = Temporary::new();
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path.0)
            .unwrap();
        let mut output = BoundedOutput::new(file, 1024 * 1024);
        let writer = unsafe {
            archive_tar_writer_new((&mut output as *mut BoundedOutput<File>).cast(), write)
        };
        assert!(!writer.is_null());
        let name = CString::new("large.bin").unwrap();
        assert_eq!(
            unsafe {
                archive_tar_writer_header(
                    writer,
                    name.as_ptr(),
                    0,
                    9_i64 * 1024 * 1024 * 1024,
                    0,
                    0,
                )
            },
            0
        );
        let _ = unsafe { archive_tar_writer_free(writer, 0) };
        assert!(output.written < 65536);
        drop(output);
        budget.finish().unwrap();
    }
    #[test]
    fn pax_writer_preserves_utf8_and_fractional_pre_epoch_times() {
        let budget = Budget::new().unwrap();
        let path = Temporary::new();
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path.0)
            .unwrap();
        let mut output = BoundedOutput::new(file, 1024 * 1024);
        let writer = unsafe {
            archive_tar_writer_new((&mut output as *mut BoundedOutput<File>).cast(), write)
        };
        assert!(!writer.is_null());
        let times: [i64; 8] = [
            -9_007_199_254_740_991,
            -1001,
            -250,
            -1,
            0,
            1,
            1250,
            9_007_199_254_740_991,
        ];
        for (index, time) in times.iter().enumerate() {
            let name = CString::new(format!("nested/résumé-{index}.txt")).unwrap();
            assert_eq!(
                unsafe {
                    archive_tar_writer_header(
                        writer,
                        name.as_ptr(),
                        0,
                        6,
                        time.div_euclid(1000),
                        (time.rem_euclid(1000) * 1_000_000) as c_long,
                    )
                },
                0,
                "{}",
                unsafe { CStr::from_ptr(archive_tar_writer_error(writer)) }.to_string_lossy()
            );
            assert_eq!(
                unsafe { archive_tar_writer_data(writer, b"oracle".as_ptr().cast(), 6) },
                0
            );
        }
        assert_eq!(unsafe { archive_tar_writer_free(writer, 1) }, 0);
        drop(output);
        let entries = inventory(path.0.to_str().unwrap()).unwrap();
        assert_eq!(entries.len(), times.len());
        let mut reader = Reader::open(path.0.to_str().unwrap()).unwrap();
        for (index, time) in times.iter().enumerate() {
            assert_eq!(
                entries[index].member.name,
                format!("nested/résumé-{index}.txt")
            );
            assert_eq!(entries[index].metadata["modifiedTime"], *time);
            assert!(reader.next().unwrap());
            let mut bytes = Vec::new();
            reader.copy(&mut bytes, 6).unwrap();
            assert_eq!(bytes, b"oracle");
        }
        assert!(!reader.next().unwrap());
        drop(reader);
        let independent = std::process::Command::new("python3")
            .arg("-c")
            .arg(
                r#"
import sys, tarfile, decimal
times = [-9007199254740991, -1001, -250, -1, 0, 1, 1250, 9007199254740991]
with tarfile.open(sys.argv[1]) as archive:
    entries = archive.getmembers()
    assert len(entries) == len(times)
    for index, (entry, expected) in enumerate(zip(entries, times)):
        assert entry.name == 'nested/résumé-' + str(index) + '.txt'
        actual = decimal.Decimal(entry.pax_headers.get('mtime', str(entry.mtime)))
        assert actual * 1000 == expected, (entry.pax_headers, expected)
        assert archive.extractfile(entry).read() == b'oracle'
"#,
            )
            .arg(&path.0)
            .output()
            .unwrap();
        assert!(
            independent.status.success(),
            "{}",
            String::from_utf8_lossy(&independent.stderr)
        );
        budget.finish().unwrap();
    }
}
