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
        eprintln!(
            "warning: {baud} is not a handset rate. The module locks to 115200, 400000, 921600, 1870000, or 2250000.",
            baud = args.baud
        );
    }

    install_stop();
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
        "Sending disarmed sticks to {path} at {} baud, {} Hz, model {}. Ctrl-C stops.",
        args.baud, args.hz, args.model
    );

    let mut last_report = Instant::now()
        .checked_sub(Duration::from_secs(2))
        .unwrap_or_else(Instant::now);
    while !STOP.load(Ordering::SeqCst) {
        let started = Instant::now();
        let telemetry = handset.poll(&channels)?;
        if last_report.elapsed() >= Duration::from_secs(1) {
            last_report = Instant::now();
            match telemetry.link {
                Some(link) => println!(
                    "uplink {}%  {} dBm  {} dB snr  {} mW",
                    link.uplink_lq,
                    link.uplink_rssi_dbm,
                    link.uplink_snr,
                    link.tx_power_mw
                        .map(|mw| mw.to_string())
                        .unwrap_or_else(|| "unknown".to_owned())
                ),
                None => println!("no reply yet. The module searches baud rates for a few seconds."),
            }
            if let Some(name) = &telemetry.device_name {
                println!("device {name}");
            }
            let _ = io::stdout().flush();
        }
        let remain = period.saturating_sub(started.elapsed());
        if !remain.is_zero() {
            thread::sleep(remain);
        }
    }
    println!("Stopping. Channel 5 stays low.");
    Ok(())
}

struct Args {
    list: bool,
    port: Option<String>,
    baud: u32,
    hz: u16,
    model: u8,
}

impl Args {
    fn parse(args: &[String]) -> Result<Self, String> {
        let mut parsed = Self {
            list: false,
            port: None,
            baud: DEFAULT_BAUD,
            hz: 100,
            model: 0,
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
                    parsed.model = model;
                }
                other if other.starts_with('-') => {
                    return Err(format!("unknown argument {other}\n{}", help()))
                }
                other => parsed.port = Some(other.to_owned()),
            }
            index += 1;
        }
        if !parsed.list && parsed.port.is_none() {
            return Err(help());
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
  send --port /dev/ttyACM0 [--baud 400000] [--hz 100] [--model 0]

The module hardware page has to point the handset at USB-C:
serial_rx 3, serial_tx 1. Power the radio from the XT30."
        .to_owned()
}

extern "C" {
    fn signal(signum: i32, handler: extern "C" fn(i32)) -> usize;
}

extern "C" fn on_signal(_: i32) {
    STOP.store(true, Ordering::SeqCst);
}

fn install_stop() {
    unsafe {
        let _ = signal(2, on_signal);
        let _ = signal(15, on_signal);
    }
}
