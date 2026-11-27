"""Fixed Windows actions for the paired Device Tools panel."""
import ctypes as c
from ctypes import wintypes as w
import json
import os
import subprocess
import sys
import time
import uuid

user = c.WinDLL("user32", use_last_error=True)
kernel = c.WinDLL("kernel32", use_last_error=True)
ole = c.WinDLL("ole32")
CF_UNICODETEXT = 13
CODEX_PACKAGE = "OpenAI.Codex_2p2nqsd0c76g0"
WINDOW_CALLBACK = c.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)


def bind(dll, name, result, *arguments):
    fn = getattr(dll, name)
    fn.restype = result
    fn.argtypes = arguments
    return fn


open_clipboard = bind(user, "OpenClipboard", w.BOOL, w.HWND)
close_clipboard = bind(user, "CloseClipboard", w.BOOL)
empty_clipboard = bind(user, "EmptyClipboard", w.BOOL)
clipboard_data = bind(user, "GetClipboardData", w.HANDLE, w.UINT)
set_clipboard_data = bind(user, "SetClipboardData", w.HANDLE, w.UINT, w.HANDLE)
has_clipboard_data = bind(user, "IsClipboardFormatAvailable", w.BOOL, w.UINT)
create_window = bind(user, "CreateWindowExW", w.HWND, w.DWORD, w.LPCWSTR, w.LPCWSTR,
                     w.DWORD, c.c_int, c.c_int, c.c_int, c.c_int, w.HWND, w.HMENU,
                     w.HINSTANCE, c.c_void_p)
destroy_window = bind(user, "DestroyWindow", w.BOOL, w.HWND)
global_alloc = bind(kernel, "GlobalAlloc", w.HANDLE, w.UINT, c.c_size_t)
global_lock = bind(kernel, "GlobalLock", c.c_void_p, w.HANDLE)
global_unlock = bind(kernel, "GlobalUnlock", w.BOOL, w.HANDLE)
global_free = bind(kernel, "GlobalFree", w.HANDLE, w.HANDLE)
global_size = bind(kernel, "GlobalSize", c.c_size_t, w.HANDLE)
execution_state = bind(kernel, "SetThreadExecutionState", w.DWORD, w.DWORD)
screen_message = bind(user, "SendNotifyMessageW", w.BOOL, w.HWND, w.UINT, w.WPARAM, w.LPARAM)
post_message = bind(user, "PostMessageW", w.BOOL, w.HWND, w.UINT, w.WPARAM, w.LPARAM)
lock_screen = bind(user, "LockWorkStation", w.BOOL)
session_id = bind(kernel, "ProcessIdToSessionId", w.BOOL, w.DWORD, c.POINTER(w.DWORD))
enum_windows = bind(user, "EnumWindows", w.BOOL, WINDOW_CALLBACK, w.LPARAM)
window_visible = bind(user, "IsWindowVisible", w.BOOL, w.HWND)
window_title_length = bind(user, "GetWindowTextLengthW", c.c_int, w.HWND)
window_owner = bind(user, "GetWindow", w.HWND, w.HWND, w.UINT)
window_process = bind(user, "GetWindowThreadProcessId", w.DWORD, w.HWND, c.POINTER(w.DWORD))
open_process = bind(kernel, "OpenProcess", w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
package_family = bind(kernel, "GetPackageFamilyName", w.LONG, w.HANDLE, c.POINTER(w.UINT), w.LPWSTR)
image_path = bind(kernel, "QueryFullProcessImageNameW", w.BOOL, w.HANDLE, w.DWORD, w.LPWSTR, c.POINTER(w.DWORD))
close_handle = bind(kernel, "CloseHandle", w.BOOL, w.HANDLE)

# Windows Core Audio COM interface identifiers.
GUID = c.c_ubyte * 16
MMDEVICE_ENUMERATOR = GUID.from_buffer_copy(uuid.UUID("BCDE0395-E52F-467C-8E3D-C4579291692E").bytes_le)
IID_DEVICE_ENUMERATOR = GUID.from_buffer_copy(uuid.UUID("A95664D2-9614-4F35-A746-DE8DB63617E6").bytes_le)
IID_ENDPOINT_VOLUME = GUID.from_buffer_copy(uuid.UUID("5CDF2C82-841E-4546-9722-0CF74078229A").bytes_le)
co_initialize = bind(ole, "CoInitializeEx", c.c_long, c.c_void_p, w.DWORD)
co_uninitialize = bind(ole, "CoUninitialize", None)
co_create_instance = bind(ole, "CoCreateInstance", c.c_long, c.POINTER(GUID), c.c_void_p,
                          w.DWORD, c.POINTER(GUID), c.POINTER(c.c_void_p))


def com_method(interface, slot, result, *arguments):
    table = c.cast(interface, c.POINTER(c.POINTER(c.c_void_p)))[0]
    return c.WINFUNCTYPE(result, c.c_void_p, *arguments)(table[slot])


def check_hresult(result):
    if result < 0:
        raise c.WinError(result)


def audio_mute(muted=None):
    check_hresult(co_initialize(None, 2))  # COINIT_APARTMENTTHREADED
    enumerator, device, volume = c.c_void_p(), c.c_void_p(), c.c_void_p()
    try:
        check_hresult(co_create_instance(c.byref(MMDEVICE_ENUMERATOR), None, 1,
                                         c.byref(IID_DEVICE_ENUMERATOR), c.byref(enumerator)))
        get_default_endpoint = com_method(enumerator, 4, c.c_long, c.c_int, c.c_int, c.POINTER(c.c_void_p))
        check_hresult(get_default_endpoint(enumerator, 0, 0, c.byref(device)))  # eRender, eConsole
        activate = com_method(device, 3, c.c_long, c.POINTER(GUID), w.DWORD, c.c_void_p, c.POINTER(c.c_void_p))
        check_hresult(activate(device, c.byref(IID_ENDPOINT_VOLUME), 1, None, c.byref(volume)))
        if muted is not None:
            set_mute = com_method(volume, 14, c.c_long, w.BOOL, c.c_void_p)
            check_hresult(set_mute(volume, muted, None))
        actual = w.BOOL()
        get_mute = com_method(volume, 15, c.c_long, c.POINTER(w.BOOL))
        check_hresult(get_mute(volume, c.byref(actual)))
        return {"muted": bool(actual.value)}
    finally:
        for interface in (volume, device, enumerator):
            if interface:
                com_method(interface, 2, w.ULONG)(interface)  # IUnknown::Release
        co_uninitialize()


def shutdown_computer():
    executable = os.path.join(os.environ["SystemRoot"], "System32", "shutdown.exe")
    result = subprocess.run([executable, "/s", "/t", "0"], capture_output=True,
                            timeout=4, creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        raise RuntimeError(f"Windows declined shutdown ({result.returncode}).")


def checked(value):
    if not value:
        raise c.WinError(c.get_last_error())
    return value


def require_desktop_session():
    session = w.DWORD()
    checked(session_id(os.getpid(), c.byref(session)))
    if not session.value:
        raise RuntimeError("An interactive Windows user session is required.")


def desktop_windows(target=None):
    windows = []

    @WINDOW_CALLBACK
    def visit(window, _):
        if not window_visible(window) or not window_title_length(window) or window_owner(window, 4):  # GW_OWNER
            return True
        pid = w.DWORD()
        window_process(window, c.byref(pid))
        process = open_process(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not process:
            return True
        try:
            if target:
                path = c.create_unicode_buffer(32768)
                length = w.DWORD(len(path))
                found = bool(image_path(process, 0, path, c.byref(length))) and os.path.normcase(path.value) == target
            else:
                family = c.create_unicode_buffer(128)
                length = w.UINT(len(family))
                found = package_family(process, c.byref(length), family) == 0 and family.value == CODEX_PACKAGE
            if found:
                windows.append(window)
            return True
        finally:
            close_handle(process)

    enum_windows(visit, 0)
    return windows


def request_desktop_close(windows):
    for window in windows:
        # WM_CLOSE follows the application's normal close path, including any dialogs.
        checked(post_message(window, 0x0010, 0, 0))
    return {"opened": bool(windows)}


def clipboard(text=None):
    # A window must own the clipboard when calling EmptyClipboard then SetClipboardData.
    window = checked(create_window(0, "STATIC", "", 0, 0, 0, 0, 0, None, None, None, None))
    try:
        for attempt in range(10):
            if open_clipboard(window):
                break
            if attempt == 9:
                raise RuntimeError("Windows clipboard is busy.")
            time.sleep(0.05)
        try:
            if text is None:
                if not has_clipboard_data(CF_UNICODETEXT):
                    return {"text": ""}
                item = checked(clipboard_data(CF_UNICODETEXT))
                size = global_size(item)
                if size > 256 * 1024:
                    raise RuntimeError("Clipboard text is too large.")
                ptr = checked(global_lock(item))
                try:
                    return {"text": c.string_at(ptr, size & ~1).decode("utf-16-le", errors="replace").split("\0", 1)[0]}
                finally:
                    global_unlock(item)
            encoded = text.encode("utf-16-le") + b"\0\0"
            item = checked(global_alloc(2, len(encoded)))  # GMEM_MOVEABLE
            try:
                ptr = checked(global_lock(item))
                try:
                    c.memmove(ptr, encoded, len(encoded))
                finally:
                    global_unlock(item)
                checked(empty_clipboard())
                checked(set_clipboard_data(CF_UNICODETEXT, item))
                item = None  # Ownership passed to Windows.
            finally:
                if item:
                    global_free(item)
            return {}
        finally:
            close_clipboard()
    finally:
        destroy_window(window)


def send(result=None, error=None):
    print(json.dumps({"ok": not error, **(result or {}), **({"error": error} if error else {})}), flush=True)


def handle(request):
    require_desktop_session()
    action = request["action"]
    if action == "clipboard-read":
        send(clipboard())
    elif action == "clipboard-write":
        send(clipboard(request["text"]))
    elif action == "lock":
        checked(lock_screen())
        send()
    elif action == "audio-mute-read":
        send(audio_mute())
    elif action == "audio-mute-write":
        muted = request["muted"]
        if type(muted) is not bool:
            raise ValueError("The mute state must be a boolean.")
        send(audio_mute(muted))
    elif action == "shutdown":
        shutdown_computer()
        send()
    elif action == "open":
        os.startfile(request["target"])
        send()
    elif action in ("antigravity-status", "antigravity-open", "antigravity-close"):
        target = request["target"]
        windows = desktop_windows(os.path.normcase(target))
        if action == "antigravity-close":
            send(request_desktop_close(windows))
            return
        opened = bool(windows)
        if not opened and action == "antigravity-open":
            os.startfile(target, cwd=os.path.dirname(target))
        send({"opened": opened})
    elif action in ("codex-status", "codex-open", "codex-close"):
        windows = desktop_windows()
        if action == "codex-close":
            send(request_desktop_close(windows))
            return
        opened = bool(windows)
        if not opened and action == "codex-open":
            os.startfile("shell:AppsFolder\\" + CODEX_PACKAGE + "!App")
        send({"opened": opened})
    elif action == "hold":
        checked(execution_state(0x80000001))  # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
        try:
            checked(screen_message(0xffff, 0x0112, 0xf170, 2))
            send()
            # The host closes stdin when the lease expires, is canceled or the host exits.
            sys.stdin.read(1)
        finally:
            execution_state(0x80000000)
    else:
        raise ValueError("Unsupported operation")


if __name__ == "__main__":
    try:
        handle(json.loads(sys.stdin.readline()))
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        send(error=str(exc))
