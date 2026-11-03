# nomad

A Rust handset for a [RadioMaster Nomad](https://radiomasterrc.com/products/nomad-gemini-xrossband-expresslrs-module). It writes CRSF channel frames to the module's USB-C serial port and reads link telemetry back.

The Nomad ships with the handset on the module-bay pin (GPIO 4). USB-C is a separate serial port until the hardware page points the handset UART at the USB pins.

## Hardware

1. Fit both antennas. Power the module from the XT30 with a 2S–4S pack. USB can run the processor. It cannot feed the 1 W amplifiers.
2. Leave the module out of a radio, with USB unplugged. After about a minute it opens Wi-Fi: `ExpressLRS TX` / `expresslrs`.
3. Open [http://10.0.0.1/hardware.html](http://10.0.0.1/hardware.html) and write down the current serial pins.
4. Under **CRSF Serial Pins**, set RX to **3** and TX to **1** (`serial_rx` / `serial_tx`). **Serial2** is a different port and must not be used for this change. Leave Serial2 and backpack pins 18/5 unchanged. Save, verify CRSF reads 3/1, then power-cycle the module.
5. Plug in a data USB-C cable. The default is **115200 baud, 8N1**, verified on macOS with the Nomad CP2102 adapter. `Handset::open` explicitly deasserts DTR and RTS and returns an error if that fails. Other handset baud rates depend on adapter/driver support; 400000 did not work on the tested Mac.
6. Bind a compatible receiver and verify its RF settings. The RP3 bench setup uses **Normal / 2.4 GHz / LoRa 150 Hz**, Hybrid, telemetry 1:2. Changing bands can leave an incompatible DK packet rate selected. The library does not change these settings.

To put the module back in a radio, close the port, unplug USB, power-cycle from the XT30, and set both serial pins back to 4.

## Library

```rust
use nomad::{Handset, Options, Sticks};
use std::thread;
use std::time::Duration;

let mut handset = Handset::open("/dev/ttyACM0", Options::default())?;
let mut sticks = Sticks::disarmed();
loop {
    let telemetry = handset.poll(&sticks.to_crsf())?;
    if let Some(link) = telemetry.link.filter(|_| telemetry.link_is_fresh(Duration::from_secs(2))) {
        println!("{}% uplink", link.uplink_lq);
    }
    sticks.yaw = 0.2;
    thread::sleep(Duration::from_millis(10));
}
```

`Sticks` is AETR. Channel 3 is throttle and moves as soon as `poll` is running. Channel 5 stays low until `sticks.armed` is set. Channels 6–8 are the three switches. Channels 9–16 stay at 1500 µs.

The first `poll`, and another one every two seconds, sends a device ping. `Options::model_id` defaults to `None`, preserving the module’s model selection. Set it to `Some(id)` or call `set_model_id(id)` to deliberately select a model; `clear_model_id()` stops sending it. This changes the original 0.1 API: replace `model_id: 7` with `model_id: Some(7)`.

The module can take a few seconds to find the baud. Cached telemetry is not proof of a current link: use `link_age()` or `link_is_fresh(max_age)`. RSSI is decoded as signed dBm for the ExpressLRS 4.1 **TX-to-handset** stream, not the receiver-to-flight-controller format. ELRS Hybrid quantizes auxiliary switches and repurposes upper channels; the receiver does not receive 16 independent full-resolution controls.

Call `stop()` for checked shutdown: it writes the configured disarmed frames, reports I/O failures and prevents further `poll` calls. `Drop` and `into_inner` attempt the same write as a best effort, but cannot report failure. A close-frame write is not an acknowledgement from the receiver. Keep the process scheduled: a long pause looks like a lost radio. No software can guarantee a final disarm frame reaches a disconnected device.

Without the `serial` feature the crate is only the frame codec, so it can be used on top of an unbuffered `Read + Write` port with short read/write timeouts:

```rust
let mut handset = nomad::Handset::new(port, nomad::Options::default());
handset.poll(&nomad::Sticks::disarmed().to_crsf())?;
```

## Example

```bash
cargo test --manifest-path crates/nomad/Cargo.toml
cargo run --manifest-path crates/nomad/Cargo.toml --example send -- --list
cargo run --manifest-path crates/nomad/Cargo.toml --example send -- --port /dev/ttyACM0
```

`send` transmits disarmed, low-throttle sticks at 100 Hz and prints fresh link statistics. It does not arm. Use `--seconds 30` for a bounded run; Ctrl-C also requests checked shutdown. The example leaves model selection unchanged unless `--model ID` is passed. Stale statistics are labeled instead of being printed as current.

`poll` limits telemetry draining so continuous input cannot starve the next control cycle. The generic transport must bound each I/O operation itself; the library cannot interrupt an arbitrary blocking `Read` or `Write`. Avoid buffering adapters that require a flush per cycle. Handle any returned error by stopping the session rather than continuing to show old telemetry as live.

On Linux the user needs access to the tty device, usually through the `dialout` group. `--list` prints device paths. Enable the crate's `libudev` feature, and install `libudev`, when you also want the USB product name.
