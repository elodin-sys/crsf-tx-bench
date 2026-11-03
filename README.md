# Nomad Desk

Nomad Desk turns a computer into the handset for a [RadioMaster Nomad](https://radiomasterrc.com/products/nomad-gemini-xrossband-expresslrs-module) ExpressLRS module. Plug the module’s USB-C port into the computer, and the page sends stick positions as CRSF so the module can transmit them.

The Nomad ships with the handset on the module-bay pins (GPIO 4). USB-C is a separate serial port. One change on the module’s hardware page points that handset port at the USB pins. The steps are in the app’s Setup tab, and below.

## Run it

Chrome or Edge. Firefox and Safari cannot open the serial port.

```bash
npm ci
npm test
npm run dev
```

Open [http://127.0.0.1:4747](http://127.0.0.1:4747).

On Linux, your user needs access to the tty device (the `dialout` group is the usual way). Restart the browser after that.

## Point the Nomad at USB

1. Fit both antennas. Power the module from the XT30 with a 2S–4S pack. USB can run the processor. It cannot feed the 1 W amplifiers.
2. Leave the module out of a radio, with USB unplugged from the computer. After about a minute it opens Wi-Fi: `ExpressLRS TX` / `expresslrs`.
3. Open [http://10.0.0.1/hardware.html](http://10.0.0.1/hardware.html). Write down the current serial pins.
4. Under **CRSF Serial Pins**, set RX to **3** and TX to **1** (`serial_rx` / `serial_tx`). Do not confuse this with **Serial2 Pins** (`serial1_rx` / `serial1_tx`). Factory CRSF values are 4 and 4. Leave Serial2, backpack pins 18/5, radio SPI pins, and the power table unchanged. Save, verify the CRSF section reads 3/1, then power-cycle and reconnect USB.
5. Bind the receiver using its supported procedure or matching binding configuration. Match the RF band, packet rate, and link mode to the receiver. For an RP3, the tested combination is **Normal / 2.4 GHz / LoRa 150 Hz**, Hybrid switches, telemetry 1:2. Switching bands can select an incompatible DK rate automatically; verify the packet rate afterward. This app does not change RF settings or binding configuration.

Use a data USB-C cable. The default is **115200 baud, 8N1**, verified with the Nomad CP2102 adapter on macOS. The app explicitly releases DTR and RTS after opening; these lines can otherwise hold the ESP32 in reset. 400000 is a common handset rate, but did not work on the tested Mac. Other offered rates depend on adapter/driver support. 420000 is a receiver-to-flight-controller rate, not a handset option.

The module may take a few seconds to find the baud. A module reply confirms the USB link; fresh RF statistics and receiver-side channel frames establish reception separately. An unbound receiver can enter Wi-Fi mode while waiting; restart it before a binding attempt.

## What is sent

Channel order is AETR.

| Channel | Control |
| --- | --- |
| 1 | Roll |
| 2 | Pitch |
| 3 | Throttle, low until you raise it |
| 4 | Yaw |
| 5 | Arm. Low until you hold Arm, then high |
| 6–8 | The three switches |
| 9–16 | Held at 1500 µs |

Packets go out at the rate you pick (50, 100, or 200 Hz). A device ping goes out on the first cycle and every two seconds. Sending a model ID is **opt-in**, so a normal session preserves the module’s model selection. Enable it only when you intend to select that model.

These are handset channel values. ELRS Hybrid quantizes auxiliary switches and uses upper channels for link diagnostics; it does not deliver 16 independent full-resolution controls to the receiver.

## Flying it

Channel 3 is live throttle as soon as the link is running. Arming requires the props-off confirmation, throttle under 1100 µs, and a reply from the module. Hold the arm button. Escape, or Disarm, drops channel 5 immediately. Stop link sends a few disarmed frames, then stops. A bound receiver failsafes when the packets stop.

Keep the tab in the foreground. Hiding it, losing gamepad input or changing input source stops the link and requests a low-throttle/disarmed closing pattern. Browser or USB failure can prevent delivery; receiver failsafe remains necessary. Browser timing is not deterministic.

## Put the module back in a radio

Stop the link and unplug USB. A running handset keeps Wi-Fi from starting. Power-cycle from the XT30, wait for `ExpressLRS TX`, and set `serial_rx` and `serial_tx` back to 4.

## Rust library

[`crates/nomad`](crates/nomad) is the same USB-C handset link as a Rust crate. It builds the CRSF frames, writes them to the serial port, and reads link telemetry back.

```bash
cargo test --manifest-path crates/nomad/Cargo.toml
cargo run --manifest-path crates/nomad/Cargo.toml --example send -- --list
cargo run --manifest-path crates/nomad/Cargo.toml --example send -- --port /dev/ttyACM0
```

The pin change above is required. `send` transmits disarmed sticks at 100 Hz and prints uplink quality. Ctrl-C writes three disarmed frames before the port closes.

## Develop

```bash
npm test
npm run lint
npm run typecheck
npm run build
cargo test --locked --manifest-path crates/nomad/Cargo.toml --all-targets
cargo test --locked --manifest-path crates/nomad/Cargo.toml --no-default-features
cargo test --locked --manifest-path crates/nomad/Cargo.toml --doc
```

`src/lib/crsf.ts` and `crates/nomad` implement the same handset protocol. Regression tests cover framing, corrupt-stream recovery, signed handset RSSI, malformed telemetry, stale data, input validation and serial lifecycle failures. GitHub Actions runs the browser checks and Rust checks on Linux, macOS and Windows, including Rust 1.83.

The RSSI decoder is specifically for the **TX-to-handset** stream: ExpressLRS 4.1 sends signed dBm there. Receiver-to-flight-controller RSSI uses a different representation. See the pinned [TX implementation](https://github.com/ExpressLRS/ExpressLRS/blob/4.1.0/src/src/tx_main.cpp) and [handset implementation](https://github.com/ExpressLRS/ExpressLRS/blob/4.1.0/src/lib/Handset/CRSFHandset.cpp). Bench connectivity is not RF-range or flight qualification.

## Bench validation, 2026-11-03

Tested on macOS with the Nomad CP2102 USB adapter, ExpressLRS TX 4.1.0,
an RP3 reported as 4.1.3, and independent receiver-channel capture on an Aleph.
The transmitter used 115200 baud and the RF settings above. All tests held
throttle and arm low; the autopilot remained disarmed.

- Opening, stopping and reopening the library session at requested 100/200 Hz
  delivered 3697 receiver frames across two 30-second runs, with no intermediate
  source loss. Both uplink and downlink LQ reached 100%.
- The corrected absolute-deadline scheduler produced 3000 polls in 30.011 s at
  requested 100 Hz. That run delivered 1849 receiver frames after RF acquisition,
  with no intermediate source loss. Handset cadence and RF packet rate differ.
- On each stop, the M7 entered failsafe 250–260 ms after its last observed
  accepted frame, measured with 20 ms receiver telemetry resolution.
- Reopening required baud search and RF reacquisition; a successful port open
  alone does not mean the receiver is connected. Shutdown writes are best effort
  if a driver or cable fails. No RF range, flight, or browser-hardware qualification
  is claimed by these native-library bench tests.
