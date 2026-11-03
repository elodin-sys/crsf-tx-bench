//! Send disarmed sticks to a Nomad and print whatever the module answers.
//!
//! ```text
//! cargo run --manifest-path crates/nomad/Cargo.toml --example send -- --list
//! cargo run --manifest-path crates/nomad/Cargo.toml --example send -- --port /dev/ttyACM0
//! ```
//!
//! Ctrl-C writes three disarmed frames, then closes the port. This example does
//! not arm. Channel 3 stays at low throttle.

use nomad::{is_handset_baud, list_ports, Handset, Options, Sticks, DEFAULT_BAUD};
use std::env;
use std::io::{self, Write};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

static STOP: AtomicBool = AtomicBool::new(false);

fn main() -> ExitCode {
    let raw: Vec<String> = env::args().skip(1).collect();
    if raw.is_empty() || raw.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{}", help());
        return ExitCode::SUCCESS;
    }
    match run(raw) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err}");
            ExitCode::from(1)
        }
    }
}

fn run(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse(&args)?;
    if args.list {
        let ports = list_ports()?;
        if ports.is_empty() {
            println!("No serial ports.");
            return Ok(());
        }
        for port in ports {
            println!("{}  {}", port.name, port.description);
        }
        return Ok(());
    }

    let path = args.port.ok_or("pass --port, or --list to see ports")?;
    if !is_handset_baud(args.baud) {
        return Err(format!("{} is not a supported handset baud rate", args.baud).into());
    }

    ctrlc::set_handler(|| STOP.store(true, Ordering::SeqCst))?;
    let options = Options {
        baud_rate: args.baud,
        model_id: args.model,
        ..Options::default()
    };
    let mut handset = Handset::open(&path, options)?;
    let sticks = Sticks::disarmed();
    let channels = sticks.to_crsf();
    let period = Duration::from_secs_f64(1.0 / f64::from(args.hz));
    println!(
        "Sending disarmed sticks to {path} at {} baud, {} Hz. Model ID: {}. Ctrl-C stops.",
        args.baud,
        args.hz,
        args.model
            .map(|id| id.to_string())
            .unwrap_or_else(|| "unchanged".to_owned())
    );

    let began = Instant::now();
    let mut next_cycle = began;
    let mut polls = 0u64;
    let mut last_report = Instant::now()
        .checked_sub(Duration::from_secs(2))
        .unwrap_or_else(Instant::now);
    while !STOP.load(Ordering::SeqCst)
        && args
            .seconds
            .is_none_or(|seconds| began.elapsed() < Duration::from_secs(seconds))
    {
        let telemetry = handset.poll(&channels)?;
        polls += 1;
        if last_report.elapsed() >= Duration::from_secs(1) {
            last_report = Instant::now();
            match telemetry.link {
                Some(link) if telemetry.link_is_fresh(Duration::from_secs(2)) => println!(
                    "uplink {}%  {} dBm  {} dB snr  {} mW; downlink {}%  {} dBm",
                    link.uplink_lq,
                    link.uplink_rssi_dbm,
                    link.uplink_snr,
                    link.tx_power_mw
                        .map(|mw| mw.to_string())
                        .unwrap_or_else(|| "unknown".to_owned()),
                    link.downlink_lq,
                    link.downlink_rssi_dbm
                ),
                Some(_) => println!("link statistics are stale; receiver link is unknown"),
                None => println!("no reply yet. The module searches baud rates for a few seconds."),
            }
            if let Some(name) = &telemetry.device_name {
                println!("device {name}");
            }
            let _ = io::stdout().flush();
        }
        // Keep OS sleep overshoot from accumulating across every cycle. If a
        // whole deadline is missed, skip ahead rather than bursting old frames.
        next_cycle += period;
        let now = Instant::now();
        if next_cycle <= now {
            next_cycle = now + period;
        }
        thread::sleep(next_cycle.saturating_duration_since(now));
    }
    handset.stop()?;
    println!(
        "Stopped after {polls} polls in {:.3}s. Channel 5 stayed low.",
        began.elapsed().as_secs_f64()
    );
    Ok(())
}

struct Args {
    list: bool,
    port: Option<String>,
    baud: u32,
    hz: u16,
    model: Option<u8>,
    seconds: Option<u64>,
}

impl Args {
    fn parse(args: &[String]) -> Result<Self, String> {
        let mut parsed = Self {
            list: false,
            port: None,
            baud: DEFAULT_BAUD,
            hz: 100,
            model: None,
            seconds: None,
        };
        let mut index = 0;
        while index < args.len() {
            let arg = &args[index];
            match arg.as_str() {
                "--list" | "-l" => parsed.list = true,
                "--port" | "-p" => parsed.port = Some(need(args, &mut index, "--port")?),
                "--baud" | "-b" => {
                    parsed.baud = need(args, &mut index, "--baud")?
                        .parse()
                        .map_err(|_| "baud must be a number".to_owned())?;
                }
                "--hz" => {
                    let hz: u16 = need(args, &mut index, "--hz")?
                        .parse()
                        .map_err(|_| "hz must be a number".to_owned())?;
                    if !(1..=500).contains(&hz) {
                        return Err("hz must be from 1 to 500".to_owned());
                    }
                    parsed.hz = hz;
                }
                "--model" => {
                    let model: u8 = need(args, &mut index, "--model")?
                        .parse()
                        .map_err(|_| "model must be 0 through 63".to_owned())?;
                    if model > 63 {
                        return Err("model must be 0 through 63".to_owned());
                    }
                    parsed.model = Some(model);
                }
                "--seconds" => {
                    let seconds: u64 = need(args, &mut index, "--seconds")?
                        .parse()
                        .map_err(|_| "seconds must be a positive integer".to_owned())?;
                    if seconds == 0 {
                        return Err("seconds must be a positive integer".to_owned());
                    }
                    parsed.seconds = Some(seconds);
                }
                other if other.starts_with('-') => {
                    return Err(format!("unknown argument {other}\n{}", help()))
                }
                other if parsed.port.is_none() => parsed.port = Some(other.to_owned()),
                other => return Err(format!("unexpected argument {other}")),
            }
            index += 1;
        }
        if !parsed.list && parsed.port.is_none() {
            return Err(help());
        }
        // 8N1 needs ten wire bits per byte; include the periodic ping/model ID.
        let extra_bytes_per_second = if parsed.model.is_some() { 8 } else { 3 };
        if (26 * u32::from(parsed.hz) + extra_bytes_per_second) * 10 > parsed.baud {
            return Err("requested channel rate exceeds the serial baud capacity".to_owned());
        }
        Ok(parsed)
    }
}

fn need(args: &[String], index: &mut usize, flag: &str) -> Result<String, String> {
    *index += 1;
    args.get(*index)
        .cloned()
        .ok_or_else(|| format!("{flag} needs a value"))
}

fn help() -> String {
    "\
Send disarmed CRSF sticks to a RadioMaster Nomad.

Usage:
  send --list
  send --port /dev/ttyACM0 [--baud 115200] [--hz 100] [--seconds 30] [--model 0]

The module hardware page has to point the handset at USB-C:
CRSF Serial Pins RX 3, TX 1 (not Serial2). Power the radio from the XT30.
Model ID is unchanged unless --model is supplied. --seconds bounds the run."
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Args, String> {
        Args::parse(&args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>())
    }

    #[test]
    fn default_does_not_change_model_id() {
        let args = parse(&["--port", "test"]).unwrap();
        assert_eq!(args.baud, 115200);
        assert_eq!(args.model, None);
        assert_eq!(args.seconds, None);
    }

    #[test]
    fn finite_run_and_model_are_explicit() {
        let args = parse(&["test", "--seconds", "30", "--model", "7"]).unwrap();
        assert_eq!(args.seconds, Some(30));
        assert_eq!(args.model, Some(7));
    }

    #[test]
    fn invalid_arguments_are_rejected_before_opening_a_port() {
        for args in [
            vec!["test", "--seconds", "0"],
            vec!["test", "--seconds", "-1"],
            vec!["test", "--seconds"],
            vec!["test", "--hz", "0"],
            vec!["test", "--model", "64"],
            vec!["test", "unexpected"],
            vec!["test", "--hz", "500"],
        ] {
            assert!(parse(&args).is_err(), "accepted {args:?}");
        }
    }

    #[test]
    fn high_channel_rate_requires_enough_serial_bandwidth() {
        assert!(parse(&["test", "--hz", "500", "--baud", "400000"]).is_ok());
        assert!(parse(&["test", "--hz", "200"]).is_ok());
    }
}
