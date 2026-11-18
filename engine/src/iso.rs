//! Disc images: ISO 9660 (with Joliet, Rock Ridge and zisofs) and UDF 1.02–2.01,
//! read in pure Rust through lamfold. Images open read-only; nothing is created.
use super::{BoundedOutput, Request, Selection, err, links, member_output, safe};
use lamfold::{BlockCache, BlockSource, FileKind, FoldError, FoldFrontend, NoVerifier, NodeId};
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
};

const MAX_ENTRIES: usize = 250_000;
const MAX_DEPTH: usize = 256;
const MAX_LINK_TARGET: usize = 16 * 1024;
const MAX_LINK_BYTES: usize = 4 * 1024 * 1024;
const CHUNK: usize = 1024 * 1024;
const CACHE_BYTES: usize = 4 * 1024 * 1024;

pub(crate) struct Source {
    file: File,
    size: u64,
    /// Image offset of a Rock Ridge `SP` signature hidden from the reader.
    hide_sp: Option<u64>,
}
impl Source {
    fn open(path: &str) -> Result<Self, String> {
        let file = File::open(path).map_err(err)?;
        let size = file.metadata().map_err(err)?.len();
        Ok(Self {
            file,
            size,
            hide_sp: None,
        })
    }
    fn bytes(&mut self, offset: u64, len: usize) -> Option<Vec<u8>> {
        let mut buf = vec![0; len];
        self.read_at(offset, &mut buf).ok()?;
        Some(buf)
    }
}
impl BlockSource for Source {
    fn len(&self) -> u64 {
        self.size
    }
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> lamfold::Result<()> {
        if offset.checked_add(buf.len() as u64).is_none_or(|end| end > self.size) {
            return Err(FoldError::Io("read past the end of the image"));
        }
        self.file
            .seek(SeekFrom::Start(offset))
            .map_err(|_| FoldError::Io("seek failed"))?;
        self.file
            .read_exact(buf)
            .map_err(|_| FoldError::Io("read failed"))?;
        if let Some(at) = self.hide_sp {
            for (index, byte) in buf.iter_mut().enumerate() {
                if (at..at + 2).contains(&(offset + index as u64)) {
                    *byte = b'-';
                }
            }
        }
        Ok(())
    }
}

/// lamfold always reads the Rock Ridge tree when one is present. hdiutil, and
/// some other authoring tools, write Rock Ridge with POSIX modes and times but
/// no `NM` name entries, so that tree has only 8.3 names while the Joliet tree
/// has the real ones. When the root directory shows no Rock Ridge names and a
/// Joliet tree exists, return where the root `SP` marker sits so it can be
/// hidden and lamfold reads Joliet instead, as other extractors do.
fn nameless_rock_ridge(source: &mut Source) -> Option<u64> {
    const SECTOR: u64 = 2048;
    let mut primary = None;
    let mut joliet = false;
    for index in 16..80 {
        let vd = source.bytes(index * SECTOR, SECTOR as usize)?;
        if &vd[1..6] != b"CD001" {
            return None;
        }
        match vd[0] {
            1 => primary = Some(vd),
            2 => joliet |= vd[88..90] == *b"%/" && matches!(vd[90], 0x40 | 0x43 | 0x45),
            255 => break,
            _ => {}
        }
    }
    let primary = primary.filter(|_| joliet)?;
    let block = u64::from(u16::from_le_bytes([primary[128], primary[129]]));
    let root = &primary[156..190];
    let lba = u64::from(u32::from_le_bytes(root[2..6].try_into().ok()?));
    let length = u32::from_le_bytes(root[10..14].try_into().ok()?).min(1 << 20) as usize;
    let start = lba.checked_mul(block)?;
    let extent = source.bytes(start, length)?;
    let first = extent.get(..usize::from(*extent.first()?))?;
    let dot = system_use(first)?;
    if dot.len() < 7 || &dot[..2] != b"SP" || dot[4..6] != [0xBE, 0xEF] {
        return None;
    }
    let sp = start + (first.len() - dot.len()) as u64;
    let skip = usize::from(dot[6]);
    let mut position = 0;
    while position < extent.len() {
        let len = usize::from(extent[position]);
        if len == 0 {
            position = (position / block as usize + 1) * block as usize;
            continue;
        }
        let record = extent.get(position..position + len)?;
        position += len;
        let id = record.get(33..33 + usize::from(*record.get(32)?))?;
        if matches!(id, [0] | [1]) {
            continue;
        }
        let mut entries = system_use(record)?.get(skip..).unwrap_or(&[]);
        while entries.len() >= 4 {
            if matches!(&entries[..2], b"NM" | b"CE") {
                return None;
            }
            let size = usize::from(entries[2]);
            if size < 4 {
                break;
            }
            entries = entries.get(size..).unwrap_or(&[]);
        }
    }
    Some(sp)
}
fn system_use(record: &[u8]) -> Option<&[u8]> {
    let id = usize::from(*record.get(32)?);
    record.get(33 + id + usize::from(id % 2 == 0)..)
}

struct Entry {
    member: links::Member,
    node: NodeId,
    mode: u32,
}

fn fold(error: FoldError) -> String {
    format!("Disc image is damaged or unsupported: {error}")
}

pub fn run(request: &Request) -> Result<Value, String> {
    if request.op == "create" {
        return Err("ISO images can be opened but not created".into());
    }
    if !matches!(request.op.as_str(), "list" | "extract") {
        return Err("Unsupported ISO operation".into());
    }
    let path = request.paths.first().ok_or("No ISO input")?;
    if request.paths.len() != 1 {
        return Err("Open one disc image at a time".into());
    }
    let mut source = Source::open(path)?;
    // A UDF bridge disc also carries an ISO 9660 tree, but on Windows install
    // media that tree is only a placeholder. Read UDF whenever it is present and
    // fail rather than fall back, so a disc is never extracted silently wrong.
    if lamfold_udf::Udf::<Source>::probe(&mut source).map_err(fold)? {
        return image::<lamfold_udf::Udf<Source>>(request, source).map_err(|error| {
            if error.starts_with("Disc image is damaged or unsupported") {
                format!("{error}. UDF 2.50 and later (Blu-ray) discs are not supported")
            } else {
                error
            }
        });
    }
    if lamfold_iso::Iso9660::<Source>::probe(&mut source).map_err(fold)? {
        source.hide_sp = nameless_rock_ridge(&mut source);
        return image::<lamfold_iso::Iso9660<Source>>(request, source);
    }
    Err("Not an ISO 9660 or UDF disc image".into())
}

fn image<F: FoldFrontend<Source>>(request: &Request, source: Source) -> Result<Value, String> {
    let mut cache = BlockCache::new(CACHE_BYTES);
    let mut cx = lamfold::SubstrateCtx {
        cache: &mut cache,
        verifier: &NoVerifier,
    };
    let mut volume = F::open(source, &mut cx).map_err(fold)?;
    let entries = inventory(&mut volume, &mut cx)?;
    let members: Vec<_> = entries.iter().map(|e| e.member.clone()).collect();
    links::validate_inventory(&members)?;
    let output_limit = if request.op == "list" {
        u64::MAX
    } else {
        request.max_output
    };
    links::regular_quota(
        members
            .iter()
            .filter(|m| !m.directory && m.link.is_none())
            .map(|m| m.size),
        output_limit,
    )?;
    let listed: Vec<_> = entries
        .iter()
        .map(|entry| {
            let mut metadata = json!({});
            if entry.mode != 0 {
                metadata["unixMode"] = json!(entry.mode);
            }
            if let Some((target, _)) = &entry.member.link {
                metadata["link"] = json!({"kind":"symbolic","target":target});
            }
            json!({
                "name": entry.member.name,
                "size": entry.member.size,
                "isDirectory": entry.member.directory,
                "isLink": entry.member.link.is_some(),
                "metadata": metadata,
            })
        })
        .collect();
    if request.op == "list" {
        return Ok(json!({"entries":listed}));
    }
    let selection = Selection::new(
        request.only.as_deref(),
        members
            .iter()
            .map(|m| (m.name.as_str(), m.directory, m.link.is_some())),
    )?;
    let mut buffer = vec![0_u8; CHUNK];
    for entry in &entries {
        let member = &entry.member;
        // Disc symlinks often point at directories; they are listed, not written.
        if member.link.is_some() {
            continue;
        }
        let output = safe(&member.name)?;
        if member.directory {
            if selection.everything() {
                fs::create_dir_all(output).map_err(err)?;
            }
            continue;
        }
        if !selection.wants(&member.name) {
            continue;
        }
        let mut writer = BoundedOutput::new(member_output(&output, true)?, member.size);
        copy(&mut volume, &mut cx, entry, &mut buffer, &mut writer)?;
        writer.flush().map_err(err)?;
        if writer.written != member.size {
            return Err("ISO output size mismatch".into());
        }
    }
    Ok(json!({"entries":listed}))
}

fn copy<F: FoldFrontend<Source>>(
    volume: &mut F,
    cx: &mut lamfold::SubstrateCtx<'_>,
    entry: &Entry,
    buffer: &mut [u8],
    writer: &mut impl Write,
) -> Result<(), String> {
    let size = entry.member.size;
    let mut offset = 0_u64;
    while offset < size {
        let want = (size - offset).min(buffer.len() as u64) as usize;
        let read = volume
            .read_at(entry.node, offset, &mut buffer[..want], cx)
            .map_err(fold)?;
        if read == 0 || read > want {
            return Err(format!("Disc image file is truncated: {}", entry.member.name));
        }
        writer.write_all(&buffer[..read]).map_err(err)?;
        offset += read as u64;
    }
    Ok(())
}

fn inventory<F: FoldFrontend<Source>>(
    volume: &mut F,
    cx: &mut lamfold::SubstrateCtx<'_>,
) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::new();
    let mut visited = std::collections::HashSet::new();
    let mut link_bytes = 0_usize;
    let root = volume.root();
    visited.insert(root);
    let mut stack = vec![(String::new(), root, 0_usize)];
    while let Some((prefix, directory, depth)) = stack.pop() {
        let mut children = volume.read_dir(directory, cx).map_err(fold)?;
        children.sort_by(|a, b| a.name.cmp(&b.name));
        let mut subdirectories = Vec::new();
        for child in children {
            if child.name.is_empty() || child.name == "." || child.name == ".." {
                continue;
            }
            if child.name.contains('/') || child.name.contains('\0') {
                return Err(format!("Unsafe disc image name: {}", child.name));
            }
            if entries.len() >= MAX_ENTRIES {
                return Err("Disc image entry limit exceeded".into());
            }
            let name = format!("{prefix}{}", child.name);
            safe(&name)?;
            let metadata = volume.metadata(child.node, cx).map_err(fold)?;
            let (size, directory, link) = match child.kind {
                FileKind::Directory => {
                    if depth + 1 > MAX_DEPTH {
                        return Err("Disc image directories are nested too deeply".into());
                    }
                    if !visited.insert(child.node) {
                        return Err("Disc image directory tree contains a loop".into());
                    }
                    subdirectories.push((format!("{name}/"), child.node, depth + 1));
                    (0, true, None)
                }
                FileKind::Symlink => {
                    let target = volume
                        .read_link(child.node, cx)
                        .map_err(fold)?
                        .ok_or_else(|| format!("Disc image link has no target: {name}"))?;
                    if target.len() > MAX_LINK_TARGET {
                        return Err("Disc image link target exceeds 16 KiB limit".into());
                    }
                    link_bytes += target.len();
                    if link_bytes > MAX_LINK_BYTES {
                        return Err("Disc image cumulative link target budget exceeded".into());
                    }
                    let target = String::from_utf8(target)
                        .map_err(|_| format!("Disc image link target is not UTF-8: {name}"))?;
                    (0, false, Some((target, true)))
                }
                FileKind::Regular => {
                    if metadata.size > 9_007_199_254_740_991 {
                        return Err("Disc image file exceeds exact browser byte range".into());
                    }
                    (metadata.size, false, None)
                }
                FileKind::Other => {
                    return Err(format!("Unsupported special file in disc image: {name}"));
                }
            };
            entries.push(Entry {
                member: links::Member {
                    name,
                    size,
                    directory,
                    link,
                },
                node: child.node,
                mode: metadata.mode,
            });
        }
        // Depth first, in name order.
        stack.extend(subdirectories.into_iter().rev());
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ISO9660: &[u8] = include_bytes!("../../tests/fixtures/iso/iso9660.iso.gz");
    const UDF: &[u8] = include_bytes!("../../tests/fixtures/iso/udf.iso.gz");

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new(label: &str, bytes: &[u8]) -> Self {
            let path = std::env::temp_dir().join(format!(
                "archive-engine-iso-{}-{label}.iso",
                std::process::id()
            ));
            fs::write(&path, bytes).unwrap();
            Self(path)
        }
        fn gzip(label: &str, gz: &[u8]) -> Self {
            let mut bytes = Vec::new();
            flate2::read::GzDecoder::new(gz).read_to_end(&mut bytes).unwrap();
            Self::new(label, &bytes)
        }
        fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    fn request(op: &str, path: &str) -> Request {
        serde_json::from_value(json!({"op":op,"format":"iso","paths":[path]})).unwrap()
    }
    fn contents<F: FoldFrontend<Source>>(path: &str) -> Vec<(String, Vec<u8>)> {
        let mut cache = BlockCache::new(CACHE_BYTES);
        let mut cx = lamfold::SubstrateCtx {
            cache: &mut cache,
            verifier: &NoVerifier,
        };
        let mut source = Source::open(path).unwrap();
        source.hide_sp = nameless_rock_ridge(&mut source);
        let mut volume = F::open(source, &mut cx).unwrap();
        let entries = inventory(&mut volume, &mut cx).unwrap();
        let mut buffer = vec![0; 7]; // odd chunk size exercises partial reads
        entries
            .iter()
            .filter(|entry| !entry.member.directory)
            .map(|entry| {
                let mut bytes = Vec::new();
                copy(&mut volume, &mut cx, entry, &mut buffer, &mut bytes).unwrap();
                (entry.member.name.clone(), bytes)
            })
            .collect()
    }
    fn expected() -> Vec<(String, Vec<u8>)> {
        vec![
            ("café-über-日本.txt".into(), b"unicode name\n".to_vec()),
            ("docs/deeper/notes.txt".into(), b"nested file\n".to_vec()),
            ("empty.bin".into(), Vec::new()),
            ("readme.txt".into(), b"Hello from a disc image.\n".to_vec()),
        ]
    }
    fn sorted(mut files: Vec<(String, Vec<u8>)>) -> Vec<(String, Vec<u8>)> {
        files.sort();
        files
    }

    #[test]
    fn lists_iso9660_joliet_and_udf_images_alike() {
        for (label, gz) in [("joliet", ISO9660), ("udf", UDF)] {
            let image = Fixture::gzip(label, gz);
            let listed = run(&request("list", image.path())).unwrap();
            let mut names: Vec<_> = listed["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| {
                    (
                        e["name"].as_str().unwrap().to_string(),
                        e["size"].as_u64().unwrap(),
                        e["isDirectory"].as_bool().unwrap(),
                    )
                })
                .collect();
            names.sort();
            assert_eq!(
                names,
                [
                    ("café-über-日本.txt".into(), 13, false),
                    ("docs".into(), 0, true),
                    ("docs/deeper".into(), 0, true),
                    ("docs/deeper/notes.txt".into(), 12, false),
                    ("empty.bin".into(), 0, false),
                    ("readme.txt".into(), 25, false),
                ],
                "{label}"
            );
        }
    }

    #[test]
    fn reads_file_bytes_through_both_frontends() {
        let joliet = Fixture::gzip("bytes-joliet", ISO9660);
        assert_eq!(
            sorted(contents::<lamfold_iso::Iso9660<Source>>(joliet.path())),
            expected()
        );
        let udf = Fixture::gzip("bytes-udf", UDF);
        assert_eq!(
            sorted(contents::<lamfold_udf::Udf<Source>>(udf.path())),
            expected()
        );
    }

    #[test]
    fn rejects_creation_other_files_and_damaged_images_without_panicking() {
        let image = Fixture::gzip("create", ISO9660);
        assert!(run(&request("create", image.path())).unwrap_err().contains("not created"));
        let text = Fixture::new("text", &[b'x'; 64 * 1024]);
        assert_eq!(
            run(&request("list", text.path())).unwrap_err(),
            "Not an ISO 9660 or UDF disc image"
        );
        for (label, gz) in [("damaged-joliet", ISO9660), ("damaged-udf", UDF)] {
            let mut bytes = Vec::new();
            flate2::read::GzDecoder::new(gz).read_to_end(&mut bytes).unwrap();
            // Truncate to just past the volume descriptors.
            let truncated = Fixture::new(&format!("{label}-short"), &bytes[..40 * 1024]);
            let _ = run(&request("list", truncated.path()));
            // Flip bytes across the metadata area; any outcome but a panic is fine.
            let mut state = 0x9e37_79b9_7f4a_7c15_u64;
            for round in 0..64 {
                let mut damaged = bytes.clone();
                for _ in 0..32 {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    let at = 16 * 2048 + (state as usize % (256 * 2048));
                    damaged[at] ^= (state >> 32) as u8 | 1;
                }
                let image = Fixture::new(&format!("{label}-{round}"), &damaged);
                let _ = run(&request("list", image.path()));
            }
        }
    }
}
