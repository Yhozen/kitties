#!/usr/bin/env python3
"""Single-threaded, bounded JSONL bridge to agent-desktop 1.1.0 / ABI 7.

Runs as the desktop UID, never with channel credentials. The supervisor kills
this process on timeout; an interrupted mutation is never automatically retried.
"""
import ctypes as c
import json
import re
import sys
import uuid


class Scroll(c.Structure):
    _fields_ = [("direction", c.c_int32), ("amount", c.c_uint32)]


class Key(c.Structure):
    _fields_ = [("key", c.c_char_p), ("modifiers", c.POINTER(c.c_int32)),
                ("modifier_count", c.c_uint32)]


class Point(c.Structure):
    _fields_ = [("x", c.c_double), ("y", c.c_double)]


class Drag(c.Structure):
    _fields_ = [("from_", Point), ("to", Point), ("duration_ms", c.c_uint64),
                ("drop_delay_ms", c.c_uint64)]


class Action(c.Structure):
    _fields_ = [("kind", c.c_int32), ("text", c.c_char_p), ("scroll", Scroll),
                ("key", Key), ("drag", Drag)]


class Delivery(c.Structure):
    _fields_ = [("delivery", c.c_int32), ("retry", c.c_int32)]


def bind(lib, name, result, *args):
    fn = getattr(lib, name)
    fn.restype, fn.argtypes = result, list(args)
    return fn


def emit(value):
    line = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    if len(line) >= 65536:
        raise ValueError("oversize response")
    print(line, flush=True)


def main():
    lib = c.CDLL(sys.argv[1] if len(sys.argv) > 1 else
                 "/usr/local/lib/kittyd/libagent_desktop_ffi.so")
    init = bind(lib, "ad_init", c.c_int32, c.c_uint32)
    size = bind(lib, "ad_action_size", c.c_size_t)
    if init(7) != 0 or size() != c.sizeof(Action) or c.sizeof(Action) != 96:
        raise RuntimeError("incompatible ABI")
    create = bind(lib, "ad_adapter_create_with_session", c.c_void_p, c.c_char_p)
    destroy = bind(lib, "ad_adapter_destroy", None, c.c_void_p)
    free = bind(lib, "ad_free_string", None, c.c_void_p)
    snapshot = bind(lib, "ad_snapshot", c.c_int32, c.c_void_p, c.c_char_p,
                    c.c_int32, c.c_uint8, c.c_bool, c.c_bool, c.POINTER(c.c_void_p))
    execute = bind(lib, "ad_execute_by_ref_timeout", c.c_int32, c.c_void_p,
                   c.c_char_p, c.POINTER(Action), c.c_int32, c.c_int64,
                   c.POINTER(c.c_void_p))
    disposition = bind(lib, "ad_last_error_delivery_semantics", c.c_int32,
                       c.POINTER(Delivery))
    strnlen = bind(c.CDLL(None), "strnlen", c.c_size_t, c.c_void_p, c.c_size_t)
    # A fresh namespace after a crash makes old refs fail closed.
    adapter = create(("kittyd-" + uuid.uuid4().hex).encode())
    if not adapter:
        raise RuntimeError("adapter unavailable")
    try:
        emit({"ready": 1})
        while True:
            line = sys.stdin.buffer.readline(32769)
            if not line:
                break
            if len(line) > 32768 or not line.endswith(b"\n"):
                raise ValueError("invalid input")
            body = json.loads(line)
            action = body.get("action")
            if action not in ("ui_read", "ui_click", "ui_type"):
                raise ValueError("invalid action")
            if action != "ui_read":
                ref = body.get("ref", "")
                if not isinstance(ref, str) or not re.fullmatch(r"@[a-zA-Z0-9_-]{3,64}:e[1-9][0-9]{0,9}", ref):
                    raise ValueError("invalid ref")
                text = body.get("text", "")
                if not isinstance(text, str) or len(text) > 4000 or "\0" in text:
                    raise ValueError("invalid text")
            out = c.c_void_p()
            try:
                if action == "ui_read":
                    rc = snapshot(adapter, None, 0, 10, False, False, c.byref(out))
                else:
                    act = Action()  # Zero every unused field before crossing the ABI.
                    act.kind = 0 if action == "ui_click" else 17
                    act.text = text.encode() if action == "ui_type" else None
                    rc = execute(adapter, ref.encode(), c.byref(act), 0, 5000, c.byref(out))
                delivery = Delivery()
                if rc != 0:
                    disposition(c.byref(delivery))
                envelope = None
                if out.value:
                    length = strnlen(out, 65536)
                    if length >= 65536:
                        raise ValueError("oversize native result")
                    envelope = json.loads(c.string_at(out, length))
                if rc == 0 and isinstance(envelope, dict) and envelope.get("ok") is True:
                    status = "completed"
                elif action == "ui_read" or delivery.delivery == 1:
                    status = "failed"
                else:
                    status = "unknown"
                emit({"status": status, "result": json.dumps(envelope, separators=(",", ":"))
                      if envelope else "PERCEPTION_UNAVAILABLE"})
            finally:
                free(out)
    finally:
        destroy(adapter)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Even native error details can include private screen text.
        sys.exit(1)
