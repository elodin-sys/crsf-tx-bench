//! Stick positions in AETR order.

use crate::crsf::{us_to_crsf, CHANNEL_COUNT, US_MAX, US_MID, US_MIN};

/// Three-position switch.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Switch {
    /// 988 µs.
    Low,
    /// 1500 µs.
    #[default]
    Mid,
    /// 2012 µs.
    High,
}

/// Per-axis reversal.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Inverts {
    /// Reverse roll.
    pub roll: bool,
    /// Reverse pitch.
    pub pitch: bool,
    /// Reverse yaw.
    pub yaw: bool,
    /// Reverse throttle.
    pub throttle: bool,
}

/// One stick sample.
///
/// Roll, pitch, and yaw run from -1 to 1 and spring to 0. Throttle runs from 0
/// (low) to 1 (high) and stays where it is put. Channel 5 is the arm switch
/// ExpressLRS watches: low until `armed` is set.
///
/// Channel order is AETR: roll, pitch, throttle, yaw, arm, then the three switches.
/// Channels 9 through 16 stay at 1500 µs.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sticks {
    /// Roll, -1 to 1.
    pub roll: f32,
    /// Pitch, -1 to 1.
    pub pitch: f32,
    /// Yaw, -1 to 1.
    pub yaw: f32,
    /// Throttle, 0 low to 1 high.
    pub throttle: f32,
    /// Channel 5. False is disarmed.
    pub armed: bool,
    /// Channels 6, 7, and 8.
    pub switches: [Switch; 3],
    /// Axis reversal applied while converting to microseconds.
    pub inverts: Inverts,
}

impl Default for Sticks {
    fn default() -> Self {
        Self::disarmed()
    }
}

impl Sticks {
    /// Centered sticks, throttle low, disarmed, switches centered.
    #[must_use]
    pub fn disarmed() -> Self {
        Self {
            roll: 0.0,
            pitch: 0.0,
            yaw: 0.0,
            throttle: 0.0,
            armed: false,
            switches: [Switch::Mid; 3],
            inverts: Inverts::default(),
        }
    }

    /// Sixteen channel values in microseconds.
    #[must_use]
    pub fn to_microseconds(&self) -> [i32; CHANNEL_COUNT] {
        let mut us = [US_MID; CHANNEL_COUNT];
        us[0] = axis_us(self.roll, self.inverts.roll);
        us[1] = axis_us(self.pitch, self.inverts.pitch);
        us[2] = throttle_us(self.throttle, self.inverts.throttle);
        us[3] = axis_us(self.yaw, self.inverts.yaw);
        us[4] = if self.armed { US_MAX } else { US_MIN };
        for (index, switch) in self.switches.iter().enumerate() {
            us[5 + index] = switch_us(*switch);
        }
        us
    }

    /// Sixteen 11-bit CRSF channel values, ready for [`crate::build_rc_frame`].
    #[must_use]
    pub fn to_crsf(&self) -> [u16; CHANNEL_COUNT] {
        let mut channels = [0; CHANNEL_COUNT];
        for (channel, us) in channels.iter_mut().zip(self.to_microseconds()) {
            *channel = us_to_crsf(us);
        }
        channels
    }
}

fn finite(value: f32) -> f32 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

fn axis_us(value: f32, invert: bool) -> i32 {
    let signed = if invert {
        -finite(value)
    } else {
        finite(value)
    };
    let clamped = signed.clamp(-1.0, 1.0);
    (US_MID as f32 + clamped * (US_MAX - US_MID) as f32).round() as i32
}

fn throttle_us(value: f32, invert: bool) -> i32 {
    let travel = if invert {
        1.0 - finite(value)
    } else {
        finite(value)
    };
    let clamped = travel.clamp(0.0, 1.0);
    (US_MIN as f32 + clamped * (US_MAX - US_MIN) as f32).round() as i32
}

fn switch_us(position: Switch) -> i32 {
    match position {
        Switch::Low => US_MIN,
        Switch::Mid => US_MID,
        Switch::High => US_MAX,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crsf::CRSF_CHANNEL_MID;

    #[test]
    fn a_disarmed_quad_stays_low() {
        let outputs = Sticks::disarmed().to_microseconds();
        let crsf = Sticks::disarmed().to_crsf();
        assert_eq!(outputs[2], 988);
        assert_eq!(outputs[4], 988);
        assert_eq!(crsf[0], CRSF_CHANNEL_MID);
    }

    #[test]
    fn channel_five_rises_only_while_armed() {
        let mut sticks = Sticks::disarmed();
        sticks.pitch = 1.0;
        sticks.yaw = -1.0;
        sticks.throttle = 0.5;
        sticks.armed = true;
        sticks.switches = [Switch::High, Switch::Low, Switch::Mid];
        let us = sticks.to_microseconds();
        assert_eq!(us[4], 2012);
        assert_eq!(us[1], 2012);
        assert_eq!(us[3], 988);
        assert_eq!(us[5], 2012);
        assert_eq!(us[6], 988);
        assert_eq!(us[7], 1500);
        assert_eq!(us[2], 1500);
    }
}
