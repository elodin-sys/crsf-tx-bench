//! Talk to a RadioMaster Nomad ExpressLRS module over its USB-C port.
//!
//! The module has to be told that USB-C is the handset, not the telemetry port.
//! On the ExpressLRS hardware page set `serial_rx` to 3 and `serial_tx` to 1,
//! then open the serial device at 400000 baud, 8N1. Power the radio from the
//! XT30. USB does not feed the amplifiers.
//!
//! [`Sticks`] turns stick positions into the 16 CRSF channels. [`Handset`] writes
//! those channels and reads link telemetry back.
//!
//! ```no_run
//! # #[cfg(feature = "serial")]
//! # fn main() -> Result<(), nomad::Error> {
//! use nomad::{Handset, Options, Sticks};
//! use std::thread;
//! use std::time::Duration;
//!
//! let mut handset = Handset::open("/dev/ttyACM0", Options::default())?;
//! let mut sticks = Sticks::disarmed();
//! loop {
//!     let telemetry = handset.poll(&sticks.to_crsf())?;
//!     if let Some(link) = telemetry.link {
//!         println!("{}% uplink", link.uplink_lq);
//!     }
//!     sticks.yaw = 0.2;
//!     thread::sleep(Duration::from_millis(10));
//! }
//! # }
//! # #[cfg(not(feature = "serial"))]
//! # fn main() {}
//! ```
//!
//! Channel 3 is throttle and is live as soon as frames are flowing. Channel 5
//! stays low until [`Sticks::armed`] is set. Dropping the [`Handset`] writes
//! three disarmed frames before the port closes.

#![warn(missing_docs)]

mod crsf;
mod error;
mod link;
mod sticks;
mod telemetry;

pub use crsf::{
    build_frame, build_model_id_frame, build_ping_frame, build_rc_frame, build_rc_frame_us, crc8,
    crsf_to_us, frame_type_name, is_handset_baud, pack_channels, to_hex, unpack_channels,
    us_to_crsf, Parser, RawFrame, CHANNEL_COUNT, CRC8_COMMAND, CRC8_DVB_S2, CRSF_ADDRESS_BROADCAST,
    CRSF_ADDRESS_MODULE, CRSF_ADDRESS_RADIO, CRSF_CHANNEL_MAX, CRSF_CHANNEL_MID, CRSF_CHANNEL_MIN,
    CRSF_FRAMETYPE_ATTITUDE, CRSF_FRAMETYPE_BATTERY, CRSF_FRAMETYPE_COMMAND,
    CRSF_FRAMETYPE_DEVICE_INFO, CRSF_FRAMETYPE_DEVICE_PING, CRSF_FRAMETYPE_FLIGHT_MODE,
    CRSF_FRAMETYPE_GPS, CRSF_FRAMETYPE_LINK_STATISTICS, CRSF_FRAMETYPE_RC_CHANNELS, CRSF_SYNC,
    DEFAULT_BAUD, HANDSET_BAUDS, US_MAX, US_MID, US_MIN,
};
pub use error::Error;
#[cfg(feature = "serial")]
pub use link::{list_ports, ListedPort};
pub use link::{Handset, Options};
pub use sticks::{Inverts, Sticks, Switch};
pub use telemetry::{Attitude, Battery, Gps, LinkStats, Message, Telemetry};
