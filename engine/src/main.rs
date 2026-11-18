mod codecs;
mod create;
mod embedded;
mod iso;
mod links;
mod metadata;
mod parity;
mod rar_verify;
mod streams;
mod tar;
mod volumes;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    ffi::{CStr, CString, c_char},
    fs::{self, File},
    io,
    path::{Component, Path},
};
#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct FileOptions {
    name: String,
    codec: Option<String>,
    filter: Option<String>,
    level: Option<u32>,
    #[serde(rename = "dictionarySize")]
    dictionary_size: Option<u32>,
    #[serde(rename = "deltaDistance")]
    delta_distance: Option<u32>,
}
#[derive(Deserialize, Clone)]
struct Request {
    op: String,
    #[serde(default)]
    format: String,
    #[serde(default, rename = "memoryLimit")]
    memory_limit: Option<usize>,
    #[serde(default)]
    protection: String,
    #[serde(default)]
    replacement: bool,
    #[serde(default)]
    codec: String,
    #[serde(default)]
    level: Option<u32>,
    #[serde(default, rename = "dictionarySize")]
    dictionary_size: Option<u32>,
    #[serde(default, rename = "fileOptions")]
    file_options: Vec<FileOptions>,
    #[serde(default, rename = "encryptHeaders")]
    encrypt_headers: Option<bool>,
    #[serde(default)]
    filter: String,
    #[serde(default, rename = "deltaDistance")]
    delta_distance: Option<u32>,
    #[serde(default, rename = "blockSize")]
    block_size: Option<u64>,
    #[serde(default, rename = "recoveryPercent")]
    recovery_percent: Option<u32>,
    #[serde(default, rename = "recoveryBlocks")]
    recovery_blocks: Option<u64>,
    #[serde(default, rename = "par3Codec")]
    par3_codec: String,
    #[serde(default, rename = "volumeScheme")]
    volume_scheme: String,
    #[serde(default, rename = "volumeCount")]
    volume_count: Option<u32>,
    #[serde(default, rename = "volumeBlocks")]
    volume_blocks: Option<u64>,
    #[serde(default, rename = "volumeBytes")]
    volume_bytes: Option<u64>,
    #[serde(default, rename = "firstRecovery")]
    first_recovery: Option<u64>,
    #[serde(default)]
    deduplication: String,
    #[serde(default, rename = "storeData")]
    store_data: bool,
    #[serde(default, rename = "par3Interleave")]
    par3_interleave: Option<u64>,
    #[serde(default, rename = "par3CapacityLog2")]
    par3_capacity_log2: Option<i8>,
    #[serde(default, rename = "inputMetadata")]
    input_metadata: Vec<metadata::InputMetadata>,
    #[serde(default)]
    links: String,
    paths: Vec<String>,
    #[serde(default)]
    directories: Vec<String>,
    #[serde(default)]
    password: String,
    #[serde(default)]
    solid: bool,
    #[serde(default = "default_limit", rename = "maxOutput")]
    max_output: u64,
    /// Extract only these entries, named exactly as `list` reports them.
    #[serde(default)]
    only: Option<Vec<String>>,
}
/// Which entries an extraction writes. Every entry is still read and checked;
/// unselected ones are decoded into a discard sink and never reach `/out`.
pub(crate) struct Selection(Option<std::collections::HashSet<String>>);
impl Selection {
    /// `entries` yields each archive entry as `(name, is_directory, is_link)`.
    fn new<'a>(
        only: Option<&[String]>,
        entries: impl IntoIterator<Item = (&'a str, bool, bool)>,
    ) -> Result<Self, String> {
        let Some(only) = only else {
            return Ok(Self(None));
        };
        let wanted: std::collections::HashSet<String> = only.iter().cloned().collect();
        let mut found = std::collections::HashSet::new();
        for (name, directory, link) in entries {
            if !wanted.contains(name) {
                continue;
            }
            if directory {
                return Err(format!("Selected entry is a directory: {name}"));
            }
            if link {
                return Err(format!(
                    "Selected entry is a link; links are not extracted selectively: {name}"
                ));
            }
            found.insert(name.to_string());
        }
        if let Some(missing) = only.iter().find(|name| !found.contains(*name)) {
            return Err(format!("Selected entry is not in the archive: {missing}"));
        }
        Ok(Self(Some(wanted)))
    }
    pub(crate) fn wants(&self, name: &str) -> bool {
        self.0.as_ref().is_none_or(|names| names.contains(name))
    }
    pub(crate) fn everything(&self) -> bool {
        self.0.is_none()
    }
}
/// Where one member's bytes go: its output file, or nowhere when unselected.
pub(crate) enum Output {
    File(File),
    Discard,
}
impl io::Write for Output {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        match self {
            Self::File(file) => file.write(bytes),
            Self::Discard => Ok(bytes.len()),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::File(file) => file.flush(),
            Self::Discard => Ok(()),
        }
    }
}
/// Create the member's output file when it is selected; otherwise a discard sink.
/// The parent directories are created only for a selected member.
pub(crate) fn member_output(path: &Path, selected: bool) -> Result<Output, String> {
    if !selected {
        return Ok(Output::Discard);
    }
    fs::create_dir_all(path.parent().ok_or("Invalid output path")?).map_err(err)?;
    create_output(path).map(Output::File)
}
impl Request {
    fn memory_budget(&self) -> Result<usize, String> {
        let bytes = self.memory_limit.unwrap_or(256 * 1024 * 1024);
        if !(32 * 1024 * 1024..=512 * 1024 * 1024).contains(&bytes) {
            return Err("Algorithm memory budget must be between 32 and 512 MiB".into());
        }
        Ok(bytes)
    }
}
fn default_limit() -> u64 {
    256 * 1024 * 1024
}
fn safe(name: &str) -> Result<std::path::PathBuf, String> {
    let p = Path::new(name);
    if name.contains(['\\', ':'])
        || p.is_absolute()
        || p.components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(format!("Unsafe archive path: {name}"));
    }
    let relative: std::path::PathBuf = p
        .components()
        .filter_map(|c| match c {
            Component::Normal(part) => Some(part),
            _ => None,
        })
        .collect();
    if relative.as_os_str().is_empty() {
        return Err("Archive paths must name a file or directory".into());
    }
    if relative
        .components()
        .next()
        .is_some_and(|part| part.as_os_str() == ".work")
    {
        return Err("The root .work path is reserved for operation scratch storage".into());
    }
    Ok(Path::new("/out").join(relative))
}
fn publication_names<'a>(names: impl IntoIterator<Item = &'a str>) -> Result<Vec<String>, String> {
    let mut published = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for name in names {
        let path = safe(name)?;
        let relative = path
            .strip_prefix("/out")
            .map_err(err)?
            .to_string_lossy()
            .into_owned();
        if !seen.insert(relative.clone()) {
            return Err("Duplicate verified publication path".into());
        }
        published.push(relative);
    }
    Ok(published)
}
fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}
fn create_output(path: &Path) -> Result<File, String> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(err)
}
struct BoundedOutput<W> {
    inner: W,
    written: u64,
    limit: u64,
}
impl<W> BoundedOutput<W> {
    fn new(inner: W, limit: u64) -> Self {
        Self {
            inner,
            written: 0,
            limit,
        }
    }
}
impl<W: io::Write> io::Write for BoundedOutput<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() as u64 > self.limit.saturating_sub(self.written) {
            return Err(io::Error::other(
                "Archive output exceeds its declared size or quota",
            ));
        }
        let size = self.inner.write(bytes)?;
        self.written += size as u64;
        Ok(size)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}
fn validate_request(r: &Request) -> Result<(), String> {
    if !matches!(
        r.op.as_str(),
        "list"
            | "extract"
            | "create"
            | "verify"
            | "repair"
            | "embed"
            | "verifyEmbedded"
            | "repairEmbedded"
            | "removeEmbedded"
            | "rebuildParity"
    ) {
        return Err(format!("Unsupported operation: {}", r.op));
    }
    if r.op == "create"
        && (r.format == "par3" || matches!(r.protection.as_str(), "par3" | "par3-embedded"))
    {
        return Err("PAR3 creation is not available; existing PAR3 sets can still be opened, verified and repaired".into());
    }
    if r.op == "create" && r.format == "iso" {
        return Err("ISO images can be opened but not created".into());
    }
    if r.op == "create"
        && !matches!(r.format.as_str(), "" | "7z" | "tar" | "par2")
        && streams::canonical(&r.format).is_none()
    {
        return Err(format!("Unsupported creation format: {}", r.format));
    }
    if !r.file_options.is_empty() && !(r.op == "create" && matches!(r.format.as_str(), "" | "7z")) {
        return Err("Per-file encoding options are supported only for archive creation".into());
    }
    if let Some(only) = &r.only {
        if r.op != "extract" {
            return Err("Selected entries apply only to extraction".into());
        }
        if only.is_empty() {
            return Err("Choose at least one entry to extract".into());
        }
    }
    if r.encrypt_headers == Some(true) && r.password.is_empty() {
        return Err("Header encryption requires an archive password".into());
    }
    let mut paths = std::collections::HashSet::new();
    for path in &r.paths {
        let relative = path
            .strip_prefix("/input/")
            .ok_or("Input must be mounted under /input")?;
        let normalized = safe(relative)?;
        if normalized == Path::new("/out") || !paths.insert(normalized) {
            return Err("Input paths must be nonempty and unique".into());
        }
    }
    let files = paths.clone();
    for directory in &r.directories {
        let path = safe(directory)?;
        if !paths.insert(path) {
            return Err("Input files and directories must have unique paths".into());
        }
    }
    if paths.iter().any(|path| {
        path.ancestors()
            .skip(1)
            .any(|parent| files.contains(parent))
    }) {
        return Err("An input file cannot also be a parent directory".into());
    }
    if !r.directories.is_empty()
        && !(r.op == "create" && matches!(r.format.as_str(), "" | "7z" | "tar"))
    {
        return Err("Directory entries are supported only for 7z and TAR creation".into());
    }
    Ok(())
}
fn run(r: Request) -> Result<Value, String> {
    validate_request(&r)?;
    let memory_budget = r.memory_budget()?;
    fs::create_dir_all("/out").map_err(err)?;
    if r.format == "tar" {
        return tar::run(&r);
    }
    if r.format == "iso" {
        return iso::run(&r);
    }
    let first = r
        .paths
        .first()
        .map(String::as_str)
        .or_else(|| (r.op == "create" && !r.directories.is_empty()).then_some(""))
        .ok_or("No input files or directories")?;
    if matches!(
        r.op.as_str(),
        "embed" | "verifyEmbedded" | "repairEmbedded" | "removeEmbedded" | "rebuildParity"
    ) {
        return embedded::run(&r);
    }
    if matches!(r.op.as_str(), "verify" | "repair")
        && !r.paths.iter().any(|p| {
            p.to_lowercase().ends_with(".par2")
                || p.to_lowercase().ends_with(".par3")
                || p.to_lowercase().ends_with(".rev")
        })
        && r.paths.iter().any(|p| {
            let p = p.to_lowercase();
            p.ends_with(".7z") || p.ends_with(".zip")
        })
    {
        return embedded::run(&r);
    }
    if matches!(r.op.as_str(), "create" | "list" | "extract")
        && let Some(format) = streams::detect(&r)?
    {
        return streams::run(&r, format);
    }
    if r.op == "create" && r.protection == "par3-embedded" {
        return Err("FFT embedded PAR3 creation is unavailable; use FFT sidecars".into());
    }
    if r.op == "create" && matches!(r.format.as_str(), "par2" | "par3") {
        return parity::create(&r);
    }
    if r.paths.iter().any(|p| p.to_lowercase().ends_with(".par3"))
        && matches!(r.op.as_str(), "list" | "verify" | "repair")
    {
        return parity::par3(&r);
    }
    if r.op == "create" {
        let plans = codecs::file_plans(&r)?;
        let header_methods = codecs::header_methods(&r)?;
        create::write(
            &r,
            &plans,
            header_methods,
            File::create("/out/archive.7z").map_err(err)?,
            |path| {
                Ok((
                    create::LazyFile::new(path),
                    fs::metadata(path).map_err(err)?.len(),
                ))
            },
        )?;
        if r.protection == "par3-embedded" {
            return Err("FFT embedded PAR3 creation is unavailable; use FFT sidecars".into());
        }
        if matches!(r.protection.as_str(), "par2" | "par3") {
            let mut protection = r.clone();
            protection.format = r.protection.clone();
            protection.password.clear();
            protection.paths = vec!["/out/archive.7z".into()];
            let mut result = parity::create_at(&protection, "/out")?;
            result["message"] = json!(format!(
                "7z archive created with {} protection",
                r.protection.to_uppercase()
            ));
            return Ok(result);
        }
        if !matches!(r.protection.as_str(), "" | "none") {
            return Err("Unsupported archive protection format".into());
        }
        return Ok(json!({"message":"7z archive created"}));
    }
    if matches!(r.op.as_str(), "repair" | "verify") {
        if !r.paths.iter().any(|p| p.to_lowercase().ends_with(".par2")) {
            if r.op == "verify" {
                return rar_verify::verify(&r);
            }
            if r.paths.iter().any(|p| p.to_lowercase().ends_with(".rev")) {
                if memory_budget < 64 * 1024 * 1024 {
                    return Err("REV recovery needs the crate's 64 MiB striped buffer; select at least 64 MiB of algorithm memory".into());
                }
                let options = unrar_rs::RecoveryOptions {
                    output_dir: Some("/out".into()),
                    ..Default::default()
                };
                let paths: Vec<_> = r.paths.iter().map(std::path::PathBuf::from).collect();
                let report = unrar_rs::restore_volumes_from_paths(&paths, &options).map_err(err)?;
                return Ok(
                    json!({"message":format!("Recovered {} RAR volumes",report.restored_paths.len())}),
                );
            }
            let mut count = 0;
            for path in &r.paths {
                let mut input = File::open(path).map_err(err)?;
                let assessment = unrar_rs::assess_recovery_record(
                    &mut input,
                    if r.password.is_empty() {
                        None
                    } else {
                        Some(&r.password)
                    },
                )
                .map_err(err)?
                .ok_or("No recovery record in this RAR volume")?;
                let patch_bytes = (assessment.damaged_units.len() as u64)
                    .saturating_mul(assessment.layout.unit_size);
                if patch_bytes > memory_budget as u64 / 2 {
                    return Err(format!(
                        "RAR recovery record needs up to {patch_bytes} bytes of retained patches; exceeds the selected algorithm memory budget"
                    ));
                }
                let repair = unrar_rs::repair_from_recovery_record(
                    &mut input,
                    if r.password.is_empty() {
                        None
                    } else {
                        Some(&r.password)
                    },
                )
                .map_err(err)?
                .ok_or("No recovery record in this RAR volume")?;
                let dest = safe(
                    Path::new(path)
                        .file_name()
                        .unwrap()
                        .to_str()
                        .ok_or("Invalid name")?,
                )?;
                fs::copy(path, &dest).map_err(err)?;
                let mut out = fs::OpenOptions::new().write(true).open(dest).map_err(err)?;
                repair.write_in_place(&mut out).map_err(err)?;
                count += repair.patches.len();
            }
            return Ok(
                json!({"message":format!("RAR recovery record: applied {count} repaired blocks")}),
            );
        }
        let par: Vec<_> = r
            .paths
            .iter()
            .filter(|p| p.to_lowercase().ends_with(".par2"))
            .map(std::path::PathBuf::from)
            .collect();
        if par.is_empty() {
            return Err("Select PAR2 volumes together with their damaged source files".into());
        }
        let base = if r.op == "repair" { "/out" } else { "/input" };
        let mut options = par2_rs::Par2RepairerOptions::new(base.into(), par);
        options.repair = r.op == "repair";
        options.memory_limit = Some(memory_budget);
        for path in &r.paths {
            if r.op == "repair" && !path.to_lowercase().ends_with(".par2") {
                let relative = path.strip_prefix("/input/").ok_or("Invalid input path")?;
                let destination = safe(relative)?;
                fs::create_dir_all(destination.parent().ok_or("Invalid output path")?)
                    .map_err(err)?;
                fs::copy(path, destination).map_err(err)?;
            }
        }
        let result = par2_rs::Par2Repairer::new(options)
            .verify_or_repair()
            .map_err(err)?;
        let complete = matches!(
            result.status,
            par2_rs::Par2RepairStatus::Verified | par2_rs::Par2RepairStatus::Repaired
        );
        if r.op == "repair" && !complete {
            return Err(format!(
                "PAR2 repair did not complete: {:?}; {} blocks missing, {} recovery blocks available",
                result.status, result.missing_blocks, result.recovery_blocks_available
            ));
        }
        // The repairer retains damaged private copies as numbered backups.
        // Only the protected canonical targets belong in the browser result.
        let publish_files = if r.op == "repair" {
            Some(publication_names(
                result
                    .verification
                    .files
                    .iter()
                    .map(|file| file.filename.as_str()),
            )?)
        } else {
            None
        };
        return Ok(
            json!({"message":format!("PAR2: {:?}",result.status),"status":format!("{:?}",result.status),"complete":complete,"missingBlocks":result.missing_blocks,"recoveryBlocksAvailable":result.recovery_blocks_available,"publishFiles":publish_files}),
        );
    }
    let mut magic = [0; 8];
    use std::io::Read;
    File::open(first)
        .map_err(err)?
        .read(&mut magic)
        .map_err(err)?;
    let mut entries = Vec::new();
    let mut total = 0u64;
    let mut seen = std::collections::HashSet::new();
    if magic.starts_with(b"Rar!") || magic.starts_with(b"MZ") {
        let file = File::open(first).map_err(err)?;
        let mut a = if r.password.is_empty() {
            unrar_rs::RarArchive::open(file)
        } else {
            unrar_rs::RarArchive::open_with_password(file, &r.password)
        }
        .map_err(err)?;
        for (i, path) in r.paths.iter().skip(1).enumerate() {
            a.add_volume(i + 1, Box::new(File::open(path).map_err(err)?))
                .map_err(err)?;
        }
        let mut limits = unrar_rs::Limits::default();
        limits.max_dict_size = memory_budget as u64;
        limits.max_ppmd_arena_size = memory_budget as u64;
        limits.max_unpacked_size = r.max_output;
        a.set_limits(limits);
        let indexed = a.indexed_member_infos();
        if r.op == "extract" && indexed.iter().any(|entry| !entry.extractable) {
            return Err("Archive has unresolved members or missing volumes".into());
        }
        let (member_indices, members): (Vec<_>, Vec<_>) = indexed
            .into_iter()
            .map(|entry| (entry.index, entry.info))
            .unzip();
        if !matches!(r.links.as_str(), "" | "reject" | "copy-safe") {
            return Err("Unknown link extraction policy".into());
        }
        let redirections: Vec<_> = member_indices
            .iter()
            .map(|index| {
                a.member_redirection(*index)
                    .map(|value| value.map(|value| (value.redir_type, value.target_is_directory)))
            })
            .collect::<Result<_, _>>()
            .map_err(err)?;
        if (r.op == "extract" || r.links == "copy-safe")
            && redirections.iter().flatten().any(|(kind, directory)| {
                *directory
                    || matches!(
                        kind,
                        unrar_rs::header::RedirectionType::WindowsJunction
                            | unrar_rs::header::RedirectionType::Unknown(_)
                    )
            })
        {
            return Err("Archive directory or unknown redirections are not materialized".into());
        }
        let copy_links = r.links == "copy-safe";
        if copy_links || r.op == "extract" {
            for entry in &members {
                safe(&entry.raw_name.replace('\\', "/"))?;
            }
        }
        if r.op == "extract"
            && !copy_links
            && members
                .iter()
                .any(|entry| entry.is_symlink || entry.is_hardlink || entry.is_file_copy)
        {
            return Err("Archive links are not extracted".into());
        }
        if r.op == "extract"
            && members.iter().any(|entry| {
                matches!(
                    entry.host_os,
                    unrar_rs::HostOs::Unix | unrar_rs::HostOs::Darwin
                ) && !matches!(
                    entry.attributes.unix_mode() & 0xf000,
                    0 | 0x4000 | 0x8000 | 0xa000
                )
            })
        {
            return Err("Archive special files are not extracted".into());
        }
        let unknown_redirection = members.iter().any(|entry| {
            !entry.is_symlink
                && !entry.is_hardlink
                && !entry.is_file_copy
                && (entry.link_target.is_some() || entry.link_target_bytes.is_some())
        });
        if (r.op == "extract" || copy_links) && unknown_redirection {
            return Err("Archive redirection type is unsupported".into());
        }
        if r.op == "extract" {
            links::regular_quota(
                members
                    .iter()
                    .filter(|entry| {
                        !entry.is_directory
                            && !entry.is_symlink
                            && !entry.is_hardlink
                            && !entry.is_file_copy
                    })
                    .map(|entry| entry.unpacked_size.unwrap_or(0)),
                r.max_output,
            )?;
        }
        if copy_links {
            let placeholder: Vec<_> = members
                .iter()
                .map(|entry| links::Member {
                    name: entry.name.clone(),
                    size: entry.unpacked_size.unwrap_or(0),
                    directory: entry.is_directory,
                    link: (entry.is_symlink || entry.is_hardlink || entry.is_file_copy)
                        .then(|| (String::new(), entry.is_symlink)),
                })
                .collect();
            links::validate_inventory(&placeholder)?;
        }
        if copy_links {
            let mut declared_targets = 0_u64;
            for entry in members
                .iter()
                .filter(|entry| entry.is_symlink || entry.is_hardlink || entry.is_file_copy)
            {
                let size = entry
                    .link_target_bytes
                    .as_ref()
                    .map(|target| target.len() as u64)
                    .or_else(|| entry.link_target.as_ref().map(|target| target.len() as u64))
                    .or(entry.unpacked_size)
                    .ok_or("Link target declares no bounded size")?;
                if size > 16 * 1024 {
                    return Err("Archive link target exceeds16KiB limit".into());
                }
                declared_targets = declared_targets
                    .checked_add(size)
                    .ok_or("Link target budget overflow")?;
                if declared_targets > 4 * 1024 * 1024 {
                    return Err("Archive link target budget exceeded".into());
                }
            }
        }
        let mut inventory = Vec::new();
        let mut target_bytes = 0_usize;
        for (index, entry) in members.iter().enumerate() {
            let is_link = entry.is_symlink || entry.is_hardlink || entry.is_file_copy;
            let link = if is_link && copy_links {
                let target = a
                    .read_link_target(member_indices[index], 16 * 1024)
                    .map_err(err)?;
                target_bytes = target_bytes
                    .checked_add(target.len())
                    .ok_or("Link target budget overflow")?;
                if target.len() > 16 * 1024 || target_bytes > 4 * 1024 * 1024 {
                    return Err("Archive link target budget exceeded".into());
                }
                Some((target, entry.is_symlink))
            } else {
                None
            };
            inventory.push(links::Member {
                name: entry.name.clone(),
                size: entry.unpacked_size.unwrap_or(0),
                directory: entry.is_directory,
                link,
            });
        }
        let resolved = if copy_links {
            links::resolve(
                &inventory,
                if r.op == "extract" {
                    r.max_output
                } else {
                    u64::MAX
                },
            )?
        } else {
            Vec::new()
        };
        if resolved
            .iter()
            .any(|(_, source)| members[*source].unpacked_size.is_none())
        {
            return Err("Link target has unknown output size".into());
        }
        let resolved_sizes: std::collections::HashMap<_, _> = resolved
            .iter()
            .map(|(link, source)| (*link, inventory[*source].size))
            .collect();
        let mut prefixes = Vec::with_capacity(inventory.len());
        let mut prefix = 0_u64;
        for entry in &inventory {
            prefix = prefix
                .checked_add(entry.size)
                .ok_or("Link prefix size overflow")?;
            prefixes.push(prefix);
        }
        let plan = links::ReplayPlan::new(&inventory, &resolved, &prefixes)?;
        let selection = Selection::new(
            r.only.as_deref(),
            members.iter().enumerate().map(|(i, e)| {
                (
                    e.name.as_str(),
                    e.is_directory,
                    redirections[i].is_some()
                        || e.is_symlink
                        || e.is_hardlink
                        || e.is_file_copy
                        || e.link_target.is_some()
                        || e.link_target_bytes.is_some(),
                )
            }),
        )?;
        let mut source_crcs = std::collections::HashMap::new();
        let mut cache = std::collections::HashMap::new();
        if r.op == "extract" && !resolved.is_empty() {
            a.reset_solid_state();
        }
        let mut actual_output = 0u64;
        for (i, e) in members.iter().enumerate() {
            let output_size = resolved_sizes
                .get(&i)
                .copied()
                .unwrap_or(e.unpacked_size.unwrap_or(0));
            total = total.saturating_add(output_size);
            if r.op == "extract"
                && (total > r.max_output || !seen.insert(safe(&e.raw_name.replace('\\', "/"))?))
            {
                return Err("Output exceeds limit or contains duplicate paths".into());
            }
            let mut description = metadata::rar(e);
            if let Some((kind, directory)) = redirections[i] {
                if directory || matches!(kind, unrar_rs::header::RedirectionType::WindowsJunction) {
                    description["link"]["targetIsDirectory"] = json!(true);
                }
                if matches!(kind, unrar_rs::header::RedirectionType::WindowsJunction) {
                    description["link"]["kind"] = json!("junction");
                }
            }
            if let Some((target, _)) = &inventory[i].link {
                description["link"]["target"] = json!(target);
            }
            entries.push(json!({"name":e.name,"size":output_size,"isDirectory":e.is_directory,"isLink":redirections[i].is_some()||e.is_symlink||e.is_hardlink||e.is_file_copy||e.link_target.is_some()||e.link_target_bytes.is_some(),"metadata":description}));
            if r.op == "extract" {
                let dest = safe(&e.name)?;
                if e.is_symlink || e.is_hardlink || e.is_file_copy {
                    continue;
                }
                if e.is_directory {
                    if selection.everything() {
                        fs::create_dir_all(dest).map_err(err)?;
                    }
                } else {
                    let mut output = BoundedOutput::new(
                        member_output(&dest, selection.wants(&e.name))?,
                        e.unpacked_size
                            .unwrap_or(r.max_output.saturating_sub(actual_output))
                            .min(r.max_output.saturating_sub(actual_output)),
                    );
                    if plan.sources.contains(&i) {
                        let mut capture = links::CapturingWriter::new(
                            &mut output,
                            plan.cacheable
                                .contains(&i)
                                .then_some(inventory[i].size as usize),
                        );
                        a.by_index(member_indices[i])
                            .and_then(|entry| entry.copy_to(&mut capture))
                            .map_err(err)?;
                        let (crc, bytes) = capture.finish();
                        source_crcs.insert(i, crc);
                        if let Some(bytes) = bytes {
                            cache.insert(i, bytes);
                        }
                    } else {
                        a.by_index(member_indices[i])
                            .and_then(|entry| entry.copy_to(&mut output))
                            .map_err(err)?;
                    }
                    actual_output = actual_output
                        .checked_add(output.written)
                        .ok_or("Output size overflow")?;
                    if e.unpacked_size.is_some_and(|size| size != output.written) {
                        return Err("RAR member output size differs from its header".into());
                    }
                }
            }
        }
        if r.op == "extract" {
            for (link, source) in resolved {
                if !selection.wants(&inventory[link].name) {
                    continue;
                }
                let dest = safe(&inventory[link].name)?;
                fs::create_dir_all(dest.parent().ok_or("Invalid link output path")?)
                    .map_err(err)?;
                let mut output = BoundedOutput::new(
                    create_output(&dest)?,
                    inventory[source]
                        .size
                        .min(r.max_output.saturating_sub(actual_output)),
                );
                if let Some(bytes) = cache.get(&source) {
                    io::Write::write_all(&mut output, bytes).map_err(err)?;
                } else {
                    a.reset_solid_state();
                    let mut capture = links::CapturingWriter::new(&mut output, None);
                    a.by_index(member_indices[source])
                        .and_then(|member| member.copy_to(&mut capture))
                        .map_err(err)?;
                    if source_crcs.get(&source) != Some(&capture.finish().0) {
                        return Err("Link replay bytes differ from verified source".into());
                    }
                }
                if output.written != inventory[source].size {
                    return Err("Link copy output size differs from target".into());
                }
                actual_output = actual_output
                    .checked_add(output.written)
                    .ok_or("Output size overflow")?;
            }
        }
    } else {
        let limits = sevenz_turbo::ArchiveLimits {
            memory_limit_bytes: memory_budget as u64,
            ..Default::default()
        };
        let mut a = sevenz_turbo::ArchiveReader::with_limits(
            volumes::Volumes::open(&r.paths).map_err(err)?,
            r.password.as_str().into(),
            limits,
        )
        .map_err(err)?;
        let members = a.archive().files.clone();
        if !matches!(r.links.as_str(), "" | "reject" | "copy-safe") {
            return Err("Unknown link extraction policy".into());
        }
        let copy_links = r.links == "copy-safe";
        if r.op == "extract" && !copy_links && members.iter().any(|entry| entry.is_symlink()) {
            return Err("Archive links are not extracted".into());
        }
        if r.op == "extract"
            && members.iter().any(|entry| {
                entry.is_anti_item()
                    || entry
                        .unix_mode()
                        .is_some_and(|mode| !matches!(mode & 0xf000, 0 | 0x4000 | 0x8000 | 0xa000))
            })
        {
            return Err("Archive anti-items and special files are not extracted".into());
        }
        if r.op == "extract" {
            links::regular_quota(
                members
                    .iter()
                    .filter(|entry| !entry.is_directory() && !entry.is_symlink())
                    .map(|entry| entry.size()),
                r.max_output,
            )?;
        }
        if members
            .iter()
            .any(|entry| entry.is_directory() && entry.size() != 0)
        {
            return Err("Archive directory contains unexpected data".into());
        }
        if copy_links {
            let placeholder: Vec<_> = members
                .iter()
                .map(|entry| links::Member {
                    name: entry.name().to_string(),
                    size: entry.size(),
                    directory: entry.is_directory(),
                    link: entry.is_symlink().then(|| (String::new(), true)),
                })
                .collect();
            links::validate_inventory(&placeholder)?;
        }
        let mut targets = std::collections::HashMap::new();
        let mut target_bytes = 0_u64;
        if copy_links && members.iter().any(|entry| entry.is_symlink()) {
            if members
                .iter()
                .any(|entry| entry.is_symlink() && entry.size() > 16 * 1024)
            {
                return Err("Archive link target exceeds 16 KiB".into());
            }
            let declared_target_bytes = members
                .iter()
                .filter(|entry| entry.is_symlink())
                .try_fold(0_u64, |total, entry| total.checked_add(entry.size()))
                .ok_or("Link target budget overflow")?;
            if declared_target_bytes > 4 * 1024 * 1024 {
                return Err("Archive link target budget exceeded".into());
            }
            a.for_each_entries(|entry, reader| {
                if entry.is_symlink() {
                    let mut output = BoundedOutput::new(Vec::new(), 16 * 1024);
                    io::copy(reader, &mut output)?;
                    if output.written != entry.size() {
                        return Err(io::Error::other("Link target size mismatch").into());
                    }
                    target_bytes = target_bytes
                        .checked_add(output.written)
                        .ok_or_else(|| io::Error::other("Link target budget overflow"))?;
                    if target_bytes > 4 * 1024 * 1024 {
                        return Err(io::Error::other("Archive link target budget exceeded").into());
                    }
                    targets.insert(
                        entry.name().to_string(),
                        String::from_utf8(output.inner).map_err(io::Error::other)?,
                    );
                } else {
                    io::copy(reader, &mut io::sink())?;
                }
                Ok(true)
            })
            .map_err(err)?;
        }
        let inventory: Vec<_> = members
            .iter()
            .map(|entry| links::Member {
                name: entry.name().to_string(),
                size: entry.size(),
                directory: entry.is_directory(),
                link: targets
                    .get(entry.name())
                    .map(|target| (target.clone(), true)),
            })
            .collect();
        let resolved = if copy_links {
            links::resolve(
                &inventory,
                if r.op == "extract" {
                    r.max_output
                } else {
                    u64::MAX
                },
            )?
        } else {
            Vec::new()
        };
        let resolved_sizes: std::collections::HashMap<_, _> = resolved
            .iter()
            .map(|(link, source)| (*link, inventory[*source].size))
            .collect();
        let mut order: Vec<_> = (0..members.len()).collect();
        order.sort_by_key(|index| {
            (
                a.archive().stream_map.file_block_index[*index].unwrap_or(usize::MAX),
                *index,
            )
        });
        let mut prefixes = vec![0_u64; members.len()];
        let mut prefix = 0_u64;
        for index in order {
            prefix = prefix
                .checked_add(inventory[index].size)
                .ok_or("Link prefix size overflow")?;
            prefixes[index] = prefix;
        }
        let plan = links::ReplayPlan::new(&inventory, &resolved, &prefixes)?;
        let source_indices: std::collections::HashMap<_, _> = plan
            .sources
            .iter()
            .map(|index| (inventory[*index].name.clone(), *index))
            .collect();
        let selection = Selection::new(
            r.only.as_deref(),
            members
                .iter()
                .map(|e| (e.name(), e.is_directory(), e.is_symlink())),
        )?;
        let mut source_crcs = std::collections::HashMap::new();
        let mut cache = std::collections::HashMap::new();
        for (index, e) in members.iter().enumerate() {
            let output_size = resolved_sizes.get(&index).copied().unwrap_or(e.size());
            total = total.saturating_add(output_size);
            if r.op == "extract" && (total > r.max_output || !seen.insert(safe(e.name())?)) {
                return Err("Output exceeds limit or contains duplicate paths".into());
            }
            let mut description = metadata::sevenz(e);
            if let Some(target) = targets.get(e.name()) {
                description["link"]["target"] = json!(target);
            }
            entries.push(json!({"name":e.name(),"size":output_size,"isDirectory":e.is_directory(),"isLink":e.is_symlink(),"metadata":description}));
        }
        if r.op == "extract" {
            a.for_each_entries(|e, reader| {
                let dest =
                    safe(e.name()).map_err(|s| io::Error::new(io::ErrorKind::InvalidData, s))?;
                if e.is_symlink() {
                    io::copy(reader, &mut io::sink())?;
                    return Ok(true);
                }
                if e.is_directory() {
                    if selection.everything() {
                        fs::create_dir_all(dest)?;
                    }
                } else {
                    let mut output = BoundedOutput::new(
                        member_output(&dest, selection.wants(e.name()))
                            .map_err(io::Error::other)?,
                        e.size(),
                    );
                    if let Some(index) = source_indices.get(e.name()) {
                        let mut capture = links::CapturingWriter::new(
                            &mut output,
                            plan.cacheable
                                .contains(index)
                                .then_some(inventory[*index].size as usize),
                        );
                        io::copy(reader, &mut capture)?;
                        let (crc, bytes) = capture.finish();
                        source_crcs.insert(*index, crc);
                        if let Some(bytes) = bytes {
                            cache.insert(*index, bytes);
                        }
                    } else {
                        io::copy(reader, &mut output)?;
                    }
                    if output.written != e.size() {
                        return Err(io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            "7z member output size differs from its header",
                        )
                        .into());
                    }
                }
                Ok(true)
            })
            .map_err(err)?;
            const REPLAY_COMPLETE: &str = "native verified source replay complete";
            for (link, source) in resolved {
                if !selection.wants(&inventory[link].name) {
                    continue;
                }
                let dest = safe(&inventory[link].name)?;
                if let Some(bytes) = cache.get(&source) {
                    fs::create_dir_all(dest.parent().ok_or("Invalid link output path")?)
                        .map_err(err)?;
                    let mut output =
                        BoundedOutput::new(create_output(&dest)?, inventory[source].size);
                    io::Write::write_all(&mut output, bytes).map_err(err)?;
                    if output.written != inventory[source].size {
                        return Err("Cached link size differs from source".into());
                    }
                    continue;
                }
                let mut copied = false;
                let replay = a.for_each_entries(|entry, reader| {
                    if entry.name() == inventory[source].name {
                        fs::create_dir_all(
                            dest.parent()
                                .ok_or_else(|| io::Error::other("Invalid link output path"))?,
                        )?;
                        let mut output = BoundedOutput::new(
                            create_output(&dest).map_err(io::Error::other)?,
                            inventory[source].size,
                        );
                        let mut capture = links::CapturingWriter::new(&mut output, None);
                        io::copy(reader, &mut capture)?;
                        let (crc, _) = capture.finish();
                        if output.written != inventory[source].size
                            || source_crcs.get(&source) != Some(&crc)
                        {
                            return Err(io::Error::other(
                                "Link replay differs from verified source",
                            )
                            .into());
                        }
                        copied = true;
                        return Err(sevenz_turbo::Error::Other(REPLAY_COMPLETE.into()));
                    }
                    Ok(true)
                });
                match replay {
                    Err(sevenz_turbo::Error::Other(tag)) if copied && tag == REPLAY_COMPLETE => {}
                    Err(error) => return Err(err(error)),
                    Ok(()) if !copied => return Err("Link target was not decoded".into()),
                    Ok(()) => {}
                }
            }
        }
    }
    Ok(json!({"entries":entries}))
}
/// Execute one JSON command against the worker filesystem.
///
/// # Safety
/// `input` must point to a valid NUL-terminated UTF-8 string for this call.
/// The returned allocation must be released exactly once with `engine_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_run(input: *const c_char) -> *mut c_char {
    let result = (|| {
        let text = unsafe { CStr::from_ptr(input) }.to_str().map_err(err)?;
        run(serde_json::from_str(text).map_err(err)?)
    })();
    let value = match result {
        Ok(v) => v,
        Err(e) => json!({"error":e}),
    };
    CString::new(value.to_string()).unwrap().into_raw()
}
/// Release an engine result.
///
/// # Safety
/// `p` must be null or a live pointer returned by `engine_run`, never freed before.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_free(p: *mut c_char) {
    if !p.is_null() {
        drop(unsafe { CString::from_raw(p) });
    }
}
/// Current committed WebAssembly linear-memory size in bytes.
#[unsafe(no_mangle)]
pub extern "C" fn engine_heap_bytes() -> usize {
    #[cfg(target_arch = "wasm32")]
    {
        core::arch::wasm32::memory_size(0) * 65536
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}
fn main() {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn request(value: Value) -> Request {
        serde_json::from_value(value).unwrap()
    }
    #[test]
    fn rejects_unsupported_commands_and_unmounted_or_aliased_paths() {
        for value in [
            json!({"op":"destroy","paths":["/input/a"]}),
            json!({"op":"create","format":"rar","paths":["/input/a"]}),
            json!({"op":"create","format":"misspelled","paths":["/input/a"]}),
            json!({"op":"list","paths":["/out/a"]}),
            json!({"op":"list","paths":["/input/../a"]}),
            json!({"op":"list","paths":["/input/a", "/input/./a"]}),
            json!({"op":"create","paths":["/input/a", "/input/a/b"]}),
            json!({"op":"create","paths":["/input/a"], "directories":["a/b"]}),
            json!({"op":"create","paths":["/input/a"], "directories":["a"]}),
            json!({"op":"create","paths":["/input/.work/a"]}),
        ] {
            assert!(
                validate_request(&request(value.clone())).is_err(),
                "accepted {value}"
            );
        }
        assert!(
            validate_request(&request(
                json!({"op":"create","format":"7z","paths":[],"directories":["empty", "empty/sub"]})
            ))
            .is_ok()
        );
        assert!(safe("nested/.work/file").is_ok());
        for path in [
            "",
            ".",
            "./",
            "../file",
            "/absolute",
            "C:drive",
            "a\\b",
            ".work/data",
        ] {
            assert!(safe(path).is_err(), "accepted {path}");
        }
    }
    #[test]
    fn output_quota_stops_before_writing_excess_bytes() {
        let mut output = BoundedOutput::new(Vec::new(), 5);
        output.write_all(b"abc").unwrap();
        assert!(output.write_all(b"def").is_err());
        assert_eq!(output.inner, b"abc");
        output.write_all(b"de").unwrap();
        assert!(output.write_all(b"f").is_err());
        assert_eq!(output.inner, b"abcde");
    }
    #[test]
    fn verified_publication_paths_preserve_backup_like_target_names() {
        assert_eq!(
            publication_names(["large.bin", "large.bin.1", "nested/source.bak"]).unwrap(),
            vec!["large.bin", "large.bin.1", "nested/source.bak"]
        );
        assert!(publication_names(["same", "./same"]).is_err());
        assert!(publication_names(["../outside"]).is_err());
        assert!(publication_names([".work/private"]).is_err());
    }
    #[test]
    fn par3_creation_is_disabled_without_blocking_existing_sets() {
        for options in [
            json!({"op":"create","format":"par3","paths":[]}),
            json!({"op":"create","format":"7z","protection":"par3","paths":[]}),
            json!({"op":"create","format":"7z","protection":"par3-embedded","paths":[]}),
        ] {
            assert!(
                validate_request(&request(options))
                    .unwrap_err()
                    .contains("PAR3 creation")
            );
        }
        for op in ["list", "extract", "verify", "repair"] {
            assert!(
                validate_request(&request(json!({
                    "op":op,"format":"par3","paths":["/input/recovery.par3"]
                })))
                .is_ok()
            );
        }
    }
    #[test]
    fn selection_names_only_listed_regular_files() {
        let entries = [
            ("a.txt", false, false),
            ("dir", true, false),
            ("link", false, true),
        ];
        assert!(Selection::new(None, entries).unwrap().wants("anything"));
        let one = Selection::new(Some(&["a.txt".into()]), entries).unwrap();
        assert!(one.wants("a.txt") && !one.wants("dir") && !one.everything());
        for (name, reason) in [
            ("missing", "not in the archive"),
            ("dir", "directory"),
            ("link", "link"),
        ] {
            let error = Selection::new(Some(&[name.into()]), entries).err().unwrap();
            assert!(error.contains(reason), "{error}");
        }
        assert!(validate_request(&request(json!({"op":"list","paths":[],"only":["a"]}))).is_err());
        assert!(validate_request(&request(json!({"op":"extract","paths":[],"only":[]}))).is_err());
    }
    #[test]
    fn incompatible_bcj2_encryption_is_rejected() {
        assert!(
            codecs::methods(&request(
                json!({"op":"create","paths":[],"filter":"bcj2","password":"fixture-password"})
            ))
            .is_err()
        );
    }
}
