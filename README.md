# Nomad Desk

Nomad Desk turns a computer into the handset for a [RadioMaster Nomad](https://radiomasterrc.com/products/nomad-gemini-xrossband-expresslrs-module) ExpressLRS module. Plug the module’s USB-C port into the computer, and the page sends stick positions as CRSF so the module can transmit them.

The Nomad ships with the handset on the module-bay pins (GPIO 4). USB-C is a separate serial port. One change on the module’s hardware page points that handset port at the USB pins. The steps are in the app’s Setup tab, and below.

## Run it

Chrome or Edge. Firefox and Safari cannot open the serial port.

```bash
npm install
npm test
npm run dev
```

Open [http://127.0.0.1:4747](http://127.0.0.1:4747).

On Linux, your user needs access to the tty device (the `dialout` group is the usual way). Restart the browser after that.

## Point the Nomad at USB

1. Fit both antennas. Power the module from the XT30 with a 2S–4S pack. USB can run the processor. It cannot feed the 1 W amplifiers.
2. Leave the module out of a radio, with USB unplugged from the computer. After about a minute it opens Wi-Fi: `ExpressLRS TX` / `expresslrs`.
3. Open [http://10.0.0.1/hardware.html](http://10.0.0.1/hardware.html). Write down the current serial pins.
4. Set `serial_rx` to **3** and `serial_tx` to **1**. Factory Nomad values are 4 and 4. Leave the backpack pins at 18 and 5. Do not change the radio SPI pins or the power table. Save.
5. On the main Wi-Fi page, confirm the binding phrase matches the receiver. Packet rate and RF power stay there. This app does not change them.

Use a data USB-C cable. In the app, choose **400000** baud. That is the handset rate. 420000 is the receiver-to-flight-controller rate, and 460800 is the old USB telemetry rate. The module will not lock to either of those.

The module may take a few seconds to find the baud. Link statistics appear when it answers.

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

Packets go out at the rate you pick (50, 100, or 200 Hz). A model-id command and a device ping go out every two seconds. Model id only matters when model match is enabled on the module.

## Flying it

Channel 3 is live throttle as soon as the link is running. Arming requires the props-off confirmation, throttle under 1100 µs, and a reply from the module. Hold the arm button. Escape, or Disarm, drops channel 5 immediately. Stop link sends a few disarmed frames, then stops. A bound receiver failsafes when the packets stop.

Keep the tab in the foreground. Browsers slow timers in background tabs, and the receiver will treat that as a lost radio.

## Put the module back in a radio

Stop the link and unplug USB. A running handset keeps Wi-Fi from starting. Power-cycle from the XT30, wait for `ExpressLRS TX`, and set `serial_rx` and `serial_tx` back to 4.

## Develop

```bash
npm test
npm run lint
```

`src/lib/crsf.ts` builds the frames. The tests check the CRC against EdgeTX’s DVB-S2 table and round-trip the 16 channels.
