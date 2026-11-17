use super::Request;
use sevenz_turbo::{EncoderConfiguration, EncoderMethod, encoder_options::*};
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    codec: String,
    filter: String,
    level: Option<u32>,
    dictionary: Option<u32>,
    delta: Option<u32>,
}
impl Plan {
    fn base(r: &Request) -> Self {
        Self {
            codec: if r.codec.is_empty() {
                "lzma2".into()
            } else {
                r.codec.clone()
            },
            filter: if r.filter.is_empty() {
                "none".into()
            } else {
                r.filter.clone()
            },
            level: r.level,
            dictionary: r.dictionary_size,
            // Legacy callers supplied this global default for every filter.
            delta: if r.filter == "delta" {
                r.delta_distance
            } else {
                None
            },
        }
    }
}
pub fn file_plans(r: &Request) -> Result<Vec<Plan>, String> {
    let inputs: std::collections::HashSet<_> = r
        .paths
        .iter()
        .map(|path| {
            super::safe(
                path.strip_prefix("/input/")
                    .ok_or("Input path must be mounted under /input")?,
            )
        })
        .collect::<Result<_, _>>()?;
    let mut overrides = std::collections::HashMap::new();
    for option in &r.file_options {
        let name = super::safe(&option.name)?;
        if !inputs.contains(&name) || overrides.insert(name, option).is_some() {
            return Err("Per-file options must name unique selected files".into());
        }
    }
    r.paths
        .iter()
        .map(|path| {
            let mut plan = Plan::base(r);
            if let Some(option) = overrides.get(&super::safe(
                path.strip_prefix("/input/")
                    .ok_or("Input path must be mounted under /input")?,
            )?) {
                if let Some(codec) = &option.codec {
                    if *codec != plan.codec {
                        plan.level = None;
                        plan.dictionary = None;
                    }
                    plan.codec = codec.clone();
                }
                if let Some(filter) = &option.filter {
                    if *filter != plan.filter {
                        plan.delta = None;
                    }
                    plan.filter = filter.clone();
                }
                if option.level.is_some() {
                    plan.level = option.level;
                }
                if option.dictionary_size.is_some() {
                    plan.dictionary = option.dictionary_size;
                }
                if option.delta_distance.is_some() {
                    plan.delta = option.delta_distance;
                }
            }
            plan_methods(r, &plan)?;
            Ok(plan)
        })
        .collect()
}
pub fn header_methods(r: &Request) -> Result<Vec<EncoderConfiguration>, String> {
    let plan = Plan {
        codec: "lzma2".into(),
        filter: "none".into(),
        level: Some(3),
        dictionary: None,
        delta: None,
    };
    plan_methods(r, &plan)
}
#[cfg(test)]
pub fn methods(r: &Request) -> Result<Vec<EncoderConfiguration>, String> {
    plan_methods(r, &Plan::base(r))
}
pub fn plan_methods(r: &Request, p: &Plan) -> Result<Vec<EncoderConfiguration>, String> {
    if p.filter == "bcj2" && !r.password.is_empty() {
        return Err("BCJ2 cannot be combined with 7z password encryption".into());
    }
    let budget = r.memory_budget()?;
    let max_dictionary = (budget / 32).clamp(65536, 8 * 1024 * 1024) as u32;
    let dictionary = p.dictionary.unwrap_or(max_dictionary);
    if p.dictionary.is_some()
        && (!matches!(p.codec.as_str(), "lzma" | "lzma2")
            || !(65536..=max_dictionary).contains(&dictionary))
    {
        return Err("Dictionary size requires LZMA/LZMA2 and must fit 64 KiB..8 MiB and the selected memory budget".into());
    }
    let range = match p.codec.as_str() {
        "lzma" | "lzma2" | "deflate" | "ppmd" => Some(0..=9),
        "bzip2" => Some(1..=9),
        "zstd" => Some(1..=22),
        "brotli" => Some(0..=11),
        _ => None,
    };
    if let Some(level) = p.level
        && !range.is_some_and(|range| range.contains(&level))
    {
        return Err("Compression level is invalid or not applicable to this codec".into());
    }
    if p.delta.is_some() && p.filter != "delta" {
        return Err("Delta distance requires the Delta filter".into());
    }
    let codec: EncoderConfiguration = match p.codec.as_str() {
        "" | "lzma2" => {
            let mut options = Lzma2Options::from_level(p.level.unwrap_or(3));
            options.set_dictionary_size(dictionary);
            options.into()
        }
        "lzma" => {
            let mut options = LzmaOptions::from_level(p.level.unwrap_or(3));
            options.set_dictionary_size(dictionary);
            options.into()
        }
        "copy" => EncoderMethod::COPY.into(),
        "ppmd" => {
            let (order, memory) = p
                .level
                .map(|level| {
                    (
                        [3, 4, 4, 5, 5, 6, 8, 16, 24, 32][level as usize],
                        (1u32 << (level + 19)).min((budget / 2) as u32),
                    )
                })
                .unwrap_or((8, (budget / 2) as u32));
            PpmdOptions::from_order_memory_size(order, memory).into()
        }
        "bzip2" => Bzip2Options::from_level(p.level.unwrap_or(9)).into(),
        "zstd" => ZstandardOptions::from_level(p.level.unwrap_or(3)).into(),
        "deflate" => DeflateOptions::from_level(p.level.unwrap_or(6)).into(),
        "lz4" => Lz4Options::default().into(),
        "brotli" => BrotliOptions::from_quality_window(p.level.unwrap_or(11), 22).into(),
        other => return Err(format!("Unsupported 7z creation codec: {other}")),
    };
    let mut result = Vec::new();
    if !r.password.is_empty() {
        result.push(AesEncoderOptions::new(r.password.as_str().into()).into());
    }
    result.push(codec);
    let filter: Option<EncoderConfiguration> = match p.filter.as_str() {
        "" | "none" => None,
        "delta" => {
            let distance = p.delta.unwrap_or(1);
            if !(1..=256).contains(&distance) {
                return Err("Delta distance must be between 1 and 256".into());
            }
            Some(DeltaOptions::from_distance(distance).into())
        }
        "x86" => Some(EncoderMethod::BCJ_X86_FILTER.into()),
        "arm" => Some(EncoderMethod::BCJ_ARM_FILTER.into()),
        "arm64" => Some(EncoderMethod::BCJ_ARM64_FILTER.into()),
        "thumb" => Some(EncoderMethod::BCJ_ARM_THUMB_FILTER.into()),
        "ia64" => Some(EncoderMethod::BCJ_IA64_FILTER.into()),
        "sparc" => Some(EncoderMethod::BCJ_SPARC_FILTER.into()),
        "ppc" => Some(EncoderMethod::BCJ_PPC_FILTER.into()),
        "riscv" => Some(EncoderMethod::BCJ_RISCV_FILTER.into()),
        "bcj2" => Some(EncoderMethod::BCJ2_FILTER.into()),
        other => return Err(format!("Unsupported 7z filter: {other}")),
    };
    if let Some(filter) = filter {
        result.push(filter);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn request(options: serde_json::Value) -> Request {
        serde_json::from_value(options).unwrap()
    }
    #[test]
    fn per_file_plans_reject_unselected_duplicate_and_inapplicable_options() {
        for options in [
            json!([{"name":"missing","codec":"copy"}]),
            json!([{"name":"a"},{"name":"a"}]),
            json!([{"name":"a","codec":"copy","level":3}]),
            json!([{"name":"a","codec":"lzma2","dictionarySize":33554432}]),
            json!([{"name":"a","filter":"none","deltaDistance":2}]),
            json!([{"name":"a","filter":"bcj2"}]),
        ] {
            let r = request(
                json!({"op":"create","format":"7z","paths":["/input/a"],"password":"fixture-password","fileOptions":options}),
            );
            assert!(file_plans(&r).is_err());
        }
    }
    #[test]
    fn codec_override_resets_inapplicable_global_tuning() {
        let r = request(
            json!({"op":"create","format":"7z","paths":["/input/a","/input/b"],"codec":"lzma2","dictionarySize":1048576,"level":2,"filter":"delta","deltaDistance":4,"fileOptions":[{"name":"b","codec":"copy","filter":"none"}]}),
        );
        let plans = file_plans(&r).unwrap();
        assert_ne!(plans[0], plans[1]);
        assert_eq!(plans[1].dictionary, None);
        assert_eq!(plans[1].level, None);
        assert_eq!(plans[1].delta, None);
    }
    #[test]
    fn inactive_global_delta_is_compatible_but_per_file_delta_is_explicit() {
        for filter in [
            "none", "x86", "arm", "arm64", "thumb", "ia64", "sparc", "ppc", "riscv", "bcj2",
        ] {
            let r = request(
                json!({"op":"create","format":"7z","paths":["/input/a"],"filter":filter,"deltaDistance":16}),
            );
            assert_eq!(file_plans(&r).unwrap()[0].delta, None);
        }
        let r = request(
            json!({"op":"create","format":"7z","paths":["/input/a"],"filter":"x86","deltaDistance":16,"fileOptions":[{"name":"a","filter":"delta"}]}),
        );
        assert_eq!(file_plans(&r).unwrap()[0].delta, None);
        let r = request(
            json!({"op":"create","format":"7z","paths":["/input/a"],"filter":"delta","deltaDistance":16}),
        );
        assert_eq!(file_plans(&r).unwrap()[0].delta, Some(16));
        let r = request(
            json!({"op":"create","format":"7z","paths":["/input/a"],"deltaDistance":16,"fileOptions":[{"name":"a","filter":"delta","deltaDistance":256}]}),
        );
        assert_eq!(file_plans(&r).unwrap()[0].delta, Some(256));
        let r = request(
            json!({"op":"create","format":"7z","paths":["/input/a"],"filter":"delta","deltaDistance":257}),
        );
        assert!(file_plans(&r).is_err());
    }
}
