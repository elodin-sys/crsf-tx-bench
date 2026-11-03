//! CRSF frames for the ExpressLRS handset port.

/// CRSF sync used for extended frames (ping, command).
pub const CRSF_SYNC: u8 = 0xc8;
/// Broadcast address.
pub const CRSF_ADDRESS_BROADCAST: u8 = 0x00;
/// Radio transmitter address. EdgeTX uses this as the origin of handset frames.
pub const CRSF_ADDRESS_RADIO: u8 = 0xea;
/// Module address. Classic RC frames are addressed here.
pub const CRSF_ADDRESS_MODULE: u8 = 0xee;

/// GPS telemetry.
pub const CRSF_FRAMETYPE_GPS: u8 = 0x02;
/// Battery telemetry.
pub const CRSF_FRAMETYPE_BATTERY: u8 = 0x08;
/// Link statistics telemetry.
pub const CRSF_FRAMETYPE_LINK_STATISTICS: u8 = 0x14;
/// Packed RC channels.
pub const CRSF_FRAMETYPE_RC_CHANNELS: u8 = 0x16;
/// Attitude telemetry.
pub const CRSF_FRAMETYPE_ATTITUDE: u8 = 0x1e;
/// Flight mode string.
pub const CRSF_FRAMETYPE_FLIGHT_MODE: u8 = 0x21;
/// Device ping.
pub const CRSF_FRAMETYPE_DEVICE_PING: u8 = 0x28;
/// Device info reply.
pub const CRSF_FRAMETYPE_DEVICE_INFO: u8 = 0x29;
/// Extended command, including the model-id command.
pub const CRSF_FRAMETYPE_COMMAND: u8 = 0x32;

/// Channels packed into one RC frame.
pub const CHANNEL_COUNT: usize = 16;
/// Lowest legal 11-bit channel value.
pub const CRSF_CHANNEL_MIN: u16 = 172;
/// Center channel value. 1500 µs maps here.
pub const CRSF_CHANNEL_MID: u16 = 992;
/// Highest legal 11-bit channel value.
pub const CRSF_CHANNEL_MAX: u16 = 1811;

/// EdgeTX 100% low endpoint, in microseconds.
pub const US_MIN: i32 = 988;
/// EdgeTX center, in microseconds.
pub const US_MID: i32 = 1500;
/// EdgeTX 100% high endpoint, in microseconds.
pub const US_MAX: i32 = 2012;

/// CRC-8 polynomial for a normal CRSF frame (DVB-S2).
pub const CRC8_DVB_S2: u8 = 0xd5;
/// CRC-8 polynomial for the command sub-CRC.
pub const CRC8_COMMAND: u8 = 0xba;

/// Baud rates the ExpressLRS handset UART will lock to. 400000 is the usual one.
pub const HANDSET_BAUDS: [u32; 5] = [115_200, 400_000, 921_600, 1_870_000, 2_250_000];
/// Baud a radio uses when it talks to the module.
pub const DEFAULT_BAUD: u32 = 400_000;

const SYNC_BYTES: [u8; 4] = [CRSF_SYNC, CRSF_ADDRESS_RADIO, CRSF_ADDRESS_MODULE, 0xec];

/// True when `baud` is one of the rates the handset port searches for.
#[must_use]
pub fn is_handset_baud(baud: u32) -> bool {
    HANDSET_BAUDS.contains(&baud)
}

/// CRC-8, initial value 0, no reflection. `poly` is `0xD5` for frames and `0xBA` for commands.
#[must_use]
pub fn crc8(data: &[u8], poly: u8) -> u8 {
    let mut crc = 0u8;
    for &byte in data {
        crc ^= byte;
        for _ in 0..8 {
            if crc & 0x80 != 0 {
                crc = (crc << 1) ^ poly;
            } else {
                crc <<= 1;
            }
        }
    }
    crc
}

/// Map a stick position in microseconds into an 11-bit CRSF channel.
///
/// Values outside 988..=2012 µs are clamped to the EdgeTX endpoints.
#[must_use]
pub fn us_to_crsf(us: i32) -> u16 {
    let clamped = us.clamp(US_MIN, US_MAX);
    let pulses = (clamped - US_MID) * 2;
    let value = CRSF_CHANNEL_MID as i32 + (pulses * 4) / 5;
    value.clamp(CRSF_CHANNEL_MIN as i32, CRSF_CHANNEL_MAX as i32) as u16
}

/// Map an 11-bit CRSF channel back to microseconds.
#[must_use]
pub fn crsf_to_us(value: u16) -> i32 {
    let delta = value as i32 - CRSF_CHANNEL_MID as i32;
    let pulses = js_round(delta as f64 * 5.0 / 4.0);
    US_MID + js_round(pulses as f64 / 2.0)
}

fn js_round(value: f64) -> i32 {
    (value + 0.5).floor() as i32
}

/// Pack 16 channels into the 22-byte CRSF bit stream. Each channel keeps 11 bits.
#[must_use]
pub fn pack_channels(channels: &[u16; CHANNEL_COUNT]) -> [u8; 22] {
    let mut payload = [0u8; 22];
    let mut bits = 0u32;
    let mut available = 0u32;
    let mut index = 0;
    for &raw in channels {
        bits |= (u32::from(raw) & 0x7ff) << available;
        available += 11;
        while available >= 8 {
            payload[index] = (bits & 0xff) as u8;
            index += 1;
            bits >>= 8;
            available -= 8;
        }
    }
    payload
}

/// Unpack 16 channels from a 22-byte CRSF payload.
#[must_use]
pub fn unpack_channels(payload: &[u8]) -> [u16; CHANNEL_COUNT] {
    let mut channels = [0u16; CHANNEL_COUNT];
    let mut bits = 0u32;
    let mut available = 0u32;
    let mut index = 0;
    for channel in &mut channels {
        while available < 11 {
            let byte = payload.get(index).copied().unwrap_or(0);
            index += 1;
            bits |= u32::from(byte) << available;
            available += 8;
        }
        *channel = (bits & 0x7ff) as u16;
        bits >>= 11;
        available -= 11;
    }
    channels
}

/// Build a CRSF frame. `payload` must be 60 bytes or shorter.
///
/// The length byte counts the type, the payload, and the CRC.
#[must_use]
pub fn build_frame(ty: u8, payload: &[u8], sync: u8) -> Option<Vec<u8>> {
    if payload.len() > 60 {
        return None;
    }
    let mut frame = Vec::with_capacity(payload.len() + 4);
    frame.push(sync);
    frame.push((payload.len() + 2) as u8);
    frame.push(ty);
    frame.extend_from_slice(payload);
    let crc = crc8(&frame[2..], CRC8_DVB_S2);
    frame.push(crc);
    Some(frame)
}

/// Classic 26-byte RC frame.
///
/// Length 24 tells ExpressLRS to read arming from channel 5. `channels` are
/// 11-bit CRSF units, not microseconds. Use [`us_to_crsf`] or [`crate::Sticks::to_crsf`].
#[must_use]
pub fn build_rc_frame(channels: &[u16; CHANNEL_COUNT]) -> [u8; 26] {
    let packed = pack_channels(channels);
    let mut frame = [0u8; 26];
    frame[0] = CRSF_ADDRESS_MODULE;
    frame[1] = 24;
    frame[2] = CRSF_FRAMETYPE_RC_CHANNELS;
    frame[3..25].copy_from_slice(&packed);
    frame[25] = crc8(&frame[2..25], CRC8_DVB_S2);
    frame
}

/// The same RC frame, converted from microseconds first.
#[must_use]
pub fn build_rc_frame_us(microseconds: &[i32; CHANNEL_COUNT]) -> [u8; 26] {
    let mut channels = [0u16; CHANNEL_COUNT];
    for (channel, &us) in channels.iter_mut().zip(microseconds) {
        *channel = us_to_crsf(us);
    }
    build_rc_frame(&channels)
}

/// Model-id command, the same bytes EdgeTX sends.
///
/// The id is clamped to 0..=63. It only matters when model match is enabled on the module.
#[must_use]
pub fn build_model_id_frame(model_id: u8) -> [u8; 10] {
    let id = model_id.min(63);
    let body = [
        CRSF_FRAMETYPE_COMMAND,
        CRSF_ADDRESS_MODULE,
        CRSF_ADDRESS_RADIO,
        0x10,
        0x05,
        id,
    ];
    let mut payload = [0u8; 6];
    payload[..5].copy_from_slice(&body[1..]);
    payload[5] = crc8(&body, CRC8_COMMAND);
    let mut frame = [0u8; 10];
    frame[0] = CRSF_SYNC;
    frame[1] = 8;
    frame[2] = CRSF_FRAMETYPE_COMMAND;
    frame[3..9].copy_from_slice(&payload);
    frame[9] = crc8(&frame[2..9], CRC8_DVB_S2);
    frame
}

/// Broadcast device ping. The module answers with device info when it is listening.
#[must_use]
pub fn build_ping_frame() -> [u8; 6] {
    let mut frame = [
        CRSF_SYNC,
        4,
        CRSF_FRAMETYPE_DEVICE_PING,
        CRSF_ADDRESS_BROADCAST,
        CRSF_ADDRESS_RADIO,
        0,
    ];
    frame[5] = crc8(&frame[2..5], CRC8_DVB_S2);
    frame
}

/// One frame pulled out of a byte stream. The payload does not include the type or CRC.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawFrame {
    /// Address or sync byte.
    pub sync: u8,
    /// Frame type.
    pub ty: u8,
    /// Bytes between the type and the CRC.
    pub payload: Vec<u8>,
}

#[derive(Clone, Copy, Debug)]
enum Phase {
    Sync,
    Length,
    Body { expected: usize, filled: usize },
}

/// Incremental CRSF parser. Bad CRCs are dropped. A length byte that is itself a sync restarts the frame.
#[derive(Clone, Debug)]
pub struct Parser {
    buffer: [u8; 64],
    phase: Phase,
}

impl Default for Parser {
    fn default() -> Self {
        Self::new()
    }
}

impl Parser {
    /// An empty parser waiting for a sync byte.
    #[must_use]
    pub fn new() -> Self {
        Self {
            buffer: [0; 64],
            phase: Phase::Sync,
        }
    }

    /// Forget a partial frame.
    pub fn reset(&mut self) {
        self.phase = Phase::Sync;
    }

    /// Feed bytes. Complete, CRC-valid frames are returned in order.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<RawFrame> {
        let mut frames = Vec::new();
        for &byte in chunk {
            if let Some(frame) = self.push_byte(byte) {
                frames.push(frame);
            }
        }
        frames
    }

    fn push_byte(&mut self, byte: u8) -> Option<RawFrame> {
        match self.phase {
            Phase::Sync => {
                if is_sync(byte) {
                    self.buffer[0] = byte;
                    self.phase = Phase::Length;
                }
                None
            }
            Phase::Length => {
                if !(2..=62).contains(&byte) {
                    self.phase = Phase::Sync;
                    if is_sync(byte) {
                        self.buffer[0] = byte;
                        self.phase = Phase::Length;
                    }
                    return None;
                }
                self.buffer[1] = byte;
                self.phase = Phase::Body {
                    expected: usize::from(byte),
                    filled: 0,
                };
                None
            }
            Phase::Body { expected, filled } => {
                self.buffer[2 + filled] = byte;
                let filled = filled + 1;
                if filled < expected {
                    self.phase = Phase::Body { expected, filled };
                    return None;
                }
                let total = expected + 2;
                let crc = crc8(&self.buffer[2..total - 1], CRC8_DVB_S2);
                let ok = crc == self.buffer[total - 1];
                let sync = self.buffer[0];
                let ty = self.buffer[2];
                let payload = self.buffer[3..total - 1].to_vec();
                self.phase = Phase::Sync;
                ok.then_some(RawFrame { sync, ty, payload })
            }
        }
    }
}

fn is_sync(byte: u8) -> bool {
    SYNC_BYTES.contains(&byte)
}

/// Hex bytes separated by spaces, for logs.
#[must_use]
pub fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().saturating_mul(3));
    for (index, byte) in bytes.iter().enumerate() {
        if index > 0 {
            out.push(' ');
        }
        out.push(char::from(b"0123456789abcdef"[usize::from(byte >> 4)]));
        out.push(char::from(b"0123456789abcdef"[usize::from(byte & 0x0f)]));
    }
    out
}

/// A short name for a frame type byte.
#[must_use]
pub fn frame_type_name(ty: u8) -> String {
    match ty {
        CRSF_FRAMETYPE_GPS => "GPS".to_owned(),
        CRSF_FRAMETYPE_BATTERY => "Battery".to_owned(),
        CRSF_FRAMETYPE_LINK_STATISTICS => "Link statistics".to_owned(),
        CRSF_FRAMETYPE_RC_CHANNELS => "RC channels".to_owned(),
        CRSF_FRAMETYPE_ATTITUDE => "Attitude".to_owned(),
        CRSF_FRAMETYPE_FLIGHT_MODE => "Flight mode".to_owned(),
        CRSF_FRAMETYPE_DEVICE_PING => "Ping".to_owned(),
        CRSF_FRAMETYPE_DEVICE_INFO => "Device info".to_owned(),
        CRSF_FRAMETYPE_COMMAND => "Command".to_owned(),
        0x3a => "Radio ID".to_owned(),
        other => format!("Frame 0x{other:02x}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_matches_the_edgetx_tables() {
        let expected = [0x00, 0xd5, 0x7f, 0xaa, 0xfe, 0x2b, 0x81, 0x54];
        for (index, value) in expected.iter().enumerate() {
            assert_eq!(crc8(&[index as u8], CRC8_DVB_S2), *value);
        }
        assert_eq!(crc8(&[0x00], CRC8_COMMAND), 0x00);
        assert_eq!(crc8(&[0x01], CRC8_COMMAND), 0xba);
    }

    #[test]
    fn scaling_uses_the_edgetx_endpoints() {
        assert_eq!(us_to_crsf(1500), CRSF_CHANNEL_MID);
        assert_eq!(us_to_crsf(988), 173);
        assert_eq!(us_to_crsf(2012), 1811);
        assert_eq!(us_to_crsf(1000), 192);
        assert_eq!(crsf_to_us(173), 988);
        assert_eq!(crsf_to_us(CRSF_CHANNEL_MID), 1500);
        assert_eq!(crsf_to_us(1811), 2012);
    }

    #[test]
    fn rc_frame_matches_the_typescript_encoder() {
        let channels = std::array::from_fn(|index| (200 + index * 40) as u16);
        let frame = build_rc_frame(&channels);
        assert_eq!(
            hex(&frame),
            "ee1816c8800746808216c8e0063c0882119600852a68e10b64b3"
        );
        assert_eq!(frame[25], crc8(&frame[2..25], CRC8_DVB_S2));

        let mut parser = Parser::new();
        let mut found = Vec::new();
        for byte in frame {
            found.extend(parser.push(&[byte]));
        }
        assert_eq!(found.len(), 1);
        assert_eq!(unpack_channels(&found[0].payload), channels);
    }

    #[test]
    fn model_id_and_ping_match_edgetx_bytes() {
        let model = build_model_id_frame(7);
        assert_eq!(hex(&model), "c80832eeea1005078ecc");
        assert_eq!(model[9], crc8(&model[2..9], CRC8_DVB_S2));

        let ping = build_ping_frame();
        assert_eq!(hex(&ping), "c8042800ea54");

        let mut bytes = Vec::new();
        bytes.extend_from_slice(&model);
        bytes.extend_from_slice(&ping);
        bytes.splice(0..0, [0x00, 0xff]);
        let frames = Parser::new().push(&bytes);
        let types: Vec<u8> = frames.iter().map(|frame| frame.ty).collect();
        assert_eq!(types, [CRSF_FRAMETYPE_COMMAND, CRSF_FRAMETYPE_DEVICE_PING]);
    }

    #[test]
    fn a_bad_crc_is_dropped_and_the_next_frame_still_parses() {
        let mut bad = build_ping_frame();
        bad[5] ^= 0xff;
        let mut bytes = bad.to_vec();
        bytes.extend_from_slice(&build_ping_frame());
        let frames = Parser::new().push(&bytes);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].ty, CRSF_FRAMETYPE_DEVICE_PING);
    }

    fn hex(bytes: &[u8]) -> String {
        to_hex(bytes).replace(' ', "")
    }
}
