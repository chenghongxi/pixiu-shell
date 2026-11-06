//! SFTP operations using remote path bytes, without converting them to Windows paths.
use libssh2_sys as raw;
use ssh2::{Error, ErrorCode, FileStat, OpenFlags, OpenType, RenameFlags, Session};
use std::{
    ffi::CString,
    io::{self, Read, Write},
    path::Path,
    ptr,
};

pub(crate) struct Sftp {
    session: Session,
    raw: *mut raw::LIBSSH2_SFTP,
}

// Every libssh2 call is serialized by Session::raw's mutex. An SFTP value is
// checked out of the pool exclusively and file handles borrow it.
unsafe impl Send for Sftp {}

impl Sftp {
    pub(crate) fn new(session: Session) -> Result<Self, Error> {
        let mut guard = session.raw();
        let ptr = &mut *guard as *mut _;
        let sftp = unsafe { raw::libssh2_sftp_init(ptr) };
        if sftp.is_null() {
            return Err(Error::from_errno(ErrorCode::Session(unsafe {
                raw::libssh2_session_last_errno(ptr)
            })));
        }
        drop(guard);
        Ok(Self { session, raw: sftp })
    }

    fn path(path: &Path) -> Result<CString, Error> {
        let bytes = crate::files::resolve_sftp_path(path)?
            .unwrap_or_else(|| path.to_string_lossy().replace('\\', "/").into_bytes());
        CString::new(bytes).map_err(|_| Error::new(ErrorCode::Session(-1), "路径包含空字节"))
    }

    fn error(&self, code: i32) -> Error {
        if code == raw::LIBSSH2_ERROR_SFTP_PROTOCOL {
            Error::from_errno(ErrorCode::SFTP(
                unsafe { raw::libssh2_sftp_last_error(self.raw) } as i32,
            ))
        } else {
            Error::from_errno(ErrorCode::Session(code))
        }
    }

    fn rc(&self, code: i32) -> Result<(), Error> {
        if code < 0 {
            Err(self.error(code))
        } else {
            Ok(())
        }
    }

    pub(crate) fn realpath_bytes(&self, path: &Path) -> Result<Vec<u8>, Error> {
        let path = Self::path(path)?;
        let _guard = self.session.raw();
        let mut buf = vec![0u8; 4096];
        let rc = unsafe {
            raw::libssh2_sftp_symlink_ex(
                self.raw,
                path.as_ptr(),
                path.as_bytes().len() as _,
                buf.as_mut_ptr().cast(),
                buf.len() as _,
                raw::LIBSSH2_SFTP_REALPATH,
            )
        };
        self.rc(rc)?;
        buf.truncate(rc as usize);
        Ok(buf)
    }

    pub(crate) fn open_mode(
        &self,
        path: &Path,
        flags: OpenFlags,
        mode: i32,
        kind: OpenType,
    ) -> Result<File<'_>, Error> {
        let path = Self::path(path)?;
        let mut guard = self.session.raw();
        let ptr = unsafe {
            raw::libssh2_sftp_open_ex(
                self.raw,
                path.as_ptr(),
                path.as_bytes().len() as _,
                flags.bits() as _,
                mode as _,
                kind as _,
            )
        };
        if ptr.is_null() {
            return Err(self.error(unsafe { raw::libssh2_session_last_errno(&mut *guard) }));
        }
        Ok(File {
            sftp: self,
            raw: ptr,
        })
    }
    pub(crate) fn open(&self, path: &Path) -> Result<File<'_>, Error> {
        self.open_mode(path, OpenFlags::READ, 0o644, OpenType::File)
    }
    pub(crate) fn opendir(&self, path: &Path) -> Result<File<'_>, Error> {
        self.open_mode(path, OpenFlags::READ, 0, OpenType::Dir)
    }
    fn stat_op(
        &self,
        path: &Path,
        op: i32,
        mut attrs: raw::LIBSSH2_SFTP_ATTRIBUTES,
    ) -> Result<FileStat, Error> {
        let path = Self::path(path)?;
        let _guard = self.session.raw();
        let rc = unsafe {
            raw::libssh2_sftp_stat_ex(
                self.raw,
                path.as_ptr(),
                path.as_bytes().len() as _,
                op,
                &mut attrs,
            )
        };
        self.rc(rc)?;
        Ok(FileStat::from_raw(&attrs))
    }
    pub(crate) fn stat(&self, path: &Path) -> Result<FileStat, Error> {
        self.stat_op(path, raw::LIBSSH2_SFTP_STAT, unsafe { std::mem::zeroed() })
    }
    pub(crate) fn lstat(&self, path: &Path) -> Result<FileStat, Error> {
        self.stat_op(path, raw::LIBSSH2_SFTP_LSTAT, unsafe { std::mem::zeroed() })
    }
    pub(crate) fn setstat(&self, path: &Path, stat: FileStat) -> Result<(), Error> {
        self.stat_op(path, raw::LIBSSH2_SFTP_SETSTAT, stat.raw())
            .map(|_| ())
    }
    pub(crate) fn mkdir(&self, path: &Path, mode: i32) -> Result<(), Error> {
        let p = Self::path(path)?;
        let _guard = self.session.raw();
        self.rc(unsafe {
            raw::libssh2_sftp_mkdir_ex(self.raw, p.as_ptr(), p.as_bytes().len() as _, mode as _)
        })
    }
    pub(crate) fn rmdir(&self, path: &Path) -> Result<(), Error> {
        let p = Self::path(path)?;
        let _guard = self.session.raw();
        self.rc(unsafe {
            raw::libssh2_sftp_rmdir_ex(self.raw, p.as_ptr(), p.as_bytes().len() as _)
        })
    }
    pub(crate) fn unlink(&self, path: &Path) -> Result<(), Error> {
        let p = Self::path(path)?;
        let _guard = self.session.raw();
        self.rc(unsafe {
            raw::libssh2_sftp_unlink_ex(self.raw, p.as_ptr(), p.as_bytes().len() as _)
        })
    }
    pub(crate) fn rename(
        &self,
        from: &Path,
        to: &Path,
        flags: Option<RenameFlags>,
    ) -> Result<(), Error> {
        let from = Self::path(from)?;
        let to = Self::path(to)?;
        let flags =
            flags.unwrap_or(RenameFlags::ATOMIC | RenameFlags::OVERWRITE | RenameFlags::NATIVE);
        let _guard = self.session.raw();
        self.rc(unsafe {
            raw::libssh2_sftp_rename_ex(
                self.raw,
                from.as_ptr(),
                from.as_bytes().len() as _,
                to.as_ptr(),
                to.as_bytes().len() as _,
                flags.bits(),
            )
        })
    }
}

impl Drop for Sftp {
    fn drop(&mut self) {
        let _guard = self.session.raw();
        unsafe {
            raw::libssh2_sftp_shutdown(self.raw);
        }
    }
}

pub(crate) struct File<'a> {
    sftp: &'a Sftp,
    raw: *mut raw::LIBSSH2_SFTP_HANDLE,
}

impl File<'_> {
    pub(crate) fn readdir_bytes(&mut self) -> Result<(Vec<u8>, FileStat), Error> {
        let _guard = self.sftp.session.raw();
        let mut buf = vec![0u8; 4096];
        let mut stat = unsafe { std::mem::zeroed() };
        let rc = unsafe {
            raw::libssh2_sftp_readdir_ex(
                self.raw,
                buf.as_mut_ptr().cast(),
                buf.len(),
                ptr::null_mut(),
                0,
                &mut stat,
            )
        };
        if rc == 0 {
            return Err(Error::from_errno(ErrorCode::Session(
                raw::LIBSSH2_ERROR_FILE,
            )));
        }
        self.sftp.rc(rc)?;
        buf.truncate(rc as usize);
        Ok((buf, FileStat::from_raw(&stat)))
    }
    pub(crate) fn stat(&self) -> Result<FileStat, Error> {
        let _guard = self.sftp.session.raw();
        let mut stat = unsafe { std::mem::zeroed() };
        self.sftp
            .rc(unsafe { raw::libssh2_sftp_fstat_ex(self.raw, &mut stat, 0) })?;
        Ok(FileStat::from_raw(&stat))
    }
    pub(crate) fn close(&mut self) -> Result<(), Error> {
        if self.raw.is_null() {
            return Ok(());
        }
        let _guard = self.sftp.session.raw();
        let rc = unsafe { raw::libssh2_sftp_close_handle(self.raw) };
        if rc != raw::LIBSSH2_ERROR_EAGAIN {
            self.raw = ptr::null_mut();
        }
        self.sftp.rc(rc)
    }
}
impl Drop for File<'_> {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
impl Read for File<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let _guard = self.sftp.session.raw();
        let rc = unsafe { raw::libssh2_sftp_read(self.raw, buf.as_mut_ptr().cast(), buf.len()) };
        if rc < 0 {
            Err(self.sftp.error(rc as i32).into())
        } else {
            Ok(rc as usize)
        }
    }
}
impl Write for File<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let _guard = self.sftp.session.raw();
        let rc = unsafe { raw::libssh2_sftp_write(self.raw, buf.as_ptr().cast(), buf.len()) };
        if rc < 0 {
            Err(self.sftp.error(rc as i32).into())
        } else {
            Ok(rc as usize)
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
