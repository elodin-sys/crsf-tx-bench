//! Telemetry the module sends back down the handset port.

use std::time::{Duration, Instant};

use crate::crsf::{
    frame_type_name, RawFrame, CRSF_ADDRESS_BROADCAST, CRSF_ADDRESS_MODULE, CRSF_ADDRESS_RADIO,
    CRSF_FRAMETYPE_ATTITUDE, CRSF_FRAMETYPE_BATTERY, CRSF_FRAMETYPE_COMMAND,
    CRSF_FRAMETYPE_DEVICE_INFO, CRSF_FRAMETYPE_DEVICE_PING, CRSF_FRAMETYPE_FLIGHT_MODE,
    CRSF_FRAMETYPE_GPS, CRSF_FRAMETYPE_LINK_STATISTICS, CRSF_FRAMETYPE_RC_CHANNELS,
};

const TX_POWER_MW: [u16; 9] = [0, 10, 25, 100, 500, 1000, 2000, 250, 50];

/// Uplink and downlink figures from an ExpressLRS TX-to-handset frame.
///
/// RSSI bytes are signed dBm on this link. Receiver-to-flight-controller CRSF
/// uses positive magnitudes instead and is not this decoder's input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LinkStats {
    /// Uplink RSSI, dBm. Negative.
    pub uplink_rssi_dbm: i16,
    /// Uplink link quality, percent.
    pub uplink_lq: u8,
    /// Uplink signal to noise, dB.
    pub uplink_snr: i8,
    /// Downlink RSSI, dBm. Negative.
    pub downlink_rssi_dbm: i16,
    /// Downlink link quality, percent.
    pub downlink_lq: u8,
    /// Downlink signal to noise, dB.
    pub downlink_snr: i8,
    /// Transmitter power in milliwatts, when the index is one ExpressLRS publishes.
    pub tx_power_mw: Option<u16>,
    /// Active antenna, starting at 1.
    pub antenna: u8,
    /// RF mode index reported by the module.
    pub rf_mode: u8,
}

/// Battery sensor values.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Battery {
    /// Pack voltage.
    pub volts: f32,
    /// Current draw.
    pub amps: f32,
    /// Consumed charge.
    pub mah: u32,
    /// Remaining capacity, percent.
    pub remaining: u8,
}

/// Attitude in degrees.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Attitude {
    /// Pitch, degrees.
    pub pitch: f32,
    /// Roll, degrees.
    pub roll: f32,
    /// Yaw, degrees.
    pub yaw: f32,
}

/// GPS fix from a CRSF GPS frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Gps {
    /// Latitude, degrees.
    pub lat: f64,
    /// Longitude, degrees.
    pub lon: f64,
    /// Satellites in the fix.
    pub sats: u8,
}

/// A decoded frame. RC channel echoes stay raw so a caller can see them without mixing them into telemetry.
#[derive(Clone, Debug, PartialEq)]
pub enum Message {
    /// Sixteen 11-bit channels.
    Channels([u16; 16]),
    /// Link statistics.
    Link(LinkStats),
    /// Battery.
    Battery(Battery),
    /// Attitude.
    Attitude(Attitude),
    /// Flight mode name.
    FlightMode(String),
    /// Device name from a device-info reply.
    DeviceInfo(String),
    /// GPS.
    Gps(Gps),
    /// A frame this crate does not decode further.
    Other(RawFrame),
}

impl RawFrame {
    /// Decode a parsed frame into a [`Message`].
    #[must_use]
    pub fn decode(&self) -> Message {
        match self.ty {
            CRSF_FRAMETYPE_RC_CHANNELS if self.payload.len() >= 22 => {
                Message::Channels(crate::crsf::unpack_channels(&self.payload))
            }
            CRSF_FRAMETYPE_LINK_STATISTICS if self.payload.len() >= 10 => {
                Message::Link(decode_link(&self.payload))
            }
            CRSF_FRAMETYPE_BATTERY if self.payload.len() >= 8 => Message::Battery(Battery {
                volts: f32::from(unsigned16(&self.payload, 0)) / 10.0,
                amps: f32::from(unsigned16(&self.payload, 2)) / 10.0,
                mah: (u32::from(self.payload[4]) << 16)
                    | (u32::from(self.payload[5]) << 8)
                    | u32::from(self.payload[6]),
                remaining: self.payload[7],
            }),
            CRSF_FRAMETYPE_ATTITUDE if self.payload.len() >= 6 => Message::Attitude(Attitude {
                pitch: radians_to_degrees(signed16(&self.payload, 0)),
                roll: radians_to_degrees(signed16(&self.payload, 2)),
                yaw: radians_to_degrees(signed16(&self.payload, 4)),
            }),
            CRSF_FRAMETYPE_FLIGHT_MODE => c_string(&self.payload, 0)
                .map(Message::FlightMode)
                .unwrap_or_else(|| Message::Other(self.clone())),
            CRSF_FRAMETYPE_DEVICE_INFO => device_name(&self.payload)
                .map(Message::DeviceInfo)
                .unwrap_or_else(|| Message::Other(self.clone())),
            CRSF_FRAMETYPE_GPS if self.payload.len() >= 15 => Message::Gps(Gps {
                lat: f64::from(signed32(&self.payload, 0)) / 1e7,
                lon: f64::from(signed32(&self.payload, 4)) / 1e7,
                sats: self.payload[14],
            }),
            _ => Message::Other(self.clone()),
        }
    }
}

fn decode_link(payload: &[u8]) -> LinkStats {
    let power = usize::from(payload[6]);
    LinkStats {
        uplink_rssi_dbm: i16::from(payload[0] as i8),
        uplink_lq: payload[2],
        uplink_snr: payload[3] as i8,
        antenna: payload[4].saturating_add(1),
        rf_mode: payload[5],
        tx_power_mw: TX_POWER_MW.get(power).copied(),
        downlink_rssi_dbm: i16::from(payload[7] as i8),
        downlink_lq: payload[8],
        downlink_snr: payload[9] as i8,
    }
}

/// The latest telemetry heard from the module.
///
/// RC channel frames are ignored. Those are echoes of the frames this crate sends.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Telemetry {
    /// Last received link statistics; check [`Self::link_is_fresh`] before using them.
    pub link: Option<LinkStats>,
    /// Latest battery report.
    pub battery: Option<Battery>,
    /// Latest attitude.
    pub attitude: Option<Attitude>,
    /// Latest flight mode.
    pub flight_mode: Option<String>,
    /// Name from the module's device-info reply.
    pub device_name: Option<String>,
    /// Latest GPS fix.
    pub gps: Option<Gps>,
    /// Type byte of the last non-RC frame, if one has arrived.
    pub last_type: Option<u8>,
    /// Count of non-RC frames accepted so far.
    pub module_frames: u32,
    /// Arrival time of the last accepted non-echo telemetry frame.
    pub last_frame_at: Option<Instant>,
    /// Arrival time of the last valid link-statistics frame.
    pub last_link_at: Option<Instant>,
}

impl Telemetry {
    /// No frames received yet.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Name of the last non-RC frame, if one has arrived.
    #[must_use]
    pub fn last_frame_name(&self) -> Option<String> {
        self.last_type.map(frame_type_name)
    }

    /// Age of the last link-statistics frame, if any. Stored values do not expire
    /// automatically, so callers must check freshness separately from RF quality.
    #[must_use]
    pub fn link_age(&self) -> Option<Duration> {
        self.last_link_at.map(|at| at.elapsed())
    }

    /// Whether valid link statistics arrived within `max_age`.
    #[must_use]
    pub fn link_is_fresh(&self, max_age: Duration) -> bool {
        self.link.is_some() && self.link_age().is_some_and(|age| age <= max_age)
    }

    /// Fold one parsed frame into this state. Outgoing RC, ping and command
    /// echoes, and malformed known telemetry messages do not refresh it.
    pub fn note(&mut self, frame: &RawFrame) {
        self.note_at(frame, Instant::now());
    }

    fn note_at(&mut self, frame: &RawFrame, at: Instant) {
        if matches!(
            frame.ty,
            CRSF_FRAMETYPE_RC_CHANNELS | CRSF_FRAMETYPE_DEVICE_PING | CRSF_FRAMETYPE_COMMAND
        ) {
            return;
        }
        let message = frame.decode();
        if matches!(message, Message::Other(_))
            && matches!(
                frame.ty,
                CRSF_FRAMETYPE_LINK_STATISTICS
                    | CRSF_FRAMETYPE_BATTERY
                    | CRSF_FRAMETYPE_ATTITUDE
                    | CRSF_FRAMETYPE_FLIGHT_MODE
                    | CRSF_FRAMETYPE_DEVICE_INFO
                    | CRSF_FRAMETYPE_GPS
            )
        {
            return;
        }
        self.last_type = Some(frame.ty);
        self.last_frame_at = Some(at);
        self.module_frames = self.module_frames.saturating_add(1);
        match message {
            Message::Link(link) => {
                self.link = Some(link);
                self.last_link_at = Some(at);
            }
            Message::Battery(battery) => self.battery = Some(battery),
            Message::Attitude(attitude) => self.attitude = Some(attitude),
            Message::FlightMode(mode) => self.flight_mode = (!mode.is_empty()).then_some(mode),
            Message::DeviceInfo(name) if frame.payload[1] == CRSF_ADDRESS_MODULE => {
                self.device_name = Some(name)
            }
            Message::Gps(gps) => self.gps = Some(gps),
            Message::Channels(_) | Message::Other(_) | Message::DeviceInfo(_) => {}
        }
    }
}

fn unsigned16(payload: &[u8], offset: usize) -> u16 {
    u16::from(payload[offset]) << 8 | u16::from(payload[offset + 1])
}

fn signed16(payload: &[u8], offset: usize) -> i16 {
    unsigned16(payload, offset) as i16
}

fn signed32(payload: &[u8], offset: usize) -> i32 {
    (u32::from(payload[offset]) << 24
        | u32::from(payload[offset + 1]) << 16
        | u32::from(payload[offset + 2]) << 8
        | u32::from(payload[offset + 3])) as i32
}

fn c_string(payload: &[u8], start: usize) -> Option<String> {
    let bytes = payload.get(start..)?;
    let end = bytes.iter().position(|byte| *byte == 0)?;
    Some(String::from_utf8_lossy(&bytes[..end]).trim().to_owned())
}

fn device_name(payload: &[u8]) -> Option<String> {
    if !matches!(
        payload.first(),
        Some(&CRSF_ADDRESS_RADIO) | Some(&CRSF_ADDRESS_BROADCAST)
    ) {
        return None;
    }
    let bytes = payload.get(2..)?;
    let end = bytes.iter().position(|byte| *byte == 0)?;
    // Device info ends with serial, hardware and software versions (4 bytes
    // each), a parameter count and a parameter version, after the NUL name.
    if bytes.len() < end + 1 + 14 {
        return None;
    }
    c_string(payload, 2).filter(|name| !name.is_empty())
}

fn radians_to_degrees(raw: i16) -> f32 {
    (f32::from(raw) / 10_000.0) * (180.0 / std::f32::consts::PI)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crsf::{build_frame, CRSF_SYNC};

    #[test]
    fn link_statistics_are_stored_and_rc_echoes_are_ignored() {
        let payload = [176, 0, 95, 0xfe, 1, 4, 5, 186, 90, 5];
        let frame = RawFrame {
            sync: CRSF_SYNC,
            ty: CRSF_FRAMETYPE_LINK_STATISTICS,
            payload: payload.to_vec(),
        };
        let mut state = Telemetry::new();
        state.note(&frame);
        state.note(&RawFrame {
            sync: crate::crsf::CRSF_ADDRESS_MODULE,
            ty: CRSF_FRAMETYPE_RC_CHANNELS,
            payload: vec![0; 22],
        });
        assert_eq!(state.module_frames, 1);
        let link = state.link.expect("link");
        assert_eq!(link.uplink_rssi_dbm, -80);
        assert_eq!(link.uplink_lq, 95);
        assert_eq!(link.uplink_snr, -2);
        assert_eq!(link.tx_power_mw, Some(1000));
        assert_eq!(link.antenna, 2);
        assert_eq!(link.downlink_lq, 90);
        assert_eq!(state.last_frame_name().as_deref(), Some("Link statistics"));
    }

    #[test]
    fn a_built_link_frame_round_trips_through_the_parser() {
        let payload = [176, 0, 95, 0xfe, 1, 4, 5, 186, 90, 5];
        let bytes = build_frame(CRSF_FRAMETYPE_LINK_STATISTICS, &payload, CRSF_SYNC).unwrap();
        let frames = crate::crsf::Parser::new().push(&bytes);
        assert_eq!(frames.len(), 1);
        match frames[0].decode() {
            Message::Link(link) => assert_eq!(link.uplink_lq, 95),
            other => panic!("unexpected {other:?}"),
        }
    }
    fn raw(ty: u8, payload: &[u8]) -> RawFrame {
        RawFrame {
            sync: CRSF_ADDRESS_RADIO,
            ty,
            payload: payload.to_vec(),
        }
    }

    fn info(origin: u8, name: &str) -> RawFrame {
        let mut payload = vec![CRSF_ADDRESS_RADIO, origin];
        payload.extend_from_slice(name.as_bytes());
        payload.push(0);
        payload.extend_from_slice(&[0; 14]);
        raw(CRSF_FRAMETYPE_DEVICE_INFO, &payload)
    }

    #[test]
    fn handset_rssi_decodes_signed_bytes_including_the_physical_capture() {
        // Nomad 4.1.0 bench bytes: 193 and 243 mean -63 and -13 dBm.
        let frame = raw(
            CRSF_FRAMETYPE_LINK_STATISTICS,
            &[193, 0, 100, 0xff, 0, 24, 3, 243, 100, 0xf8],
        );
        let Message::Link(link) = frame.decode() else {
            panic!("link")
        };
        assert_eq!(link.uplink_rssi_dbm, -63);
        assert_eq!(link.downlink_rssi_dbm, -13);
        assert_eq!(link.uplink_snr, -1);
        assert_eq!(link.downlink_snr, -8);
        assert_eq!(link.rf_mode, 24);
        assert_eq!(link.tx_power_mw, Some(100));
        for (byte, expected) in [(0, 0), (128, -128), (255, -1)] {
            let Message::Link(link) = raw(
                CRSF_FRAMETYPE_LINK_STATISTICS,
                &[byte, 0, 0, 0, 0, 0, 255, byte, 0, 0],
            )
            .decode() else {
                panic!("link")
            };
            assert_eq!(link.uplink_rssi_dbm, expected);
            assert_eq!(link.downlink_rssi_dbm, expected);
            assert_eq!(link.tx_power_mw, None);
        }
    }

    #[test]
    fn echoes_and_truncated_telemetry_do_not_prove_a_live_module() {
        let mut state = Telemetry::new();
        for frame in [
            raw(CRSF_FRAMETYPE_RC_CHANNELS, &[0; 22]),
            raw(CRSF_FRAMETYPE_DEVICE_PING, &[0, CRSF_ADDRESS_RADIO]),
            raw(
                CRSF_FRAMETYPE_COMMAND,
                &[CRSF_ADDRESS_MODULE, CRSF_ADDRESS_RADIO, 0x10, 5, 7, 0],
            ),
            raw(CRSF_FRAMETYPE_LINK_STATISTICS, &[0; 9]),
            raw(CRSF_FRAMETYPE_BATTERY, &[0; 7]),
            raw(CRSF_FRAMETYPE_ATTITUDE, &[0; 5]),
            raw(CRSF_FRAMETYPE_GPS, &[0; 14]),
            raw(CRSF_FRAMETYPE_FLIGHT_MODE, b"FBWA"),
            raw(
                CRSF_FRAMETYPE_DEVICE_INFO,
                &[CRSF_ADDRESS_RADIO, CRSF_ADDRESS_MODULE, b'A', 0],
            ),
        ] {
            state.note(&frame);
        }
        assert_eq!(state, Telemetry::new());
    }

    #[test]
    fn receiver_discovery_does_not_replace_the_transmitter_name() {
        let mut state = Telemetry::new();
        state.note(&info(CRSF_ADDRESS_MODULE, "RM Nomad X-Band"));
        state.note(&info(0xec, "RM RP3"));
        assert_eq!(state.module_frames, 2);
        assert_eq!(state.device_name.as_deref(), Some("RM Nomad X-Band"));
        let mut wrong_destination = info(CRSF_ADDRESS_MODULE, "Wrong destination");
        wrong_destination.payload[0] = 0xec;
        state.note(&wrong_destination);
        assert_eq!(state.module_frames, 2);
        assert_eq!(state.device_name.as_deref(), Some("RM Nomad X-Band"));
    }

    #[test]
    fn freshness_tracks_link_frames_separately_from_other_responses() {
        let mut state = Telemetry::new();
        let old = Instant::now().checked_sub(Duration::from_secs(5)).unwrap();
        state.note_at(
            &raw(
                CRSF_FRAMETYPE_LINK_STATISTICS,
                &[193, 0, 100, 0, 0, 24, 3, 243, 100, 0],
            ),
            old,
        );
        state.note(&info(CRSF_ADDRESS_MODULE, "Nomad"));
        assert!(state.link_age().unwrap() >= Duration::from_secs(5));
        assert!(!state.link_is_fresh(Duration::from_secs(1)));
        assert!(state.link_is_fresh(Duration::from_secs(10)));
        assert_eq!(
            state.link.unwrap().uplink_lq,
            100,
            "cached statistics are retained but explicitly stale"
        );
        assert!(state.last_frame_at.unwrap() > state.last_link_at.unwrap());
    }

    #[test]
    fn battery_attitude_gps_and_flight_mode_use_network_byte_order() {
        let mut state = Telemetry::new();
        state.note(&raw(CRSF_FRAMETYPE_BATTERY, &[0, 168, 0, 25, 1, 2, 3, 80]));
        assert_eq!(
            state.battery,
            Some(Battery {
                volts: 16.8,
                amps: 2.5,
                mah: 0x010203,
                remaining: 80
            })
        );
        state.note(&raw(
            CRSF_FRAMETYPE_ATTITUDE,
            &[0x27, 0x10, 0xd8, 0xf0, 0, 0],
        ));
        let attitude = state.attitude.unwrap();
        assert!((attitude.pitch - 57.29578).abs() < 0.0001);
        assert!((attitude.roll + 57.29578).abs() < 0.0001);
        let mut gps = vec![];
        gps.extend_from_slice(&(-123_456_789i32).to_be_bytes());
        gps.extend_from_slice(&(456_789_012i32).to_be_bytes());
        gps.extend_from_slice(&[0; 6]);
        gps.push(12);
        state.note(&raw(CRSF_FRAMETYPE_GPS, &gps));
        assert_eq!(
            state.gps,
            Some(Gps {
                lat: -12.3456789,
                lon: 45.6789012,
                sats: 12
            })
        );
        state.note(&raw(CRSF_FRAMETYPE_FLIGHT_MODE, b"FBWA\0"));
        assert_eq!(state.flight_mode.as_deref(), Some("FBWA"));
        state.note(&raw(CRSF_FRAMETYPE_FLIGHT_MODE, b"\0"));
        assert_eq!(state.flight_mode, None);
    }
}
