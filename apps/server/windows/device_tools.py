"""Fixed Windows actions for the paired Device Tools panel."""
import ctypes as c
from ctypes import wintypes as w
import json
import os
import sys
import time

user = c.WinDLL("user32", use_last_error=True)
kernel = c.WinDLL("kernel32", use_last_error=True)
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


def checked(value):
    if not value:
        raise c.WinError(c.get_last_error())
    return value


def require_desktop_session():
    session = w.DWORD()
    checked(session_id(os.getpid(), c.byref(session)))
    if not session.value:
        raise RuntimeError("An interactive Windows user session is required.")


def desktop_window_open(target=None):
    found = False

    @WINDOW_CALLBACK
    def visit(window, _):
        nonlocal found
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
            return not found
        finally:
            close_handle(process)

    enum_windows(visit, 0)
    return found


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
    elif action == "open":
        os.startfile(request["target"])
        send()
    elif action in ("antigravity-status", "antigravity-open"):
        target = request["target"]
        opened = desktop_window_open(os.path.normcase(target))
        if not opened and action == "antigravity-open":
            os.startfile(target, cwd=os.path.dirname(target))
        send({"opened": opened})
    elif action == "codex-status" or action == "codex-open":
        opened = desktop_window_open()
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
    except (OSError, ValueError, RuntimeError) as exc:
        send(error=str(exc))
