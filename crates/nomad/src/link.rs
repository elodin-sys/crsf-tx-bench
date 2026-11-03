//! A handset session over a full-duplex byte stream.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use crate::crsf::{build_model_id_frame, build_ping_frame, build_rc_frame, Parser, DEFAULT_BAUD};
use crate::error::Error;
use crate::sticks::Sticks;
use crate::telemetry::Telemetry;

/// How often to talk, and which model id to announce.
#[derive(Clone, Debug)]
pub struct Options {
    /// Serial baud. 400000 is the rate a radio uses.
    ///
    /// The module locks to 115200, 400000, 921600, 1870000, or 2250000.
    /// 420000 and 460800 will not lock.
    pub baud_rate: u32,
    /// Model id sent with the command frame. Clamped to 0..=63.
    pub model_id: u8,
    /// How often to add a model-id command and a device ping to the RC frame.
    pub extra_every: Duration,
    /// Write three disarmed frames when the session is dropped or closed.
    pub failsafe_on_drop: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            baud_rate: DEFAULT_BAUD,
            model_id: 0,
            extra_every: Duration::from_secs(2),
            failsafe_on_drop: true,
        }
    }
}

/// Sends RC frames and collects telemetry on `port`.
///
/// `poll` writes one RC frame, and every `extra_every` also writes the model-id
/// command and a ping, then reads whatever the module has already sent.
/// The port's read timeout is how long `poll` waits when no bytes are waiting.
///
/// On drop, three disarmed frames are written unless [`Options::failsafe_on_drop`]
/// is false. Channel 3 of that frame is low throttle and channel 5 is disarmed.
pub struct Handset<P: Write> {
    port: Option<P>,
    parser: Parser,
    telemetry: Telemetry,
    model_id: u8,
    extra_every: Duration,
    last_extra: Option<Instant>,
    failsafe: Option<[u16; 16]>,
}

impl<P: Read + Write> Handset<P> {
    /// Wrap an already-open full-duplex port.
    ///
    /// Set a short read timeout on the port. A timeout of about a millisecond
    /// keeps `poll` from stalling the packet rate when the module is quiet.
    #[must_use]
    pub fn new(port: P, options: Options) -> Self {
        let failsafe = options
            .failsafe_on_drop
            .then(|| Sticks::disarmed().to_crsf());
        Self {
            port: Some(port),
            parser: Parser::new(),
            telemetry: Telemetry::new(),
            model_id: options.model_id.min(63),
            extra_every: options.extra_every,
            last_extra: None,
            failsafe,
        }
    }

    /// Change the model id used by later command frames.
    pub fn set_model_id(&mut self, model_id: u8) {
        self.model_id = model_id.min(63);
    }

    /// Replace the frame written on close. `None` disables that write.
    pub fn set_failsafe(&mut self, channels: Option<[u16; 16]>) {
        self.failsafe = channels;
    }

    /// Telemetry received so far.
    #[must_use]
    pub fn telemetry(&self) -> &Telemetry {
        &self.telemetry
    }

    /// Write one control cycle for `channels` (11-bit CRSF units) and fold in any reply.
    pub fn poll(&mut self, channels: &[u16; 16]) -> Result<&Telemetry, Error> {
        self.write_cycle(channels)?;
        self.drain()?;
        Ok(&self.telemetry)
    }

    /// Write disarmed frames, if configured, and give the port back.
    pub fn into_inner(mut self) -> P {
        self.shutdown();
        self.port.take().expect("handset port is still open")
    }

    fn write_cycle(&mut self, channels: &[u16; 16]) -> Result<(), Error> {
        let now = Instant::now();
        let send_extra = match self.last_extra {
            None => true,
            Some(then) => now.duration_since(then) >= self.extra_every,
        };
        self.write_all(&build_rc_frame(channels))?;
        if send_extra {
            self.write_all(&build_model_id_frame(self.model_id))?;
            self.write_all(&build_ping_frame())?;
            self.last_extra = Some(now);
        }
        self.port()?.flush()?;
        Ok(())
    }

    fn write_all(&mut self, bytes: &[u8]) -> Result<(), Error> {
        self.port()?.write_all(bytes)?;
        Ok(())
    }

    fn drain(&mut self) -> Result<(), Error> {
        let mut buf = [0u8; 256];
        loop {
            let read = {
                let port = self.port()?;
                match port.read(&mut buf) {
                    Ok(0) => {
                        return Err(Error::Io(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "serial port closed",
                        )))
                    }
                    Ok(n) => n,
                    Err(err)
                        if err.kind() == std::io::ErrorKind::TimedOut
                            || err.kind() == std::io::ErrorKind::WouldBlock =>
                    {
                        break;
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(err) => return Err(err.into()),
                }
            };
            for frame in self.parser.push(&buf[..read]) {
                self.telemetry.note(&frame);
            }
        }
        Ok(())
    }

    fn port(&mut self) -> Result<&mut P, Error> {
        self.port.as_mut().ok_or_else(|| {
            Error::Io(std::io::Error::new(
                std::io::ErrorKind::NotConnected,
                "serial port is closed",
            ))
        })
    }
}

impl<P: Write> Handset<P> {
    fn shutdown(&mut self) {
        let Some(channels) = self.failsafe.take() else {
            return;
        };
        let frame = build_rc_frame(&channels);
        if let Some(port) = self.port.as_mut() {
            for _ in 0..3 {
                let _ = port.write_all(&frame);
            }
            let _ = port.flush();
        }
    }
}

impl<P: Write> Drop for Handset<P> {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// A serial port the module is plugged into.
#[cfg(feature = "serial")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListedPort {
    /// Device path, such as `/dev/ttyACM0` or `COM3`.
    pub name: String,
    /// USB product name and ids, when the operating system knows them.
    pub description: String,
}

/// Serial ports the operating system can see.
#[cfg(feature = "serial")]
pub fn list_ports() -> Result<Vec<ListedPort>, Error> {
    let ports = serialport::available_ports()?;
    Ok(ports
        .into_iter()
        .map(|info| ListedPort {
            description: describe(&info.port_type),
            name: info.port_name,
        })
        .collect())
}

#[cfg(feature = "serial")]
fn describe(kind: &serialport::SerialPortType) -> String {
    match kind {
        serialport::SerialPortType::UsbPort(usb) => {
            let product = usb.product.as_deref().unwrap_or("USB serial");
            format!("{product} {:04x}:{:04x}", usb.vid, usb.pid)
        }
        serialport::SerialPortType::PciPort => "PCI serial".to_owned(),
        serialport::SerialPortType::BluetoothPort => "Bluetooth serial".to_owned(),
        serialport::SerialPortType::Unknown => "serial".to_owned(),
    }
}

#[cfg(feature = "serial")]
impl Handset<Box<dyn serialport::SerialPort>> {
    /// Open `path` at 8N1 with a 1 ms read timeout.
    ///
    /// The Nomad's USB-C port has to be the handset UART: `serial_rx` 3 and
    /// `serial_tx` 1 on the module hardware page. Power the radio from the XT30.
    pub fn open(path: &str, options: Options) -> Result<Self, Error> {
        let port = serialport::new(path, options.baud_rate)
            .data_bits(serialport::DataBits::Eight)
            .parity(serialport::Parity::None)
            .stop_bits(serialport::StopBits::One)
            .timeout(Duration::from_millis(1))
            .open()?;
        Ok(Self::new(port, options))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crsf::{build_frame, Parser};
    use crate::crsf::{
        CRSF_FRAMETYPE_COMMAND, CRSF_FRAMETYPE_DEVICE_PING, CRSF_FRAMETYPE_LINK_STATISTICS,
        CRSF_FRAMETYPE_RC_CHANNELS, CRSF_SYNC,
    };
    use std::collections::VecDeque;
    use std::io::{self, Read, Write};
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct MemPort {
        incoming: Arc<Mutex<VecDeque<u8>>>,
        written: Arc<Mutex<Vec<u8>>>,
    }

    impl MemPort {
        fn new(incoming: &[u8]) -> Self {
            Self {
                incoming: Arc::new(Mutex::new(incoming.iter().copied().collect())),
                written: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    impl Read for MemPort {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let mut incoming = self.incoming.lock().expect("lock");
            if incoming.is_empty() {
                return Err(io::Error::new(io::ErrorKind::WouldBlock, "empty"));
            }
            let n = buf.len().min(incoming.len());
            for slot in buf.iter_mut().take(n) {
                *slot = incoming.pop_front().expect("byte");
            }
            Ok(n)
        }
    }

    impl Write for MemPort {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.written.lock().expect("lock").extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn the_first_poll_sends_channels_model_id_and_ping_and_reads_the_reply() {
        let payload = [80, 0, 95, 0xfe, 1, 4, 5, 70, 90, 5];
        let reply = build_frame(CRSF_FRAMETYPE_LINK_STATISTICS, &payload, CRSF_SYNC).unwrap();
        let port = MemPort::new(&reply);
        let written = Arc::clone(&port.written);
        let options = Options {
            model_id: 7,
            ..Options::default()
        };
        let mut handset = Handset::new(port, options);
        let channels = Sticks::disarmed().to_crsf();
        let telemetry = handset.poll(&channels).unwrap();
        assert_eq!(telemetry.link.expect("link").uplink_lq, 95);

        let bytes = written.lock().expect("lock").clone();
        let types: Vec<u8> = Parser::new()
            .push(&bytes)
            .into_iter()
            .map(|frame| frame.ty)
            .collect();
        assert_eq!(
            types,
            [
                CRSF_FRAMETYPE_RC_CHANNELS,
                CRSF_FRAMETYPE_COMMAND,
                CRSF_FRAMETYPE_DEVICE_PING,
            ]
        );

        handset.poll(&channels).unwrap();
        let bytes = written.lock().expect("lock").clone();
        let types: Vec<u8> = Parser::new()
            .push(&bytes)
            .into_iter()
            .map(|frame| frame.ty)
            .collect();
        assert_eq!(
            types,
            [
                CRSF_FRAMETYPE_RC_CHANNELS,
                CRSF_FRAMETYPE_COMMAND,
                CRSF_FRAMETYPE_DEVICE_PING,
                CRSF_FRAMETYPE_RC_CHANNELS,
            ]
        );

        let port = handset.into_inner();
        let bytes = port.written.lock().expect("lock").clone();
        let frames = Parser::new().push(&bytes);
        assert_eq!(frames.len(), 7);
        assert!(frames[4..]
            .iter()
            .all(|frame| frame.ty == CRSF_FRAMETYPE_RC_CHANNELS));
        let disarmed = Sticks::disarmed().to_crsf();
        assert_eq!(crate::crsf::unpack_channels(&frames[6].payload), disarmed);
    }
}
