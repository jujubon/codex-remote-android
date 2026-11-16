import ctypes
from ctypes import wintypes
import os
from typing import Any

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
WINDOWS_EPOCH_OFFSET_SECONDS = 11644473600

def _query_process_identity(pid: int) -> dict[str, Any]:
    """Return enough identity data to detect Windows PID reuse.

    A PID is only a temporary handle.  The state files therefore carry the
    process image and creation time as well.  The creation time is the
    decisive field: Windows may reuse a PID for an unrelated process after a
    managed process exits.
    """
    if pid <= 0:
        return {"process_image": "", "process_start_time": None}
    if os.name != "nt":
        try:
            image = os.path.realpath(f"/proc/{pid}/exe")
        except OSError:
            image = ""
        return {"process_image": image, "process_start_time": None}

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    open_process = kernel32.OpenProcess
    open_process.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    open_process.restype = ctypes.c_void_p
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [ctypes.c_void_p]
    close_handle.restype = ctypes.c_int
    handle = open_process(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return {"process_image": "", "process_start_time": None}
    try:
        return _query_process_handle_identity(kernel32, handle)
    finally:
        close_handle(handle)


def _query_process_handle_identity(kernel32: Any, handle: Any) -> dict[str, Any]:
    """Read identity from the same handle that an eventual stop will use."""
    query_path = kernel32.QueryFullProcessImageNameW
    query_path.argtypes = [ctypes.c_void_p, ctypes.c_ulong, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    query_path.restype = ctypes.c_int
    get_times = kernel32.GetProcessTimes
    get_times.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
    ]
    get_times.restype = ctypes.c_int

    image = ""
    size = wintypes.DWORD(32768)
    buffer = ctypes.create_unicode_buffer(size.value)
    if query_path(handle, 0, buffer, ctypes.byref(size)):
        image = buffer.value

    creation = wintypes.FILETIME()
    exit_time = wintypes.FILETIME()
    kernel_time = wintypes.FILETIME()
    user_time = wintypes.FILETIME()
    start_time: float | None = None
    if get_times(
        handle,
        ctypes.byref(creation),
        ctypes.byref(exit_time),
        ctypes.byref(kernel_time),
        ctypes.byref(user_time),
    ):
        ticks = (int(creation.dwHighDateTime) << 32) | int(creation.dwLowDateTime)
        start_time = ticks / 10_000_000 - WINDOWS_EPOCH_OFFSET_SECONDS
    return {"process_image": image, "process_start_time": start_time}


