use super::{Request, err, safe};
use par3_rs::{
    Par3RepairSession,
    carrier::CarrierPlan,
    ingest::{IngestedPacket, PacketScanner, ScanEvent},
    inside::{ContainerLayout, ContainerLimits, SelfRepairPlan},
    source::{DiskSourceAccess, SourceId},
};
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    io::{self, Read},
    path::Path,
    sync::Arc,
};
fn name(path: &str) -> Result<&str, String> {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid input name".into())
}
fn scratch() -> Result<(), String> {
    fs::create_dir_all("/out/.work").map_err(err)
}
pub fn run(r: &Request) -> Result<Value, String> {
    let options = super::parity::execution(r)?;
    scratch()?;
    let first = r.paths.first().ok_or("Select an archive or PAR3 carrier")?;
    let mut access = DiskSourceAccess::with_options(options.clone());
    for (index, path) in r.paths.iter().enumerate() {
        access.insert(SourceId(index as u64 + 1), path.into());
    }
    let access = Arc::new(access);
    if r.op == "embed" {
        return Err("FFT embedded PAR3 creation is not supported by the current PAR3 crate; use FFT sidecar protection".into());
    }
    let carrier_index = if r.op == "rebuildParity" {
        r.paths
            .iter()
            .position(|p| p.to_lowercase().ends_with(".par3"))
            .ok_or("Select a PAR3 recovery carrier and its protected files")?
    } else {
        0
    };
    let mut scanner = PacketScanner::new(
        access.clone(),
        SourceId(carrier_index as u64 + 1),
        options.clone(),
        par3_rs::ScanLimits::default(),
    )
    .map_err(err)?;
    let mut packets: Vec<IngestedPacket> = Vec::new();
    let mut session: Option<Par3RepairSession> = None;
    loop {
        match scanner.poll().map_err(err)? {
            ScanEvent::Packet(packet) => {
                if session.is_none() {
                    session = Some(
                        Par3RepairSession::new(
                            packet.input_set_id(),
                            access.clone(),
                            options.clone(),
                        )
                        .map_err(err)?,
                    )
                }
                let active = session.as_mut().unwrap();
                if active
                    .set()
                    .is_some_and(|s| s.input_set_id() != packet.input_set_id())
                {
                    return Err("Select one embedded PAR3 set at a time".into());
                }
                active.merge(packet.clone()).map_err(err)?;
                packets.push(packet);
            }
            ScanEvent::End => break,
            ScanEvent::NeedData { offset } => {
                return Err(format!("PAR3 source unavailable at byte {offset}"));
            }
        }
    }
    let mut session =
        session.ok_or("No authenticated embedded PAR3 metadata found in the selected archive")?;
    session
        .layout()
        .map_err(err)?
        .ok_or("Incomplete PAR3 metadata; it cannot be inferred from an archive filename")?;
    let protected: Vec<String> = session
        .set()
        .unwrap()
        .files()
        .iter()
        .map(|f| f.path().into())
        .collect();
    if r.op == "rebuildParity" {
        let lookup: std::collections::HashSet<&str> =
            protected.iter().map(String::as_str).collect();
        for (index, path) in r.paths.iter().enumerate() {
            if let Some(relative) = path.strip_prefix("/input/")
                && lookup.contains(relative)
            {
                session
                    .bind_file(relative, SourceId(index as u64 + 1))
                    .map_err(err)?;
            }
        }
    } else {
        if protected.len() != 1 {
            return Err(
                "Embedded archive operation requires a single protected archive layout".into(),
            );
        }
        session.bind_file(&protected[0], SourceId(1)).map_err(err)?;
    }
    let assessment = session.assess().map_err(err)?;
    let complete = matches!(assessment.status, par3_rs::session::RepairStatus::Complete);
    let status = format!("{:?}", assessment.status);
    let lost = assessment.lost_blocks.len();
    if matches!(r.op.as_str(), "verify" | "verifyEmbedded") {
        return Ok(
            json!({"message":if complete{"Embedded archive data verified"}else{"Embedded archive data is damaged or missing"},"complete":complete,"status":status,"lostBlocks":lost,"embedded":true}),
        );
    }
    if r.op == "removeEmbedded" {
        if !complete {
            return Err(
                "Verify or repair the protected archive before removing embedded protection".into(),
            );
        }
        let layout = session.layout().map_err(err)?.unwrap();
        let file = &layout.files()[0];
        let gaps: Vec<_> = (0..file.extents.len())
            .filter(|i| file.extents.is_unprotected(*i))
            .filter_map(|i| file.extents.range(i))
            .collect();
        if gaps.len() != 1 || gaps[0].start == 0 {
            return Err("Unsupported or ambiguous embedded protection layout".into());
        }
        let temporary = Path::new("/out/.work/plain");
        let mut source = File::open(first).map_err(err)?;
        let mut out = File::create(temporary).map_err(err)?;
        io::copy(
            &mut std::io::Read::by_ref(&mut source).take(gaps[0].start),
            &mut out,
        )
        .map_err(err)?;
        drop(out);
        let mut plain = DiskSourceAccess::with_options(options.clone());
        plain.insert(SourceId(0), temporary.into());
        ContainerLayout::inspect(&plain, SourceId(0), &options, &ContainerLimits::default())
            .map_err(err)?;
        fs::rename(temporary, safe(&format!("plain-{}", name(first)?))?).map_err(err)?;
        return Ok(
            json!({"message":"Embedded protection removed; original container framing verified","complete":true}),
        );
    }
    let matrix = session
        .set()
        .unwrap()
        .matrix_packets()
        .first()
        .ok_or("No executable PAR3 matrix was found")?
        .hash();
    let existing = session.set().unwrap().recovery_blocks().len() as u64;
    let requested = r.recovery_blocks.unwrap_or(existing.max(1));
    if requested > 65535 {
        return Err("Requested replacement recovery count exceeds operation limit".into());
    }
    let indices: Vec<u64> = (0..requested).collect();
    if r.op == "rebuildParity" {
        if !session
            .set()
            .unwrap()
            .matrix_packets()
            .iter()
            .all(|p| matches!(p.body(), par3_rs::PacketBody::FftMatrix(_)))
        {
            return Err("PAR3 recovery generation is FFT-only; exact carrier regeneration requires a set containing only FFT matrices".into());
        }
        let plan = if r.replacement {
            CarrierPlan::replacement(&mut session, matrix, &indices).map_err(err)?
        } else {
            CarrierPlan::capture(&packets,&options).map_err(|e|format!("Exact carrier reconstruction needs a complete captured packet layout: {e}. Choose explicit replacement to create a new carrier."))?
        };
        let report = plan
            .execute(
                &mut session,
                Path::new("/out/rebuilt.par3"),
                Path::new("/out/.work"),
            )
            .map_err(err)?;
        return Ok(
            json!({"message":format!("PAR3 carrier regenerated ({:?})",report.restoration),"restoration":format!("{:?}",report.restoration),"recoveryBlocks":report.recovery_packets,"complete":true}),
        );
    }
    let plan = if r.replacement {
        SelfRepairPlan::replacement(&mut session, matrix, &indices, ContainerLimits::default())
            .map_err(err)?
    } else {
        SelfRepairPlan::capture(&mut session,&packets,ContainerLimits::default()).map_err(|e|format!("Exact embedded repair needs the complete original packet layout: {e}. Explicit replacement can rebuild unknown protection only when authenticated metadata and sufficient recovery survive."))?
    };
    let dest = safe(&format!("repaired-{}", name(first)?))?;
    let report = plan
        .execute(&mut session, &dest, Path::new("/out/.work"))
        .map_err(err)?;
    Ok(
        json!({"message":format!("Embedded archive repaired ({:?})",report.restoration),"complete":true,"embedded":true,"restoration":format!("{:?}",report.restoration),"reconstructedBlocks":report.reconstructed_blocks}),
    )
}
