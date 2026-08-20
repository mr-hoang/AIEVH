# -*- coding: utf-8 -*-
"""
Worker VieNeu-TTS - doc lenh JSON tren stdin, tra ket qua JSON tren stdout.

VI SAO LA MOT TIEN TRINH SONG LAU (khong phai moi lan goi mot lan chay python):
nap model het 15,5s khi da co san trong cache va ~31s lan dau (phai tai ~1GB tu
HuggingFace). Neu moi cau doc lai spawn mot tien trinh moi thi rieng phan nap
model da dat gap chuc lan phan tong hop. Node giu mot worker duy nhat, xep hang
cac yeu cau, va tat no sau 10 phut khong dung (model chiem ~1GB RAM).

GIAO THUC: MOI DONG stdout la MOT doi tuong JSON - khong duoc lan bat cu thu gi
khac vao do. Moi log/canh bao/thanh tien do deu phai di stderr. Xem phan doi fd
ben duoi: thu vien C (onnxruntime, transformers) in thang vao fd 1, redirect o
muc Python khong chan duoc.

Tat ca chu thich trong file nay co y viet KHONG DAU: file chay bang Python tren
Windows, va console mac dinh cp1252 - de nguyen tieng Viet co dau trong ma nguon
thi chi can mot loi trace bat ky in ra la vo het.
"""

import sys

# BAT BUOC va phai dung dau tien: console Windows mac dinh cp1252, khong
# reconfigure thi ten giong tieng Viet ("Minh Duc" co dau) vo thanh ky tu rac.
# Cung ly do voi apps/server/src/transcribe.ts.
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8")

import json
import os
import traceback
import unicodedata
import wave

# ---------------------------------------------------------------------------
# Tach kenh giao thuc ra khoi stdout
# ---------------------------------------------------------------------------

# Giu MOT ban sao cua fd 1 rieng cho giao thuc, roi tro fd 1 sang fd 2. Tu day
# moi thu in ra "man hinh" (ke ca thanh tien do cua transformers/tqdm va cac
# dong C cua onnxruntime in THANG vao fd 1) deu roi sang stderr, khong the lam
# hong dong JSON. contextlib.redirect_stdout KHONG du: no chi doi sys.stdout o
# muc Python, thu vien C viet thang vao fd nen van lot.
_protocol_fd = os.dup(1)
os.dup2(2, 1)
_protocol = os.fdopen(_protocol_fd, "w", encoding="utf-8", newline="\n")


def log(msg):
    """Chan doan cho Node doc - LUON di stderr."""
    print("[vieneu] " + str(msg), file=sys.stderr)
    sys.stderr.flush()


def respond(obj):
    _protocol.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _protocol.flush()


# ---------------------------------------------------------------------------
# Nap model (lazy)
# ---------------------------------------------------------------------------

_tts = None
# None = chua biet; True/False = da thu vá torchaudio khi nap model
_clone_ready = None


def vieneu_version():
    try:
        import importlib.metadata as meta

        return meta.version("vieneu")
    except Exception:
        return ""


def torch_importable():
    """
    Nhan ban giong co chay duoc khong.

    Chi dung importlib.util.find_spec (khong import that) vi ham nay phuc vu
    lenh `ping` - lenh dung de kiem tra nhanh, khong duoc ton 2s import torch.
    Node lam phep kiem ky hon (import that torch + torchaudio + soundfile) o
    buoc probe rieng cua no.
    """
    try:
        import importlib.util as util

        return all(util.find_spec(m) is not None for m in ("torch", "torchaudio", "soundfile"))
    except Exception:
        return False


def patch_torchaudio():
    """
    Thay torchaudio.load bang soundfile.

    LY DO (da kiem chung tren may nay): duong nhan ban giong goi
    torchaudio.load(), ma tu torchaudio 2.9 tro di ham do doi torchcodec KEM
    THEO thu vien dong cua FFmpeg. Tren Windows gan nhu luon that bai voi
    "Could not load libtorchcodec". soundfile von da la phu thuoc cua vieneu nen
    doc WAV bang no khong them gi phai cai, va sau khi va thi nhan ban chi con
    can torch + torchaudio.

    Tra False neu khong co torch - luc do giong DUNG SAN van chay binh thuong
    (nhanh v3turbo tren CPU chay bang ONNX, khong dinh torch), chi rieng nhan
    ban giong la khong dung duoc.
    """
    try:
        import soundfile as sf
        import torch
        import torchaudio

        def _load(uri, *args, **kwargs):
            data, sr = sf.read(str(uri), dtype="float32", always_2d=True)
            return torch.from_numpy(data.T).contiguous(), sr

        torchaudio.load = _load
        return True
    except Exception as err:
        log("khong va duoc torchaudio (%s) - nhan ban giong se khong dung duoc" % str(err)[:200])
        return False


def get_tts():
    global _tts, _clone_ready
    if _tts is not None:
        return _tts
    # Va TRUOC khi import vieneu: vieneu keo torchaudio vao tu luc import, va
    # ban va phai co mat truoc khi bat ky doan nao giu tham chieu toi ham cu.
    _clone_ready = patch_torchaudio()
    from vieneu import Vieneu

    log("nap model v3turbo (lan dau co the mat ~31s vi phai tai ~1GB)")
    _tts = Vieneu()
    log("da nap model - sample_rate=%s" % getattr(_tts, "sample_rate", "?"))
    return _tts


# ---------------------------------------------------------------------------
# Doc thuoc tinh giong
# ---------------------------------------------------------------------------

GENDER_MAP = {"male": "nam", "female": "nu", "nam": "nam", "nu": "nu"}
# 'doc_truyen' la ma trong goi Python; nhan hien cho nguoi dung la "ke chuyen"
STYLE_MAP = {"tin_tuc": "tin-tuc", "tu_nhien": "tu-nhien", "doc_truyen": "ke-chuyen"}
REGION_MAP = {"bac": "bac", "trung": "trung", "nam": "nam"}


def plain(text):
    """Bo dau tieng Viet + ha chu thuong - de so khop 'Bac'/'Bắc' nhu nhau."""
    s = unicodedata.normalize("NFD", str(text or ""))
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.replace("đ", "d").replace("Đ", "d").strip().lower()


def parse_description(desc):
    """
    Tach mo ta dang "Nam · Bắc · Phong cách tin tức" thanh 3 manh THEO VI TRI.

    CAI BAY: manh 1 la GIOI TINH, manh 2 la VUNG MIEN, va ca hai deu co the la
    chu "Nam" voi hai nghia khac han nhau (Thai Son = gioi tinh nam + vung mien
    nam). Vi vay TUYET DOI khong duoc di tim chuoi "Nam" trong ca cau roi suy ra
    - phai cat theo dau '·' va lay dung chi so.
    """
    parts = [p.strip() for p in str(desc or "").split("·")]
    while len(parts) < 3:
        parts.append("")
    return parts[0], parts[1], parts[2]


def voice_meta(name, preset):
    """
    Mot preset -> {name, gender, region, style}, hoac None neu khong doc noi.

    Uu tien truong CO CAU TRUC cua goi (preset['gender'] = 'male'/'female',
    preset['style'] = 'tin_tuc'/'tu_nhien'/'doc_truyen') vi do la du lieu goc,
    khong phai chuoi hien thi. Chi rieng VUNG MIEN la khong co truong rieng nen
    bat buoc phai doc tu mo ta theo vi tri.

    Tra None khi khong xac dinh duoc vung mien. Do KHONG phai su khat khe thua:
    moi giong nhan ban ma ai do lo tay ghi de vao file cua goi (goi save_voices)
    se hien ra o day nhu mot "giong dung san" khong co mo ta - da gap that tren
    may nay, xem ghi chu o ttsLocal.ts. Loc o day la cach re nhat de kho giong
    dung san luon sach.
    """
    desc = preset.get("description") if isinstance(preset, dict) else ""
    d_gender, d_region, d_style = parse_description(desc)

    gender = GENDER_MAP.get(plain(preset.get("gender") if isinstance(preset, dict) else ""))
    if gender is None:
        gender = GENDER_MAP.get(plain(d_gender))

    style = STYLE_MAP.get(plain(preset.get("style") if isinstance(preset, dict) else "").replace("-", "_"))
    if style is None:
        # Du phong: doc tu cum "Phong cách <tin tức|tự nhiên|kể chuyện>"
        p = plain(d_style)
        if "tin tuc" in p:
            style = "tin-tuc"
        elif "ke chuyen" in p or "doc truyen" in p:
            style = "ke-chuyen"
        elif "tu nhien" in p:
            style = "tu-nhien"

    region = REGION_MAP.get(plain(d_region))
    if region is None or gender is None or style is None:
        log("bo qua giong '%s' - mo ta khong doc duoc (%r)" % (name, desc))
        return None
    return {"name": name, "gender": gender, "region": region, "style": style}


def preset_style(tts, name):
    """
    Phong cach dang ky kem giong - PHAI truyen lai khi infer.

    infer() mac dinh style='tu_nhien'; goi giong 'ke chuyen' ma de mac dinh thi
    doc ra khong dung chat giong ma nguoi dung chon.
    """
    try:
        preset = tts.get_preset_voice(name)
        s = preset.get("style") if isinstance(preset, dict) else None
        return s if isinstance(s, str) and s else "tu_nhien"
    except Exception:
        return "tu_nhien"


def wav_duration(path):
    """
    Thoi luong THAT cua file vua ghi - doc header WAV, khong uoc luong theo so
    ky tu (uoc luong lech toi hang chuc phan tram, xem ghi chu o tts.ts).
    """
    with wave.open(path, "rb") as w:
        frames = w.getnframes()
        rate = w.getframerate()
        if rate <= 0:
            raise RuntimeError("file WAV bao sample rate = %s" % rate)
        return frames / float(rate), rate


# ---------------------------------------------------------------------------
# Cac lenh
# ---------------------------------------------------------------------------


def cmd_ping(_req):
    return {"ok": True, "clone": bool(torch_importable()), "version": vieneu_version()}


def cmd_voices(_req):
    tts = get_tts()
    out = []
    for _label, name in tts.list_preset_voices():
        try:
            preset = tts.get_preset_voice(name)
        except Exception:
            preset = {}
        meta = voice_meta(name, preset)
        if meta is not None:
            out.append(meta)
    return {"ok": True, "voices": out}


def cmd_register(req):
    voice = str(req.get("voice") or "").strip()
    ref = str(req.get("ref") or "").strip()
    if not voice:
        return {"ok": False, "code": "BAD_REQUEST", "message": "thieu ten giong (voice)"}
    if not ref or not os.path.isfile(ref):
        return {"ok": False, "code": "REF_NOT_FOUND", "message": "khong thay file mau: %s" % ref}
    tts = get_tts()
    if not _clone_ready:
        return {
            "ok": False,
            "code": "NO_TORCH",
            "message": "thieu torch/torchaudio nen khong nhan ban duoc giong",
        }
    # save=False la BAT BUOC: save=True ghi thang vao file voices cua goi trong
    # site-packages, tuc la lam ban cai dat Python chung cua may. Kho giong cua
    # he thong nam o assets/voices/, worker dang ky lai moi lan khoi dong.
    tts.add_voice(voice, ref, denoise=True, description="", gender="", save=False)
    return {"ok": True}


def cmd_synth(req):
    text = str(req.get("text") or "").strip()
    voice = str(req.get("voice") or "").strip()
    out_path = str(req.get("out") or "").strip()
    if not text:
        return {"ok": False, "code": "EMPTY_TEXT", "message": "khong co chu nao de doc"}
    if not voice:
        return {"ok": False, "code": "BAD_REQUEST", "message": "thieu ten giong (voice)"}
    if not out_path:
        return {"ok": False, "code": "BAD_REQUEST", "message": "thieu duong dan file ra (out)"}

    tts = get_tts()
    parent = os.path.dirname(out_path)
    if parent:
        os.makedirs(parent, exist_ok=True)

    # apply_watermark de NGUYEN mac dinh True: thuy van Perth khong nghe thay
    # duoc, va voi giong nhan ban thi giu no la cach hanh xu co trach nhiem -
    # audio van truy nguoc duoc la do may sinh ra. Dung tat di de "cho sach".
    audio = tts.infer(text, voice=voice, style=preset_style(tts, voice))
    if audio is None or len(audio) == 0:
        return {"ok": False, "code": "EMPTY_AUDIO", "message": "model tra ve audio rong"}
    tts.save(audio, out_path)
    if not os.path.isfile(out_path):
        return {"ok": False, "code": "SYNTH_FAILED", "message": "khong ghi duoc file %s" % out_path}
    duration, rate = wav_duration(out_path)
    return {"ok": True, "durationSec": round(duration, 3), "sampleRate": rate}


HANDLERS = {
    "ping": cmd_ping,
    "voices": cmd_voices,
    "register": cmd_register,
    "synth": cmd_synth,
}


def error_code(err):
    """Doi loi Python thanh ma ngan cho Node phan loai."""
    text = "%s: %s" % (type(err).__name__, err)
    low = text.lower()
    if "no module named" in low or "modulenotfound" in low:
        return "NO_VIENEU"
    if "not found" in low and "voice" in low:
        return "VOICE_NOT_FOUND"
    return "LOAD_FAILED" if _tts is None else "SYNTH_FAILED"


def main():
    log("worker san sang (chua nap model)")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as err:
            # Khong biet id nen tra id 0; Node se ghi log chu khong khop pending
            respond({"id": 0, "ok": False, "code": "BAD_JSON", "message": str(err)[:200]})
            continue
        req_id = req.get("id") if isinstance(req, dict) else 0
        cmd = str(req.get("cmd") or "") if isinstance(req, dict) else ""
        handler = HANDLERS.get(cmd)
        if handler is None:
            respond({"id": req_id, "ok": False, "code": "UNKNOWN_CMD", "message": "lenh la: %s" % cmd})
            continue
        try:
            result = handler(req)
        except Exception as err:
            # KHONG duoc chet vi mot yeu cau hong: nap lai model ton 15-31s, ma
            # loi thuong chi la mot cau chu hoac mot file mau xau.
            log("loi khi chay '%s':\n%s" % (cmd, traceback.format_exc()))
            result = {"ok": False, "code": error_code(err), "message": "%s: %s" % (type(err).__name__, err)}
        result["id"] = req_id
        respond(result)
    log("stdin dong - worker thoat")


if __name__ == "__main__":
    main()
