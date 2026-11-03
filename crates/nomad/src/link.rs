//! A handset session over a full-duplex byte stream.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use crate::crsf::{build_model_id_frame, build_ping_frame, build_rc_frame, Parser, DEFAULT_BAUD};
use crate::error::Error;
use crate::sticks::Sticks;
use crate::telemetry::Telemetry;

/// Serial settings and optional model selection.
#[derive(Clone, Debug)]
pub struct Options {
    /// Serial baud. Defaults to 115200, verified on the Nomad USB-C CP2102 link.
    ///
    /// The module locks to 115200, 400000, 921600, 1870000, or 2250000.
    /// 420000 and 460800 will not lock.
    pub baud_rate: u32,
    /// Optional model id to announce. `None` preserves the module's selection.
    /// Explicit ids are clamped to 0..=63.
    pub model_id: Option<u8>,
    /// How often to add a device ping and, if selected, a model-id command.
    pub extra_every: Duration,
    /// Write three disarmed frames when the session is dropped or closed.
    pub failsafe_on_drop: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            baud_rate: DEFAULT_BAUD,
            model_id: None,
            extra_every: Duration::from_secs(2),
            failsafe_on_drop: true,
        }
    }
}

/// Sends RC frames and collects telemetry on `port`.
///
/// `poll` writes one RC frame and periodically a ping (plus a model-id command
/// only if requested), then reads a bounded amount of pending telemetry.
/// The port must be unbuffered and have bounded read/write timeouts; `poll` does
/// not flush each cycle. A blocking custom stream can still block inside an I/O call.
///
/// On drop, three disarmed frames are written unless [`Options::failsafe_on_drop`]
/// is false. Channel 3 of that frame is low throttle and channel 5 is disarmed.
pub struct Handset<P: Write> {
    port: Option<P>,
    parser: Parser,
    telemetry: Telemetry,
    model_id: Option<u8>,
    extra_every: Duration,
    last_extra: Option<Instant>,
    failsafe: Option<[u16; 16]>,
    stopped: bool,
}

impl<P: Read + Write> Handset<P> {
    /// Wrap an already-open, unbuffered full-duplex port.
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
            model_id: options.model_id.map(|id| id.min(63)),
            extra_every: options.extra_every,
            last_extra: None,
            failsafe,
            stopped: false,
        }
    }

    /// Change the model id used by later command frames.
    pub fn set_model_id(&mut self, model_id: u8) {
        self.model_id = Some(model_id.min(63));
        self.last_extra = None;
    }

    /// Stop announcing a model id, preserving the module's current selection.
    pub fn clear_model_id(&mut self) {
        self.model_id = None;
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

    /// Best-effort close and return the port. Call [`Self::stop`] first if close
    /// errors must be observed. Failed close writes cannot guarantee delivery.
    pub fn into_inner(mut self) -> P {
        let _ = self.stop();
        self.port.take().expect("handset port is still open")
    }

    fn write_cycle(&mut self, channels: &[u16; 16]) -> Result<(), Error> {
        if self.stopped {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotConnected,
                "handset is stopped",
            )
            .into());
        }
        let now = Instant::now();
        let send_extra = match self.last_extra {
            None => true,
            Some(then) => now.duration_since(then) >= self.extra_every,
        };
        self.write_all(&build_rc_frame(channels))?;
        if send_extra {
            if let Some(model_id) = self.model_id {
                self.write_all(&build_model_id_frame(model_id))?;
            }
            self.write_all(&build_ping_frame())?;
            self.last_extra = Some(now);
        }
        Ok(())
    }

    fn write_all(&mut self, bytes: &[u8]) -> Result<(), Error> {
        write_bounded(self.port()?, bytes)?;
        Ok(())
    }

    fn drain(&mut self) -> Result<(), Error> {
        let mut buf = [0u8; 256];
        let started = Instant::now();
        for attempt in 0..16 {
            if attempt > 0 && started.elapsed() >= Duration::from_millis(2) {
                break;
            }
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
    /// Stop this session, writing and flushing its configured closing frames once.
    ///
    /// Returns the first I/O failure. The session stays stopped even on error:
    /// a disconnected port cannot guarantee that a disarm frame was delivered.
    /// Later calls are no-ops, and subsequent `poll` calls fail.
    pub fn stop(&mut self) -> Result<(), Error> {
        if self.stopped {
            return Ok(());
        }
        self.stopped = true;
        let Some(channels) = self.failsafe.take() else {
            return Ok(());
        };
        let Some(port) = self.port.as_mut() else {
            return Ok(());
        };
        let frame = build_rc_frame(&channels);
        for _ in 0..3 {
            write_bounded(port, &frame)?;
        }
        port.flush()?;
        Ok(())
    }
}

// Unlike Write::write_all, repeated Interrupted errors cannot spin forever.
// The custom port still has to bound the duration of each individual call.
fn write_bounded(port: &mut impl Write, mut bytes: &[u8]) -> std::io::Result<()> {
    for _ in 0..128 {
        match port.write(bytes) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "serial write made no progress",
                ))
            }
            Ok(n) => {
                bytes = &bytes[n..];
                if bytes.is_empty() {
                    return Ok(());
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
            Err(err) => return Err(err),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        "serial write retry budget exhausted",
    ))
}

impl<P: Write> Drop for Handset<P> {
    fn drop(&mut self) {
        let _ = self.stop();
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
        if !crate::crsf::is_handset_baud(options.baud_rate) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "unsupported ExpressLRS handset baud rate",
            )
            .into());
        }
        let mut port = serialport::new(path, options.baud_rate)
            .data_bits(serialport::DataBits::Eight)
            .parity(serialport::Parity::None)
            .stop_bits(serialport::StopBits::One)
            .flow_control(serialport::FlowControl::None)
            .dtr_on_open(false)
            .timeout(Duration::from_millis(1))
            .open()?;
        // The USB bridge connects these modem signals to ESP32 boot/reset.
        // Drivers may assert RTS on open even when DTR-on-open is disabled.
        port.write_data_terminal_ready(false)?;
        port.write_request_to_send(false)?;
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
        let payload = [176, 0, 95, 0xfe, 1, 4, 5, 186, 90, 5];
        let reply = build_frame(CRSF_FRAMETYPE_LINK_STATISTICS, &payload, CRSF_SYNC).unwrap();
        let port = MemPort::new(&reply);
        let written = Arc::clone(&port.written);
        let options = Options {
            model_id: Some(7),
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
    #[derive(Clone, Copy, Default)]
    enum ReadBehavior {
        #[default]
        Empty,
        Timeout,
        Interrupted,
        Continuous,
        Eof,
        Failed,
    }

    #[derive(Default)]
    struct FaultPort {
        read_behavior: ReadBehavior,
        reads: usize,
        writes: usize,
        flushes: usize,
        written: Vec<u8>,
        max_write: Option<usize>,
        interrupts: usize,
        fail_write: bool,
        fail_flush: bool,
    }

    impl Read for FaultPort {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.reads += 1;
            match self.read_behavior {
                ReadBehavior::Empty => Err(io::ErrorKind::WouldBlock.into()),
                ReadBehavior::Timeout => Err(io::ErrorKind::TimedOut.into()),
                ReadBehavior::Interrupted => Err(io::ErrorKind::Interrupted.into()),
                ReadBehavior::Failed => Err(io::ErrorKind::BrokenPipe.into()),
                ReadBehavior::Eof => Ok(0),
                ReadBehavior::Continuous => {
                    buf.fill(0);
                    Ok(buf.len())
                }
            }
        }
    }

    impl Write for FaultPort {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.writes += 1;
            if self.fail_write {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            if self.interrupts > 0 {
                self.interrupts -= 1;
                return Err(io::ErrorKind::Interrupted.into());
            }
            let n = self.max_write.unwrap_or(buf.len()).min(buf.len());
            self.written.extend_from_slice(&buf[..n]);
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.flushes += 1;
            if self.fail_flush {
                Err(io::ErrorKind::TimedOut.into())
            } else {
                Ok(())
            }
        }
    }

    fn io_kind(error: Error) -> io::ErrorKind {
        match error {
            Error::Io(error) => error.kind(),
            #[cfg(feature = "serial")]
            Error::Serial(error) => panic!("unexpected serial error {error}"),
        }
    }

    #[test]
    fn model_selection_is_opt_in_and_changes_take_effect_next_poll() {
        let port = MemPort::new(&[]);
        let written = Arc::clone(&port.written);
        let mut handset = Handset::new(
            port,
            Options {
                extra_every: Duration::ZERO,
                ..Options::default()
            },
        );
        let channels = Sticks::disarmed().to_crsf();
        handset.poll(&channels).unwrap();
        let bytes = written.lock().unwrap().drain(..).collect::<Vec<_>>();
        let frames = Parser::new().push(&bytes);
        assert_eq!(
            frames.iter().map(|f| f.ty).collect::<Vec<_>>(),
            [CRSF_FRAMETYPE_RC_CHANNELS, CRSF_FRAMETYPE_DEVICE_PING]
        );
        handset.set_model_id(7);
        handset.poll(&channels).unwrap();
        let bytes = written.lock().unwrap().drain(..).collect::<Vec<_>>();
        assert!(Parser::new()
            .push(&bytes)
            .iter()
            .any(|f| f.ty == CRSF_FRAMETYPE_COMMAND && f.payload[4] == 7));
        handset.clear_model_id();
        handset.poll(&channels).unwrap();
        let bytes = written.lock().unwrap().drain(..).collect::<Vec<_>>();
        assert!(Parser::new()
            .push(&bytes)
            .iter()
            .all(|f| f.ty != CRSF_FRAMETYPE_COMMAND));
    }

    #[test]
    fn a_continuous_stream_or_interrupts_cannot_starve_the_next_control_cycle() {
        for read_behavior in [ReadBehavior::Continuous, ReadBehavior::Interrupted] {
            let port = FaultPort {
                read_behavior,
                ..FaultPort::default()
            };
            let mut handset = Handset::new(port, Options::default());
            handset.poll(&Sticks::disarmed().to_crsf()).unwrap();
            let port = handset.port.as_ref().unwrap();
            assert!((1..=16).contains(&port.reads));
            assert_eq!(
                port.flushes, 0,
                "poll must not wait for a serial queue drain"
            );
        }
    }

    #[test]
    fn short_writes_and_transient_interrupts_preserve_complete_frames() {
        let port = FaultPort {
            max_write: Some(1),
            interrupts: 3,
            ..FaultPort::default()
        };
        let mut handset = Handset::new(port, Options::default());
        handset.poll(&Sticks::disarmed().to_crsf()).unwrap();
        let port = handset.port.as_ref().unwrap();
        let frames = Parser::new().push(&port.written);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].ty, CRSF_FRAMETYPE_RC_CHANNELS);
        assert_eq!(frames[1].ty, CRSF_FRAMETYPE_DEVICE_PING);
    }

    #[test]
    fn writes_with_no_progress_or_permanent_failure_are_errors() {
        for (port, expected) in [
            (
                FaultPort {
                    max_write: Some(0),
                    ..FaultPort::default()
                },
                io::ErrorKind::WriteZero,
            ),
            (
                FaultPort {
                    fail_write: true,
                    ..FaultPort::default()
                },
                io::ErrorKind::BrokenPipe,
            ),
            (
                FaultPort {
                    interrupts: usize::MAX,
                    ..FaultPort::default()
                },
                io::ErrorKind::TimedOut,
            ),
        ] {
            let mut handset = Handset::new(port, Options::default());
            let error = handset.poll(&Sticks::disarmed().to_crsf()).unwrap_err();
            assert_eq!(io_kind(error), expected);
            assert!(handset.port.as_ref().unwrap().writes <= 128);
        }
    }

    #[test]
    fn a_quiet_port_is_not_a_disconnected_port() {
        for read_behavior in [ReadBehavior::Empty, ReadBehavior::Timeout] {
            let mut handset = Handset::new(
                FaultPort {
                    read_behavior,
                    ..FaultPort::default()
                },
                Options::default(),
            );
            assert!(handset.poll(&Sticks::disarmed().to_crsf()).is_ok());
        }
        for (read_behavior, expected) in [
            (ReadBehavior::Eof, io::ErrorKind::UnexpectedEof),
            (ReadBehavior::Failed, io::ErrorKind::BrokenPipe),
        ] {
            let mut handset = Handset::new(
                FaultPort {
                    read_behavior,
                    ..FaultPort::default()
                },
                Options::default(),
            );
            assert_eq!(
                io_kind(handset.poll(&Sticks::disarmed().to_crsf()).unwrap_err()),
                expected
            );
        }
    }

    #[test]
    fn stop_reports_failures_once_and_prevents_further_control_writes() {
        for (port, expected) in [
            (
                FaultPort {
                    fail_write: true,
                    ..FaultPort::default()
                },
                io::ErrorKind::BrokenPipe,
            ),
            (
                FaultPort {
                    fail_flush: true,
                    ..FaultPort::default()
                },
                io::ErrorKind::TimedOut,
            ),
        ] {
            let mut handset = Handset::new(port, Options::default());
            assert_eq!(io_kind(handset.stop().unwrap_err()), expected);
            let calls = handset.port.as_ref().unwrap().writes;
            handset.stop().unwrap();
            assert_eq!(
                io_kind(handset.poll(&Sticks::disarmed().to_crsf()).unwrap_err()),
                io::ErrorKind::NotConnected
            );
            assert_eq!(handset.port.as_ref().unwrap().writes, calls);
            let port = handset.into_inner();
            assert_eq!(
                port.writes, calls,
                "returning the port must not resend closing frames"
            );
        }
    }

    #[test]
    fn normal_stop_sends_exactly_three_configured_frames() {
        let mut handset = Handset::new(FaultPort::default(), Options::default());
        let mut closing = Sticks::disarmed().to_crsf();
        closing[5] = crate::us_to_crsf(1000);
        handset.set_failsafe(Some(closing));
        handset.stop().unwrap();
        handset.stop().unwrap();
        let port = handset.into_inner();
        let frames = Parser::new().push(&port.written);
        assert_eq!(frames.len(), 3);
        assert!(frames
            .iter()
            .all(|frame| crate::unpack_channels(&frame.payload) == closing));
        assert_eq!(port.flushes, 1);
    }

    #[test]
    fn disabling_closing_frames_does_not_disable_stopping() {
        let mut handset = Handset::new(
            FaultPort::default(),
            Options {
                failsafe_on_drop: false,
                ..Options::default()
            },
        );
        handset.stop().unwrap();
        assert!(handset.poll(&Sticks::disarmed().to_crsf()).is_err());
        let port = handset.into_inner();
        assert_eq!(port.writes, 0);
        assert_eq!(port.flushes, 0);
    }

    #[cfg(feature = "serial")]
    #[test]
    fn unsupported_baud_is_rejected_before_opening_a_device() {
        let error = match Handset::open(
            "a-device-that-does-not-exist",
            Options {
                baud_rate: 420_000,
                ..Options::default()
            },
        ) {
            Ok(_) => panic!("unsupported baud accepted"),
            Err(error) => error,
        };
        assert_eq!(io_kind(error), io::ErrorKind::InvalidInput);
    }
}
