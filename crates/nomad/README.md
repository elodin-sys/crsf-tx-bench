# nomad

A Rust handset for a [RadioMaster Nomad](https://radiomasterrc.com/products/nomad-gemini-xrossband-expresslrs-module). It writes CRSF channel frames to the module's USB-C serial port and reads link telemetry back.

The Nomad ships with the handset on the module-bay pin (GPIO 4). USB-C is a separate serial port until the hardware page points the handset UART at the USB pins.

## Hardware

1. Fit both antennas. Power the module from the XT30 with a 2S–4S pack. USB can run the processor. It cannot feed the 1 W amplifiers.
2. Leave the module out of a radio, with USB unplugged. After about a minute it opens Wi-Fi: `ExpressLRS TX` / `expresslrs`.
3. Open [http://10.0.0.1/hardware.html](http://10.0.0.1/hardware.html) and write down the current serial pins.
4. Set `serial_rx` to **3** and `serial_tx` to **1**. Factory values are 4 and 4. Leave the backpack pins at 18 and 5. Save.
5. Plug in a data USB-C cable. The port is 8N1. **400000** baud is the handset rate.

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
    if let Some(link) = telemetry.link {
        println!("{}% uplink", link.uplink_lq);
    }
    sticks.yaw = 0.2;
    thread::sleep(Duration::from_millis(10));
}
```

`Sticks` is AETR. Channel 3 is throttle and moves as soon as `poll` is running. Channel 5 stays low until `sticks.armed` is set. Channels 6–8 are the three switches. Channels 9–16 stay at 1500 µs.

The first `poll`, and another one every two seconds, also sends the model-id command and a device ping. The module can take a few seconds to find the baud. Link statistics show up on `Telemetry` when it answers.

Dropping `Handset`, or calling `into_inner`, writes three disarmed frames first. A bound receiver failsafes when the packets stop. Keep the process scheduled: a long pause looks like a lost radio.

Without the `serial` feature the crate is only the frame codec, so it can be used on top of any `Read + Write` port:

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

`send` transmits disarmed, low-throttle sticks at 100 Hz and prints uplink quality. It does not arm. Ctrl-C sends the closing disarmed frames.

On Linux the user needs access to the tty device, usually through the `dialout` group. `--list` prints device paths. Enable the crate's `libudev` feature, and install `libudev`, when you also want the USB product name.
