"""Read-only CSU IMAP adapter. Credentials stay on the Windows host."""
import base64
import ctypes
from ctypes import wintypes
from email import policy
from email.parser import BytesParser
from email.utils import parseaddr
from html.parser import HTMLParser
import imaplib
import json
import re
import ssl
import sys
import time

MAX_MESSAGE = 2 * 1024 * 1024
MAX_TEXT = 24000


class DataBlob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.c_void_p)]


def unprotect(ciphertext):
    encrypted = base64.b64decode(ciphertext, validate=True)
    buffer = ctypes.create_string_buffer(encrypted)
    source = DataBlob(len(encrypted), ctypes.addressof(buffer))
    output = DataBlob()
    unseal = ctypes.windll.crypt32.CryptUnprotectData
    unseal.argtypes = [ctypes.POINTER(DataBlob), ctypes.c_void_p, ctypes.c_void_p,
                       ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DataBlob)]
    unseal.restype = wintypes.BOOL
    if not unseal(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise PermissionError("credentials")
    try:
        return ctypes.string_at(output.data, output.size).decode("utf-16-le")
    finally:
        ctypes.memset(output.data, 0, output.size)
        release = ctypes.windll.kernel32.LocalFree
        release.argtypes = [ctypes.c_void_p]
        release.restype = ctypes.c_void_p
        release(output.data)


class PlainHtml(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "head"):
            self.hidden += 1
        elif not self.hidden and tag in ("br", "p", "div", "li", "tr", "h1", "h2", "h3"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head"):
            self.hidden = max(0, self.hidden - 1)
        elif not self.hidden and tag in ("p", "div", "li", "tr"):
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def parse_mail(raw, when):
    message = BytesParser(policy=policy.default).parsebytes(raw)
    sender = message.get("From")
    addresses = getattr(sender, "addresses", ())
    name, address = (addresses[0].display_name, addresses[0].addr_spec) if addresses else parseaddr(str(sender or ""))
    part = message.get_body(preferencelist=("plain", "html"))
    try:
        text = part.get_content(errors="replace") if part else ""
    except (LookupError, ValueError):
        decoded = part.get_payload(decode=True)
        text = decoded.decode("utf-8", errors="replace") if isinstance(decoded, bytes) else ""
    if part and part.get_content_type() == "text/html":
        html = PlainHtml()
        html.feed(text)
        text = "".join(html.parts)
    text = re.sub(r"\n[ \t]*\n(?:[ \t]*\n)+", "\n\n", text.replace("\r\n", "\n").replace("\x00", "")).strip()
    return dict(subject=str(message.get("Subject") or "（无主题）")[:300], sender=(name or address or "未知发件人")[:180],
                address=address.lower()[:254], receivedAt=when, body=text[:MAX_TEXT], truncated=len(text) > MAX_TEXT)


def fetch_mail(client, uid):
    status, items = client.uid("FETCH", str(uid), "(INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])")
    metadata = next((item for item in (items or []) if isinstance(item, tuple)), None) if status == "OK" else None
    if not metadata:
        if status != "OK":
            raise OSError("fetch")
        return None  # Expunged after the search.
    enrolled = imaplib.Internaldate2tuple(metadata[0])
    when = round(time.mktime(enrolled) * 1000) if enrolled else round(time.time() * 1000)
    size = re.search(rb"\bRFC822.SIZE (\d+)", metadata[0])
    if not size or int(size[1]) > MAX_MESSAGE:
        return {**parse_mail(metadata[1], when), "truncated": True}
    status, items = client.uid("FETCH", str(uid), f"(BODY.PEEK[]<0.{MAX_MESSAGE + 1}>)")
    data = next((item[1] for item in items if isinstance(item, tuple)), None) if status == "OK" else None
    if not data:
        raise OSError("body")
    result = parse_mail(data[:MAX_MESSAGE], when)
    result["truncated"] = result["truncated"] or len(data) > MAX_MESSAGE
    return result


def scan(client, previous_epoch, cursor):
    if client.select("INBOX", readonly=True)[0] != "OK":
        raise OSError("inbox")
    epoch = int(client.response("UIDVALIDITY")[1][0])
    initial = previous_epoch != epoch
    criteria = ("ALL",) if initial else ("UID", f"{cursor + 1}:*")
    status, data = client.uid("SEARCH", None, *criteria)
    if status != "OK":
        raise OSError("search")
    ids = sorted(uid for uid in map(int, data[0].split()) if initial or uid > cursor)
    batch = ids[-20:] if initial else ids[:20]
    rows = []
    for uid in batch:
        item = fetch_mail(client, uid)
        if item is not None:
            rows.append({**item, "uid": uid})
    return dict(epoch=epoch, initial=initial, cursor=batch[-1] if batch else (0 if initial else cursor),
                more=len(ids) > len(batch) and not initial, rows=rows)


def main(request):
    password = unprotect(request["secret"])
    with imaplib.IMAP4_SSL("mail.csu.edu.cn", 993, ssl_context=ssl.create_default_context(), timeout=12) as client:
        try:
            client.login(request["address"], password)
        except imaplib.IMAP4.error:
            return {"error": "login"}
        return scan(client, request.get("epoch"), request.get("cursor", 0))


if __name__ == "__main__":
    try:
        print(json.dumps(main(json.load(sys.stdin)), ensure_ascii=False))
    except (OSError, ValueError, TypeError, KeyError, imaplib.IMAP4.error, UnicodeError):
        print(json.dumps({"error": "connection"}))
