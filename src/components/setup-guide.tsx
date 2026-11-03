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
              Set <span className="font-medium">serial_rx</span> to 3 and{" "}
              <span className="font-medium">serial_tx</span> to 1. Leave the
              backpack pins at 18 and 5, and do not touch the radio SPI pins
              or the power table. Save. The module reboots.
            </li>
            <li>
              On the main Wi-Fi page, confirm the binding phrase matches the
              receiver. Packet rate and RF power live there too. This desk
              does not change them.
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
              Use a data USB-C cable. On the Fly tab, choose 400000 baud and
              press Connect Nomad. The handset port locks to 115200, 400000,
              921600, 1.87M, 2.25M, 3.75M, or 5.25M. 400000 is the rate a radio
              uses. 420000 is the receiver-to-flight-controller rate, and
              460800 is the old USB telemetry rate. Neither of those will lock.
            </p>
            <p>
              Start link sends channel packets about 100 times a second, plus
              a model-id command and a device ping every two seconds. The
              module may take several seconds to find the baud. When it
              answers, the link panel fills in.
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
