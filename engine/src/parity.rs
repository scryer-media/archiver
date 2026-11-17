use super::{Request, err, safe};
use par3_rs::{
    Par3RepairSession,
    ingest::{PacketScanner, ScanEvent},
    runtime::ExecutionOptions,
    source::{DiskSourceAccess, SourceId},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
fn relative(path: &str) -> Result<&str, String> {
    let name = path
        .strip_prefix("/input/")
        .ok_or("Input must be mounted under /input")?;
    safe(name)?;
    Ok(name)
}
pub(super) fn execution(r: &Request) -> Result<ExecutionOptions, String> {
    let mut options = ExecutionOptions::default();
    options.workers = 1;
    let limit = r.memory_budget()?;
    options.memory = par3_rs::runtime::MemoryBudget::new(limit);
    options.retained_bytes = (64 * 1024 * 1024).min(limit / 4);
    Ok(options)
}
pub fn create(r: &Request) -> Result<Value, String> {
    create_at(r, "/input")
}
pub fn create_at(r: &Request, base: &str) -> Result<Value, String> {
    if !r.password.is_empty() {
        return Err("Parity sets do not support password encryption".into());
    }
    let block = r.block_size.unwrap_or(1024 * 1024);
    if block == 0 || block > 64 * 1024 * 1024 {
        return Err("Block size must be between 1 byte and 64 MiB".into());
    }
    let percent = r.recovery_percent.unwrap_or(20);
    if percent > 1000 {
        return Err("Recovery percentage must be at most 1000".into());
    }
    let prefix = format!("{base}/");
    let names: Vec<PathBuf> = r
        .paths
        .iter()
        .map(|p| {
            let name = p
                .strip_prefix(&prefix)
                .ok_or("Invalid parity source path")?;
            safe(name)?;
            Ok(PathBuf::from(name))
        })
        .collect::<Result<_, String>>()?;
    if r.format == "par2" {
        let mut options = par2_rs::Par2CreatorOptions::with_output(
            "/out/recovery.par2".into(),
            Some(base.into()),
            names.clone(),
        );
        options.block_sizing = par2_rs::BlockSizing::Bytes(block);
        options.memory_limit = Some(r.memory_budget()?);
        options.recovery_amount = if let Some(count) = r.recovery_blocks {
            par2_rs::RecoveryAmount::Count(count.try_into().map_err(err)?)
        } else {
            par2_rs::RecoveryAmount::Percent(percent)
        };
        options.first_exponent = r.first_recovery.unwrap_or(0).try_into().map_err(err)?;
        options.volume_count = r.volume_count;
        options.volume_scheme = match r.volume_scheme.as_str() {
            "" | "variable" => par2_rs::VolumeScheme::Variable,
            "uniform" => par2_rs::VolumeScheme::Uniform,
            "limited" => par2_rs::VolumeScheme::Limited,
            other => return Err(format!("Unsupported PAR2 volume layout: {other}")),
        };
        let creator = par2_rs::Par2Creator::new(options);
        let plan = creator.plan().map_err(err)?;
        let result = creator.create(&plan).map_err(err)?;
        return Ok(
            json!({"message":format!("Created PAR2 set with {} recovery blocks",result.recovery_count),"recoveryBlocks":result.recovery_count}),
        );
    }
    if !matches!(r.par3_codec.as_str(), "" | "fft") {
        return Err("PAR3 generation is FFT-only".into());
    }
    let options = execution(r)?;
    let mut access = DiskSourceAccess::with_options(options.clone());
    let mut sources = Vec::new();
    for (index, path) in r.paths.iter().enumerate() {
        let id = SourceId(index as u64 + 1);
        access.insert(id, path.into());
        sources.push(par3_rs::creation::CreationSource {
            name: names[index].to_string_lossy().into(),
            source: id,
        });
    }
    let access = Arc::new(access);
    let mut settings = par3_rs::creation::CreationOptions {
        block_size: block,
        recovery_count: 0,
        execution: options,
        ..Default::default()
    };
    settings.codec = par3_rs::creation::CreationCodec::Fft {
        capacity_log2: 0,
        interleave: r.par3_interleave.unwrap_or(0),
    };
    settings.deduplication = match r.deduplication.as_str() {
        "" | "none" => par3_rs::creation::Deduplication::None,
        "aligned" => par3_rs::creation::Deduplication::Aligned,
        "sliding" => par3_rs::creation::Deduplication::Sliding,
        other => return Err(format!("Unsupported PAR3 deduplication: {other}")),
    };
    settings.store_data = r.store_data;
    settings.volumes = match r.volume_scheme.as_str() {
        "" | "variable" => par3_rs::creation::VolumeLayout::Variable,
        "uniform" => par3_rs::creation::VolumeLayout::Uniform(
            r.volume_blocks
                .ok_or("Uniform PAR3 volumes need a positive volumeBlocks value")?,
        ),
        "size" => par3_rs::creation::VolumeLayout::SizeLimited(
            r.volume_bytes
                .ok_or("Size-limited PAR3 volumes need volumeBytes")?,
        ),
        other => return Err(format!("Unsupported PAR3 volume layout: {other}")),
    };
    let preliminary =
        par3_rs::creation::CreationPlan::build(access.clone(), &sources, settings.clone())
            .map_err(err)?;
    let blocks = preliminary.requirements().blocks;
    drop(preliminary);
    let mut count = r
        .recovery_blocks
        .unwrap_or(blocks.saturating_mul(percent as u64).div_ceil(100));
    let interleave = r.par3_interleave.unwrap_or(0);
    if interleave > 65535 {
        return Err("PAR3 interleave must be between 0 and 65535".into());
    }
    let cohorts = interleave + 1;
    if matches!(r.par3_codec.as_str(), "" | "fft") && r.recovery_blocks.is_none() {
        count = count
            .div_ceil(cohorts)
            .checked_mul(cohorts)
            .ok_or("Recovery count overflow")?;
    }
    settings.recovery_count = count;
    settings.first_recovery = r.first_recovery.unwrap_or(0);
    if !matches!(r.par3_codec.as_str(), "" | "fft") {
        return Err("PAR3 generation is FFT-only".into());
    }
    let end = settings
        .first_recovery
        .checked_add(count)
        .ok_or("FFT recovery index overflow")?;
    let capacity = r.par3_capacity_log2.unwrap_or(
        end.div_ceil(cohorts)
            .max(1)
            .checked_next_power_of_two()
            .ok_or("FFT capacity overflow")?
            .ilog2()
            .try_into()
            .map_err(err)?,
    );
    if !(0..=16).contains(&capacity) {
        return Err("FFT capacity log2 must be between 0 and 16".into());
    }
    settings.codec = par3_rs::creation::CreationCodec::Fft {
        capacity_log2: capacity,
        interleave,
    };
    let plan = par3_rs::creation::CreationPlan::build(access, &sources, settings).map_err(err)?;
    fs::create_dir_all("/out/.work").map_err(err)?;
    let outputs = plan
        .execute(Path::new("/out/recovery"), Path::new("/out/.work"))
        .map_err(err)?;
    Ok(
        json!({"message":format!("Created PAR3 set with {blocks} source blocks and {count} recovery blocks"),"recoveryBlocks":count,"paths":outputs.iter().map(|p|p.display().to_string()).collect::<Vec<_>>()}),
    )
}
pub fn par3(r: &Request) -> Result<Value, String> {
    let options = execution(r)?;
    let mut access = DiskSourceAccess::with_options(options.clone());
    for (index, path) in r.paths.iter().enumerate() {
        relative(path)?;
        access.insert(SourceId(index as u64 + 1), path.into());
    }
    let access = Arc::new(access);
    let mut sessions: Vec<(par3_rs::InputSetId, Par3RepairSession)> = Vec::new();
    for (index, path) in r.paths.iter().enumerate() {
        if !path.to_lowercase().ends_with(".par3") {
            continue;
        }
        let mut scanner = PacketScanner::new(
            access.clone(),
            SourceId(index as u64 + 1),
            options.clone(),
            par3_rs::ScanLimits::default(),
        )
        .map_err(err)?;
        loop {
            match scanner.poll().map_err(err)? {
                ScanEvent::Packet(packet) => {
                    let id = packet.input_set_id();
                    let position = match sessions.iter().position(|(set, _)| *set == id) {
                        Some(position) => position,
                        None => {
                            sessions.push((
                                id,
                                Par3RepairSession::new(id, access.clone(), options.clone())
                                    .map_err(err)?,
                            ));
                            sessions.len() - 1
                        }
                    };
                    sessions[position].1.merge(packet).map_err(err)?;
                }
                ScanEvent::End => break,
                ScanEvent::NeedData { offset } => {
                    return Err(format!("PAR3 carrier is incomplete at byte {offset}"));
                }
            }
        }
    }
    if sessions.is_empty() {
        return Err("No authenticated PAR3 packets found".into());
    }
    // Resolve every set before publishing anything: separate sets may otherwise
    // overwrite the same output path despite authenticating different bytes.
    let mut output_files = std::collections::HashSet::new();
    let mut output_directories = std::collections::HashSet::new();
    let mut output_bytes = 0u64;
    let mut entries = Vec::new();
    for (_id, session) in &mut sessions {
        for (index, path) in r.paths.iter().enumerate() {
            if !path.to_lowercase().ends_with(".par3") {
                session
                    .bind_file(relative(path)?, SourceId(index as u64 + 1))
                    .map_err(err)?;
            }
        }
        session
            .layout()
            .map_err(err)?
            .ok_or("Incomplete PAR3 layout metadata")?;
        let set = session.set().ok_or("Incomplete PAR3 set metadata")?;
        for file in set.files() {
            let path = safe(file.path())?;
            if !output_files.insert(path) {
                return Err("Selected PAR3 sets contain conflicting output files".into());
            }
            output_bytes = output_bytes
                .checked_add(file.size())
                .ok_or("PAR3 output size overflow")?;
            entries.push(json!({"name":file.path(),"size":file.size(),"isDirectory":false}));
        }
        for directory in set.directories() {
            output_directories.insert(safe(directory.path())?);
            entries.push(json!({"name":directory.path(),"size":0,"isDirectory":true}));
        }
    }
    if output_files
        .iter()
        .chain(output_directories.iter())
        .any(|path| {
            output_directories.contains(path) && output_files.contains(path)
                || path
                    .ancestors()
                    .skip(1)
                    .any(|parent| output_files.contains(parent))
        })
    {
        return Err("PAR3 files conflict with output directory paths".into());
    }
    if r.op == "repair" && output_bytes > r.max_output {
        return Err("PAR3 output exceeds the selected byte quota".into());
    }
    let mut reports = Vec::new();
    let mut all_complete = true;
    for (_id, session) in &mut sessions {
        if r.op == "list" {
            continue;
        }
        let assessment = session.assess().map_err(err)?;
        let status = format!("{:?}", assessment.status);
        let complete = assessment.files.iter().all(|f| f.complete)
            && matches!(assessment.status, par3_rs::session::RepairStatus::Complete);
        let lost = assessment.lost_blocks.len();
        let intact: Vec<String> = assessment
            .files
            .iter()
            .filter(|file| file.complete)
            .map(|file| file.path.clone())
            .collect();
        let files: Vec<Value> = assessment
            .files
            .iter()
            .map(|f| json!({"name":f.path,"complete":f.complete,"verifiedBytes":f.verified_prefix}))
            .collect();
        if r.op == "repair" {
            // The crate installs only damaged files. A browser job returns the
            // complete protected file set, including its verified originals.
            for name in intact {
                let source = r
                    .paths
                    .iter()
                    .find(|path| path.strip_prefix("/input/") == Some(name.as_str()))
                    .ok_or("Verified PAR3 source has no selected input file")?;
                let destination = safe(&name)?;
                fs::create_dir_all(destination.parent().ok_or("Invalid PAR3 output path")?)
                    .map_err(err)?;
                let mut input = fs::File::open(source).map_err(err)?;
                let mut output =
                    super::BoundedOutput::new(super::create_output(&destination)?, r.max_output);
                std::io::copy(&mut input, &mut output).map_err(err)?;
            }
            for directory in &output_directories {
                fs::create_dir_all(directory).map_err(err)?;
            }
        }
        if r.op == "repair" && !complete {
            session.validate_repair().map_err(err)?;
            let repaired = session.repair(Path::new("/out"), false).map_err(err)?;
            reports.push(json!({"status":"Repaired","reconstructedBlocks":repaired.reconstructed_blocks,"files":files}));
        } else {
            all_complete &= complete;
            reports.push(json!({"status":status,"lostBlocks":lost,"files":files}));
        }
    }
    Ok(
        json!({"entries":entries,"complete":all_complete,"sets":reports,"message":if r.op=="list"{"PAR3 set inspected"}else if r.op=="repair"{"PAR3 repair completed"}else if all_complete{"PAR3 verification complete"}else{"PAR3 verification found missing or damaged data"}}),
    )
}
