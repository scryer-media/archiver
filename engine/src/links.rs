//! Resolve opt-in link copies solely against regular members of the same archive.
use std::collections::HashMap;
use unicode_normalization::UnicodeNormalization;
#[derive(Clone)]
pub struct Member {
    pub name: String,
    pub size: u64,
    pub directory: bool,
    pub link: Option<(String, bool)>, // target, relative-to-parent (symbolic)
}
fn identity(name: &str) -> String {
    name.nfc()
        .flat_map(char::to_uppercase)
        .flat_map(char::to_lowercase)
        .nfc()
        .collect()
}
fn parts(name: &str) -> Result<Vec<String>, String> {
    super::safe(name)?;
    if name.starts_with('/') || name.contains(['\\', ':', '\0']) {
        return Err("Unsafe archive member path".into());
    }
    let parts: Vec<_> = name
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .map(str::to_owned)
        .collect();
    for part in &parts {
        let base = part
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let reserved = ["con", "prn", "aux", "nul"].contains(&base.as_str())
            || ((base.starts_with("com") || base.starts_with("lpt"))
                && base.len() == 4
                && matches!(base.as_bytes()[3], b'1'..=b'9'));
        if part.ends_with(['.', ' ']) || part.bytes().any(|byte| byte < 32) || reserved {
            return Err("Unsafe archive member path".into());
        }
    }
    Ok(parts)
}
fn target_name(member: &Member, target: &str, relative: bool) -> Result<String, String> {
    if target.is_empty() || target.starts_with('/') || target.contains(['\\', ':', '\0']) {
        return Err("Unsafe archive link target".into());
    }
    let mut path = if relative {
        let mut path = parts(&member.name)?;
        path.pop();
        path
    } else {
        Vec::new()
    };
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if path.pop().is_none() {
                    return Err("Archive link escapes its archive".into());
                }
            }
            part => path.push(part.to_string()),
        }
    }
    let name = path.join("/");
    super::safe(&name)?;
    Ok(identity(&name))
}
fn inventory_names(members: &[Member]) -> Result<HashMap<String, usize>, String> {
    let mut names = HashMap::new();
    for (index, member) in members.iter().enumerate() {
        let name = identity(&parts(&member.name)?.join("/"));
        if names.insert(name, index).is_some() {
            return Err("Archive contains canonical path aliases".into());
        }
    }
    for member in members {
        let mut path = parts(&member.name)?;
        path.pop();
        while !path.is_empty() {
            if let Some(index) = names.get(&identity(&path.join("/")))
                && (!members[*index].directory || members[*index].link.is_some())
            {
                return Err("Archive file is used as a directory".into());
            }
            path.pop();
        }
    }
    Ok(names)
}
pub fn validate_inventory(members: &[Member]) -> Result<(), String> {
    inventory_names(members).map(|_| ())
}
pub fn regular_quota(sizes: impl IntoIterator<Item = u64>, maximum: u64) -> Result<(), String> {
    let mut total = 0_u64;
    for size in sizes {
        total = total
            .checked_add(size)
            .ok_or("Archive regular member size overflow")?;
        if total > maximum {
            return Err("Archive regular members exceed output limit".into());
        }
    }
    Ok(())
}
#[derive(Debug)]
pub struct ReplayPlan {
    pub sources: std::collections::HashSet<usize>,
    pub cacheable: std::collections::HashSet<usize>,
}
impl ReplayPlan {
    pub fn new(
        members: &[Member],
        copies: &[(usize, usize)],
        prefix_costs: &[u64],
    ) -> Result<Self, String> {
        let sources: std::collections::HashSet<_> =
            copies.iter().map(|(_, source)| *source).collect();
        let mut cacheable = std::collections::HashSet::new();
        let mut cache_bytes = 0_u64;
        for (index, member) in members.iter().enumerate() {
            if sources.contains(&index)
                && member.size <= 65536
                && cache_bytes + member.size <= 4 * 1024 * 1024
            {
                cacheable.insert(index);
                cache_bytes += member.size;
            }
        }
        if !copies.is_empty() {
            let uncached = copies
                .iter()
                .filter(|(_, source)| !cacheable.contains(source))
                .count() as u64;
            let visits = (members.len() as u64)
                .checked_mul(uncached + 2)
                .ok_or("Link replay work overflow")?;
            if visits > 1_000_000 {
                return Err("Archive link-copy metadata work budget exceeded".into());
            }
            let total = members
                .iter()
                .try_fold(0_u64, |sum, member| sum.checked_add(member.size))
                .ok_or("Link replay size overflow")?;
            let replacements: HashMap<_, _> = copies.iter().copied().collect();
            let expanded = members
                .iter()
                .enumerate()
                .filter(|(_, member)| !member.directory)
                .try_fold(0_u64, |sum, (index, member)| {
                    sum.checked_add(
                        replacements
                            .get(&index)
                            .map_or(member.size, |source| members[*source].size),
                    )
                })
                .ok_or("Link output size overflow")?;
            let mut work = total.checked_mul(2).ok_or("Link replay work overflow")?;
            for (_, source) in copies {
                if !cacheable.contains(source) {
                    work = work
                        .checked_add(
                            *prefix_costs
                                .get(*source)
                                .ok_or("Missing link replay prefix")?,
                        )
                        .ok_or("Link replay work overflow")?;
                }
            }
            if work > expanded.saturating_mul(4).max(64 * 1024 * 1024) {
                return Err("Archive link-copy decode work budget exceeded".into());
            }
        }
        Ok(Self { sources, cacheable })
    }
}
pub struct CapturingWriter<W> {
    inner: W,
    crc: flate2::Crc,
    cache: Option<Vec<u8>>,
    cache_limit: usize,
}
impl<W> CapturingWriter<W> {
    pub fn new(inner: W, cache: Option<usize>) -> Self {
        Self {
            inner,
            crc: flate2::Crc::new(),
            cache: cache.map(|size| Vec::with_capacity(size.min(65536))),
            cache_limit: cache.unwrap_or(0).min(65536),
        }
    }
    pub fn finish(self) -> (u32, Option<Vec<u8>>) {
        (self.crc.sum(), self.cache)
    }
}
impl<W: std::io::Write> std::io::Write for CapturingWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.cache.as_ref().is_some_and(|cache| {
            cache
                .len()
                .checked_add(bytes.len())
                .is_none_or(|size| size > self.cache_limit)
        }) {
            return Err(std::io::Error::other("Link source cache limit exceeded"));
        }
        let written = self.inner.write(bytes)?;
        self.crc.update(&bytes[..written]);
        if let Some(cache) = &mut self.cache {
            cache.extend_from_slice(&bytes[..written]);
        }
        Ok(written)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}
/// Return each link's resolved regular source index, with no output filesystem access.
pub fn resolve(members: &[Member], max_output: u64) -> Result<Vec<(usize, usize)>, String> {
    let names = inventory_names(members)?;
    let mut resolved = Vec::new();
    let mut total = 0_u64;
    let mut memo = vec![None; members.len()];
    for (index, member) in members.iter().enumerate() {
        let source = if member.link.is_some() {
            let mut seen = std::collections::HashSet::new();
            let mut current = index;
            let mut chain = Vec::new();
            let source = loop {
                if let Some(source) = memo[current] {
                    break source;
                }
                if !seen.insert(current) {
                    return Err("Archive link cycle".into());
                }
                chain.push(current);
                let entry = &members[current];
                if entry.directory {
                    return Err("Archive directory links are not copied".into());
                }
                if let Some((target, relative)) = &entry.link {
                    current = *names
                        .get(&target_name(entry, target, *relative)?)
                        .ok_or("Archive link target is missing")?;
                } else {
                    break current;
                }
            };
            for item in chain {
                memo[item] = Some(source);
            }
            source
        } else {
            index
        };
        if member.link.is_some() {
            resolved.push((index, source));
        }
        if !member.directory {
            total = total
                .checked_add(members[source].size)
                .ok_or("Archive output size overflow")?;
        }
        if total > max_output {
            return Err("Archive link copies exceed output limit".into());
        }
    }
    Ok(resolved)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn file(name: &str) -> Member {
        Member {
            name: name.into(),
            size: 3,
            directory: false,
            link: None,
        }
    }
    fn link(name: &str, target: &str, relative: bool) -> Member {
        Member {
            link: Some((target.into(), relative)),
            ..file(name)
        }
    }
    #[test]
    fn forward_and_parent_relative_chains_resolve() {
        let members = [
            link("nested/sym", "../hard", true),
            link("hard", "data", false),
            file("data"),
        ];
        assert_eq!(resolve(&members, 9).unwrap(), vec![(0, 2), (1, 2)]);
        assert!(resolve(&members, 8).is_err());
    }
    #[test]
    fn unicode_names_and_targets_work_without_canonical_aliases() {
        assert_eq!(
            resolve(
                &[link("copie", "re\u{301}sume\u{301}", false), file("résumé")],
                6
            )
            .unwrap(),
            vec![(0, 1)]
        );
        assert!(resolve(&[file("É"), file("é/child")], 10).is_err());
        assert!(resolve(&[file("Σ"), file("ς")], 10).is_err());
        assert!(resolve(&[file("Σ"), file("ς/child")], 10).is_err());
        assert!(resolve(&[file("ß"), file("SS")], 10).is_err());
    }
    #[test]
    fn hostile_graphs_fail_before_output() {
        for members in [
            vec![link("a", "../outside", true)],
            vec![link("a", "b", false), link("b", "a", false)],
            vec![link("a", "missing", false)],
            vec![file("A"), file("a")],
            vec![file("é"), file("e\u{301}")],
            vec![file("a"), file("a/b")],
            vec![link("a", "/absolute", true)],
            vec![
                link("a", "dir", false),
                Member {
                    directory: true,
                    ..file("dir")
                },
            ],
        ] {
            assert!(resolve(&members, 100).is_err());
        }
    }
    #[test]
    fn real_rar_hardlink_resolves_to_crc_checked_regular_member() {
        let bytes = include_bytes!(
            "../../../rarpar/crates/unrar-rs/tests/fixtures/rar5/test_read_format_rar5_hardlink.rar"
        );
        let mut archive = unrar_rs::RarArchive::open(std::io::Cursor::new(bytes)).unwrap();
        let members = archive.metadata().members;
        let inventory: Vec<_> = members
            .iter()
            .map(|entry| Member {
                name: entry.name.clone(),
                size: entry.unpacked_size.unwrap(),
                directory: entry.is_directory,
                link: entry
                    .link_target
                    .as_ref()
                    .map(|target| (target.clone(), entry.is_symlink)),
            })
            .collect();
        let resolved = resolve(&inventory, 10).unwrap();
        assert_eq!(resolved, vec![(1, 0)]);
        let mut output = super::super::BoundedOutput::new(Vec::new(), 5);
        archive
            .by_index(resolved[0].1)
            .unwrap()
            .copy_to(&mut output)
            .unwrap();
        assert_eq!(output.inner, b"1234\n");
    }
    #[test]
    fn sevenz_link_payload_is_bounded_crc_checked_and_target_can_be_redecoded() {
        use std::io::Cursor;
        let mut writer = sevenz_turbo::ArchiveWriter::new(Cursor::new(Vec::new())).unwrap();
        writer.set_content_methods(vec![sevenz_turbo::EncoderConfiguration::new(
            sevenz_turbo::EncoderMethod::COPY,
        )]);
        let mut link = sevenz_turbo::ArchiveEntry::new_file("link");
        link.has_windows_attributes = true;
        link.windows_attributes = (0o120777 << 16) | 0x8000;
        super::super::metadata::set_modified(&mut link, -1).unwrap();
        writer
            .push_archive_entry(link, Some(Cursor::new(b"data")))
            .unwrap();
        let mut data = sevenz_turbo::ArchiveEntry::new_file("data");
        data.has_windows_attributes = true;
        data.windows_attributes = (0o100640 << 16) | 0x8000;
        super::super::metadata::set_modified(&mut data, 0).unwrap();
        writer
            .push_archive_entry(data, Some(Cursor::new(b"oracle")))
            .unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        if let Ok(directory) = std::env::var("ARCHIVE_NATIVE_FIXTURE_DIR") {
            let directory = std::path::Path::new(&directory);
            assert!(directory.is_dir());
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(directory.join("7z-link-metadata.7z"))
                .unwrap();
            std::io::Write::write_all(&mut file, &bytes).unwrap();
            let mut corrupt = bytes.clone();
            corrupt[32] ^= 1;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(directory.join("7z-link-bad-crc.7z"))
                .unwrap();
            std::io::Write::write_all(&mut file, &corrupt).unwrap();
        }
        let mut archive =
            sevenz_turbo::ArchiveReader::new(Cursor::new(bytes.clone()), "".into()).unwrap();
        let mut targets = Vec::new();
        archive
            .for_each_entries(|entry, reader| {
                if entry.is_symlink() {
                    let mut output = super::super::BoundedOutput::new(Vec::new(), 16 * 1024);
                    std::io::copy(reader, &mut output)?;
                    targets.push(String::from_utf8(output.inner).unwrap());
                }
                Ok(true)
            })
            .unwrap();
        assert_eq!(targets, vec!["data"]);
        for _ in 0..2 {
            let mut actual = Vec::new();
            archive
                .for_each_entries(|entry, reader| {
                    if entry.name() == "data" {
                        reader.read_to_end(&mut actual)?;
                    }
                    Ok(true)
                })
                .unwrap();
            assert_eq!(actual, b"oracle");
        }
        let mut corrupt = bytes;
        corrupt[32] ^= 1;
        let mut archive =
            sevenz_turbo::ArchiveReader::new(Cursor::new(corrupt), "".into()).unwrap();
        assert!(
            archive
                .for_each_entries(|entry, reader| {
                    if entry.is_symlink() {
                        let mut out = super::super::BoundedOutput::new(Vec::new(), 16 * 1024);
                        std::io::copy(reader, &mut out)?;
                    }
                    Ok(true)
                })
                .is_err()
        );
    }
    #[test]
    fn native_security_archives_have_real_link_headers() {
        use std::io::Cursor;
        let oversized = vec![b'a'; 16 * 1024 + 1];
        type Item<'a> = (&'a str, &'a [u8], u32);
        let alias_names: Vec<_> = (0..1025).map(|index| format!("alias-{index}")).collect();
        let uncached_data = vec![b'a'; 65537];
        let mut cases: Vec<(&str, Vec<Item<'_>>)> = vec![
            (
                "absolute",
                vec![
                    ("link", b"/outside", 0o120777),
                    ("data", b"oracle", 0o100644),
                ],
            ),
            (
                "escape",
                vec![
                    ("link", b"../data", 0o120777),
                    ("data", b"oracle", 0o100644),
                ],
            ),
            (
                "drive",
                vec![
                    ("link", b"C:/data", 0o120777),
                    ("data", b"oracle", 0o100644),
                ],
            ),
            (
                "unc",
                vec![
                    ("link", b"\\\\server/share", 0o120777),
                    ("data", b"oracle", 0o100644),
                ],
            ),
            (
                "backslash",
                vec![
                    ("link", b"a\\data", 0o120777),
                    ("data", b"oracle", 0o100644),
                ],
            ),
            (
                "nul",
                vec![("link", b"da\0ta", 0o120777), ("data", b"oracle", 0o100644)],
            ),
            ("cycle", vec![("a", b"b", 0o120777), ("b", b"a", 0o120777)]),
            (
                "missing",
                vec![
                    ("link", b"missing", 0o120777),
                    ("data", b"oracle", 0o100644),
                ],
            ),
            (
                "directory",
                vec![("link", b"dir", 0o120777), ("dir", b"", 0o040755)],
            ),
            (
                "special",
                vec![("link", b"device", 0o120777), ("device", b"", 0o020600)],
            ),
            (
                "case-ancestor",
                vec![
                    ("link", b"Parent", 0o120777),
                    ("Parent", b"oracle", 0o100644),
                    ("parent/child", b"x", 0o100644),
                ],
            ),
            (
                "nfc-alias",
                vec![
                    ("link", "é".as_bytes(), 0o120777),
                    ("é", b"oracle", 0o100644),
                    ("e\u{301}", b"x", 0o100644),
                ],
            ),
            (
                "sigma-alias",
                vec![
                    ("link", "Σ".as_bytes(), 0o120777),
                    ("Σ", b"oracle", 0o100644),
                    ("ς", b"x", 0o100644),
                ],
            ),
            (
                "sigma-ancestor",
                vec![
                    ("link", "Σ".as_bytes(), 0o120777),
                    ("Σ", b"oracle", 0o100644),
                    ("ς/child", b"x", 0o100644),
                ],
            ),
            (
                "oversized",
                vec![
                    ("link", &oversized, 0o120777),
                    ("data", b"oracle", 0o100644),
                ],
            ),
            (
                "forward-chain",
                vec![
                    ("first", b"second", 0o120777),
                    ("second", b"data", 0o120777),
                    ("data", b"oracle", 0o100644),
                ],
            ),
            (
                "unicode",
                vec![
                    ("copie", "re\u{301}sume\u{301}".as_bytes(), 0o120777),
                    ("résumé", b"oracle", 0o100644),
                ],
            ),
        ];
        let mut cached: Vec<Item<'_>> = alias_names[..1001]
            .iter()
            .map(|name| (name.as_str(), b"data".as_slice(), 0o120777))
            .collect();
        cached.push(("data", b"oracle", 0o100644));
        cases.push(("many-cached-aliases", cached));
        let mut uncached: Vec<Item<'_>> = alias_names
            .iter()
            .map(|name| (name.as_str(), b"data".as_slice(), 0o120777))
            .collect();
        uncached.push(("data", &uncached_data, 0o100644));
        cases.push(("many-uncached-budget", uncached));
        cases.push((
            "uncached-replay",
            vec![
                ("data", &uncached_data, 0o100644),
                ("link", b"data", 0o120777),
            ],
        ));
        for (name, items) in cases {
            let mut writer = sevenz_turbo::ArchiveWriter::new(Cursor::new(Vec::new())).unwrap();
            writer.set_content_methods(vec![sevenz_turbo::EncoderMethod::COPY.into()]);
            for (name, data, mode) in &items {
                let mut entry = if mode & 0o170000 == 0o040000 {
                    sevenz_turbo::ArchiveEntry::new_directory(name)
                } else {
                    sevenz_turbo::ArchiveEntry::new_file(name)
                };
                entry.has_windows_attributes = true;
                entry.windows_attributes = (mode << 16) | 0x8000;
                entry.size = data.len() as u64;
                writer
                    .push_archive_entry(
                        entry,
                        if mode & 0o170000 == 0o040000 {
                            None
                        } else {
                            Some(Cursor::new(*data))
                        },
                    )
                    .unwrap();
            }
            let bytes = writer.finish().unwrap().into_inner();
            let reader =
                sevenz_turbo::ArchiveReader::new(Cursor::new(bytes.clone()), "".into()).unwrap();
            assert_eq!(reader.archive().files.len(), items.len());
            assert!(
                reader
                    .archive()
                    .files
                    .iter()
                    .any(|entry| entry.is_symlink())
            );
            if let Ok(directory) = std::env::var("ARCHIVE_NATIVE_SECURITY_FIXTURE_DIR") {
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(std::path::Path::new(&directory).join(format!("{name}.7z")))
                    .unwrap();
                std::io::Write::write_all(&mut file, &bytes).unwrap();
            }
        }
    }
    #[test]
    fn replay_plan_caches_small_aliases_and_admits_large_files() {
        let mut members = vec![file("data")];
        let mut copies = Vec::new();
        for index in 0..2000 {
            members.push(link(&format!("alias-{index}"), "data", false));
            copies.push((members.len() - 1, 0));
        }
        let plan = ReplayPlan::new(&members, &copies, &vec![3; members.len()]).unwrap();
        assert!(plan.cacheable.contains(&0));
        let mut large = file("large");
        large.size = 100_000_000_000;
        let plan = ReplayPlan::new(
            &[large, link("copy", "large", false)],
            &[(1, 0)],
            &[100_000_000_000, 100_000_000_004],
        )
        .unwrap();
        assert!(!plan.cacheable.contains(&0));
    }
    #[test]
    fn replay_plan_refuses_uncached_quadratic_metadata_work() {
        let mut source = file("data");
        source.size = 65537;
        let mut members = vec![source];
        let mut copies = Vec::new();
        for index in 0..1025 {
            members.push(link(&format!("alias-{index}"), "data", false));
            copies.push((members.len() - 1, 0));
        }
        assert!(
            ReplayPlan::new(&members, &copies, &vec![65537; members.len()])
                .unwrap_err()
                .contains("metadata work")
        );
        assert!(regular_quota([u64::MAX, 1], u64::MAX).is_err());
    }
    #[test]
    fn source_capture_is_bounded_before_writing_and_hashes_exact_bytes() {
        let mut capture = CapturingWriter::new(Vec::new(), Some(6));
        std::io::Write::write_all(&mut capture, b"oracle").unwrap();
        let (crc, bytes) = capture.finish();
        let mut oracle = flate2::Crc::new();
        oracle.update(b"oracle");
        assert_eq!(crc, oracle.sum());
        assert_eq!(bytes.unwrap(), b"oracle");
        let mut capture = CapturingWriter::new(Vec::new(), Some(65536));
        assert!(std::io::Write::write_all(&mut capture, &vec![0; 65537]).is_err());
        assert!(capture.inner.is_empty());
    }
}
