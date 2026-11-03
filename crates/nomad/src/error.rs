use std::fmt;
use std::io;

/// A serial or framing failure while talking to the module.
#[derive(Debug)]
pub enum Error {
    /// The port read or write failed.
    Io(io::Error),
    /// Opening or listing a serial port failed.
    #[cfg(feature = "serial")]
    Serial(serialport::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Io(err) => write!(f, "{err}"),
            #[cfg(feature = "serial")]
            Error::Serial(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io(err) => Some(err),
            #[cfg(feature = "serial")]
            Error::Serial(_) => None,
        }
    }
}

impl From<io::Error> for Error {
    fn from(err: io::Error) -> Self {
        Error::Io(err)
    }
}

#[cfg(feature = "serial")]
impl From<serialport::Error> for Error {
    fn from(err: serialport::Error) -> Self {
        Error::Serial(err)
    }
}
