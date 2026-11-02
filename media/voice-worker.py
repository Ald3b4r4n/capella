"""Long-lived Whisper worker for Capella (faster-whisper on CPU).

Protocol: one JSON object per line on stdin, one JSON object per line on stdout.
  {"id": 1, "op": "ping"}
  {"id": 2, "op": "load", "model": "base", "cache": "<dir>", "offline": false}
  {"id": 3, "op": "transcribe", "path": "<wav>", "model": "base", "language": "pt" | null,
   "cache": "<dir>", "offline": true}
Every reply carries the request's id and "ok". The model is loaded on first use and kept until the
process exits (the extension stops an idle worker to give the memory back). Nothing is sent anywhere:
after setup the extension runs with "offline": true, so no network access is attempted.
"""
import json
import os
import sys
import time

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

_model = None
_loaded = None


def reply(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def get_model(name, cache, offline):
    global _model, _loaded
    if _model is not None and _loaded == name:
        return _model, 0
    from faster_whisper import WhisperModel

    started = time.time()
    _model = WhisperModel(
        name,
        device="cpu",
        compute_type="int8",
        download_root=cache or None,
        local_files_only=bool(offline),
    )
    _loaded = name
    return _model, int((time.time() - started) * 1000)


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        rid = req.get("id")
        op = req.get("op")
        try:
            if op == "ping":
                import faster_whisper

                reply({"id": rid, "ok": True, "version": getattr(faster_whisper, "__version__", "unknown"), "python": sys.version.split()[0]})
            elif op == "load":
                _, load_ms = get_model(req.get("model", "base"), req.get("cache"), req.get("offline", False))
                reply({"id": rid, "ok": True, "loadMs": load_ms})
            elif op == "transcribe":
                model, load_ms = get_model(req.get("model", "base"), req.get("cache"), req.get("offline", False))
                started = time.time()
                segments, info = model.transcribe(
                    req["path"],
                    language=req.get("language") or None,
                    beam_size=1,
                    vad_filter=True,
                    condition_on_previous_text=False,
                )
                text = " ".join(s.text.strip() for s in segments).strip()
                reply({
                    "id": rid,
                    "ok": True,
                    "text": text,
                    "language": info.language,
                    "languageProbability": round(float(info.language_probability), 3),
                    "audioSeconds": round(float(info.duration), 2),
                    "loadMs": load_ms,
                    "transcribeMs": int((time.time() - started) * 1000),
                })
            else:
                reply({"id": rid, "ok": False, "error": "unknown op: %s" % op})
        except Exception as exc:  # report, never die: the extension decides what to do
            reply({"id": rid, "ok": False, "error": "%s: %s" % (type(exc).__name__, exc)})


if __name__ == "__main__":
    main()
