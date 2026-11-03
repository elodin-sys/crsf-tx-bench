//! Telemetry the module sends back down the handset port.

use crate::crsf::{
    frame_type_name, RawFrame, CRSF_FRAMETYPE_ATTITUDE, CRSF_FRAMETYPE_BATTERY,
    CRSF_FRAMETYPE_DEVICE_INFO, CRSF_FRAMETYPE_FLIGHT_MODE, CRSF_FRAMETYPE_GPS,
    CRSF_FRAMETYPE_LINK_STATISTICS, CRSF_FRAMETYPE_RC_CHANNELS,
};

const TX_POWER_MW: [u16; 9] = [0, 10, 25, 100, 500, 1000, 2000, 250, 50];

/// Uplink and downlink figures from a link-statistics frame.
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
            CRSF_FRAMETYPE_FLIGHT_MODE => {
                let mode = c_string(&self.payload, 0);
                if mode.is_empty() {
                    Message::Other(self.clone())
                } else {
                    Message::FlightMode(mode)
                }
            }
            CRSF_FRAMETYPE_DEVICE_INFO if self.payload.len() > 2 => {
                let name = c_string(&self.payload, 2);
                if name.is_empty() {
                    Message::Other(self.clone())
                } else {
                    Message::DeviceInfo(name)
                }
            }
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
        uplink_rssi_dbm: -i16::from(payload[0]),
        uplink_lq: payload[2],
        uplink_snr: payload[3] as i8,
        antenna: payload[4].saturating_add(1),
        rf_mode: payload[5],
        tx_power_mw: TX_POWER_MW.get(power).copied(),
        downlink_rssi_dbm: -i16::from(payload[7]),
        downlink_lq: payload[8],
        downlink_snr: payload[9] as i8,
    }
}

/// The latest telemetry heard from the module.
///
/// RC channel frames are ignored. Those are echoes of the frames this crate sends.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Telemetry {
    /// Latest link statistics.
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

    /// Fold one parsed frame into this state.
    pub fn note(&mut self, frame: &RawFrame) {
        if frame.ty == CRSF_FRAMETYPE_RC_CHANNELS {
            return;
        }
        self.last_type = Some(frame.ty);
        self.module_frames = self.module_frames.saturating_add(1);
        match frame.decode() {
            Message::Link(link) => self.link = Some(link),
            Message::Battery(battery) => self.battery = Some(battery),
            Message::Attitude(attitude) => self.attitude = Some(attitude),
            Message::FlightMode(mode) => self.flight_mode = Some(mode),
            Message::DeviceInfo(name) => self.device_name = Some(name),
            Message::Gps(gps) => self.gps = Some(gps),
            Message::Channels(_) | Message::Other(_) => {}
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

fn c_string(payload: &[u8], start: usize) -> String {
    let end = payload[start..]
        .iter()
        .position(|byte| *byte == 0)
        .map_or(payload.len(), |index| start + index);
    String::from_utf8_lossy(&payload[start..end])
        .trim()
        .to_owned()
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
        let payload = [80, 0, 95, 0xfe, 1, 4, 5, 70, 90, 5];
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
        let payload = [80, 0, 95, 0xfe, 1, 4, 5, 70, 90, 5];
        let bytes = build_frame(CRSF_FRAMETYPE_LINK_STATISTICS, &payload, CRSF_SYNC).unwrap();
        let frames = crate::crsf::Parser::new().push(&bytes);
        assert_eq!(frames.len(), 1);
        match frames[0].decode() {
            Message::Link(link) => assert_eq!(link.uplink_lq, 95),
            other => panic!("unexpected {other:?}"),
        }
    }
}
