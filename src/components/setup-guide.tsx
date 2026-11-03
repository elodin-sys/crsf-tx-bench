import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function SetupGuide() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Point the handset port at USB-C</CardTitle>
          <CardDescription>
            The Nomad is an ExpressLRS module. Out of the box its USB-C socket
            is a telemetry port, and the radio bay is the handset. One hardware
            change makes the computer the radio.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed">
          <ol className="list-decimal space-y-3 pl-4">
            <li>
              Fit both antennas. Power the module from the XT30 with a 2S–4S
              pack. USB can run the processor, and it cannot feed the 1 W
              amplifiers.
            </li>
            <li>
              Leave it out of the radio, with no USB cable to the computer.
              After about a minute it opens a Wi-Fi network named{" "}
              <span className="font-mono text-foreground">ExpressLRS TX</span>,
              password{" "}
              <span className="font-mono text-foreground">expresslrs</span>.
            </li>
            <li>
              Join that network and open{" "}
              <span className="font-mono text-foreground">
                http://10.0.0.1/hardware.html
              </span>
              . Write down the current serial pins before you change anything.
            </li>
            <li>
              In <span className="font-medium">CRSF Serial Pins</span>, set RX
              to 3 and TX to 1 (<span className="font-mono">serial_rx</span> /
              <span className="font-mono">serial_tx</span>). Verify this section,
              not Serial2, reads 3/1 after saving. Leave Serial2 and the
              backpack pins at 18 and 5, and do not touch the radio SPI pins
              or the power table. Save. The module reboots.
            </li>
            <li>
              On the main Wi-Fi page, confirm the binding phrase matches the
              receiver, or use the module and receiver binding controls. For
              an RP3, use Normal link mode, the 2.4 GHz band and a compatible
              LoRa rate such as 150 Hz. Selecting the band alone can leave an
              incompatible DK rate selected. This desk does not change RF settings.
            </li>
          </ol>
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/60 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Hardware field</th>
                  <th className="px-3 py-2 font-medium">Factory Nomad</th>
                  <th className="px-3 py-2 font-medium">USB control</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                <tr className="border-t">
                  <td className="px-3 py-2">serial_rx</td>
                  <td className="px-3 py-2">4</td>
                  <td className="px-3 py-2 text-primary">3</td>
                </tr>
                <tr className="border-t">
                  <td className="px-3 py-2">serial_tx</td>
                  <td className="px-3 py-2">4</td>
                  <td className="px-3 py-2 text-primary">1</td>
                </tr>
                <tr className="border-t">
                  <td className="px-3 py-2">backpack rx / tx</td>
                  <td className="px-3 py-2">18 / 5</td>
                  <td className="px-3 py-2">leave</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Connect from this page</CardTitle>
            <CardDescription>
              Chrome or Edge. Firefox and Safari cannot open the serial port.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed">
            <p>
              Use a data USB-C cable. Start with 115200 baud, the rate verified
              on the Nomad&apos;s CP2102 USB adapter on macOS. Connect Nomad
              releases DTR and RTS so they do not hold the module in reset.
              Other handset rates are available for adapters that support them;
              400000 did not work on the tested Mac. 420000 is the receiver-side
              rate and is not a handset option.
            </p>
            <p>
              Start link sends channel packets about 100 times a second, plus
              a device ping every two seconds. Sending a model ID is optional
              and off by default, preserving the module&apos;s current model. The
              module may take several seconds to find the baud. When it
              answers, the link panel fills in. A module reply confirms USB
              communication; receiver RF reception is a separate check.
            </p>
            <p>
              On Linux, your user needs permission for the tty device, usually
              by being in the <span className="font-mono">dialout</span> group.
              Then restart the browser.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Put the module back in a radio</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed">
            <p>
              Stop the link and unplug USB. A running handset keeps the module
              out of Wi-Fi. Power-cycle from the XT30, wait for{" "}
              <span className="font-mono text-foreground">ExpressLRS TX</span>,
              and set serial_rx and serial_tx back to 4. Save.
            </p>
            <p>
              While the link is running, channel 3 is real throttle and
              channel 5 is the arm switch. Disarm, or Stop link, before you
              walk away. Stopping the packets makes a bound receiver failsafe.
              Keep this tab in the foreground. Browsers slow timers in
              background tabs, and that also looks like a lost radio.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
