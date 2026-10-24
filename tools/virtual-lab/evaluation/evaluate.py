"""Fixed synthetic-only audio/quality lane. Never print input or provider errors."""

from __future__ import annotations

import argparse
import array
import copy
import hashlib
import json
import math
import re
import subprocess
import sys
import uuid
import wave
from pathlib import Path

TRUTH_PATH = Path(__file__).with_name("visit.json")
MAX_INPUT = 1_048_576
if not __debug__:
    print('{"status":"evaluation_failed","failure_code":"python_optimization_unsupported"}')
    raise SystemExit(2)


def truth() -> dict:
    value = json.loads(TRUTH_PATH.read_text())
    assert value["synthetic_only"] and value["all_parties_consented"]
    uuid.UUID(value["consent_record_id"])
    return value


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value: dict) -> None:
    with path.open("x", encoding="utf-8") as out:
        json.dump(value, out, indent=2)
    path.chmod(0o600)


def audio_stats(pcm: bytes, *, speech: bool) -> dict:
    assert len(pcm) > 0 and len(pcm) % 2 == 0
    samples = array.array("h", pcm)
    if sys.byteorder != "little":
        samples.byteswap()
    nonzero = sum(sample != 0 for sample in samples)
    rms = math.sqrt(sum(sample * sample for sample in samples) / len(samples))
    if speech:
        # Reject empty output, silence, and a lone impulse masquerading as speech.
        assert nonzero >= 1600 and rms >= 1
    else:
        assert len(samples) >= 16000 and nonzero == 0
    return {
        "frames": len(samples),
        "duration_ms": round(len(samples) / 16, 3),
        "nonzero_frames": nonzero,
        "rms_pcm16": round(rms, 3),
        "peak_pcm16": max(abs(sample) for sample in samples),
    }


def read_wave(path: Path, *, speech: bool) -> tuple[bytes, dict]:
    assert not path.is_symlink() and 44 <= path.stat().st_size <= 32_000_000
    with wave.open(str(path), "rb") as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) == (
            1,
            2,
            16000,
            "NONE",
        )
        frames = wav.getnframes()
        assert 0 < frames <= 16_000_000
        pcm = wav.readframes(frames)
        assert len(pcm) == frames * 2
    return pcm, audio_stats(pcm, speech=speech)


def validate_manifest(value: dict, folder: Path) -> None:
    reference = truth()
    assert value["schema_version"] == 1 and value["synthetic_only"] is True
    assert (
        value["case_id"] == reference["case_id"]
        and value["consent_record_id"] == reference["consent_record_id"]
    )
    assert value["truth_sha256"] == digest(TRUTH_PATH.read_bytes())
    consent_path = folder / "consent.json"
    assert not consent_path.is_symlink() and consent_path.stat().st_size <= 16384
    consent = json.loads(consent_path.read_text())
    assert consent == {
        "synthetic_only": True,
        "all_parties_consented": True,
        "consent_record_id": reference["consent_record_id"],
        "case_id": reference["case_id"],
    }
    assert set(value["files"]) == {"visit.wav", "silence.wav"}
    # Consent has been checked before any WAV processing.
    for name, expected in value["files"].items():
        path = folder / name
        assert not path.is_symlink() and path.stat().st_size <= 32_000_000
        assert digest(path.read_bytes()) == expected
    pcm, stats = read_wave(folder / "visit.wav", speech=True)
    read_wave(folder / "silence.wav", speech=False)
    timeline = value["timeline"]
    assert isinstance(timeline, list) and len(timeline) == len(reference["turns"])
    previous = 0
    for i, (entry, turn) in enumerate(zip(timeline, reference["turns"], strict=True)):
        start, end = entry["start_frame"], entry["end_frame"]
        assert (
            type(start) is int and type(end) is int and previous <= start < end <= stats["frames"]
        )
        assert entry["turn"] == i and entry["speaker_role"] == turn["speaker_role"]
        assert entry["start_ms"] == start // 16 and entry["end_ms"] == end // 16
        assert not any(pcm[previous * 2 : start * 2])
        audio_stats(pcm[start * 2 : end * 2], speech=True)
        previous = end
    assert not any(pcm[previous * 2 :])


def fixtures(output: Path) -> dict:
    value = truth()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    # Consent precedes synthesis or audio processing. This is invented test consent.
    write_json(
        output / "consent.json",
        {
            "synthetic_only": True,
            "all_parties_consented": True,
            "consent_record_id": value["consent_record_id"],
            "case_id": value["case_id"],
        },
    )
    silence = bytes(16000 * 2 * 2)
    timeline, audio, cursor, turns = [], bytearray(), 0, []
    for i, turn in enumerate(value["turns"]):
        part = output / f"turn-{i}.wav"
        subprocess.run(
            [
                "/usr/bin/say",
                "-v",
                turn["voice"],
                "--file-format=WAVE",
                "--data-format=LEI16@16000",
                "-o",
                str(part),
                turn["content"],
            ],
            check=True,
            timeout=60,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        part.chmod(0o600)
        pcm, stats = read_wave(part, speech=True)
        turns.append({"turn": i, **stats})
        audio.extend(pcm)
        end = cursor + stats["frames"]
        timeline.append(
            {
                "turn": i,
                "speaker_role": turn["speaker_role"],
                "start_frame": cursor,
                "end_frame": end,
                "start_ms": cursor // 16,
                "end_ms": end // 16,
            }
        )
        audio.extend(silence)
        cursor = end + len(silence) // 2
    for name, pcm in (("visit.wav", audio), ("silence.wav", silence)):
        with wave.open(str(output / name), "wb") as wav:
            wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            wav.writeframes(pcm)
        (output / name).chmod(0o600)
    manifest = {
        "schema_version": 1,
        "case_id": value["case_id"],
        "synthetic_only": True,
        "consent_record_id": value["consent_record_id"],
        "truth_sha256": digest(TRUTH_PATH.read_bytes()),
        "files": {
            name: digest((output / name).read_bytes()) for name in ("visit.wav", "silence.wav")
        },
        "timeline": timeline,
        "generator": "macos-say-pcm16-v2",
    }
    validate_manifest(manifest, output)
    write_json(output / "manifest.json", manifest)
    return {
        "status": "synthetic_audio_generated",
        "case_id": value["case_id"],
        "truth_sha256": manifest["truth_sha256"],
        "file_count": 2,
        "microphone_opened": False,
        "turn_audio": turns,
        "visit_audio": read_wave(output / "visit.wav", speech=True)[1],
    }


def load_manifest(path: Path) -> dict:
    assert not path.is_symlink() and path.stat().st_size <= 65536
    value = json.loads(path.read_text())
    validate_manifest(value, path.parent)
    return value


def check_imported_receipt(evidence: dict) -> None:
    draft = evidence["draft"]
    uuid.UUID(draft["session_id"])
    source = draft["reviewed_source"]
    uuid.UUID(source["working_transcript_id"])
    assert (
        source["kind"] == "reviewed_english"
        and source["source_version"] > 0
        and source["working_version"] > 0
    )
    assert (
        draft["scribe_source_id"] == source["working_transcript_id"] and draft["status"] == "draft"
    )
    assert draft["review_required"] is True and re.fullmatch(
        r"[a-f0-9]{64}", draft["source_sha256"]
    )
    assert re.fullmatch(r"visit_note_[0-7][0-9a-hjkmnp-tv-z]{25}", draft["note_ref"])
    order, fields = draft["field_order"], draft["fields"]
    assert 0 < len(order) <= 100 and len(set(order)) == len(order) and set(order) == set(fields)
    assert all("\0" not in v for v in fields.values())
    payload = json.dumps([[k, fields[k]] for k in order], ensure_ascii=False, separators=(",", ":"))
    assert digest(payload.encode()) == draft["note_sha256"]


def grade(evidence: dict, manifest: dict | None = None) -> dict:
    from jiwer import (
        Compose,
        ReduceToListOfListOfWords,
        RemoveMultipleSpaces,
        RemovePunctuation,
        Strip,
        ToLowerCase,
        process_words,
    )

    value = truth()
    assert evidence["synthetic_only"] is True and evidence["case_id"] == value["case_id"]
    uuid.UUID(evidence["consent_record_id"])
    assert evidence["fixture_consent_record_id"] == value["consent_record_id"]
    assert evidence["evidence_kind"] in (
        "fixture_self_check",
        "imported_service_results",
        "authorized_broker_results",
    )
    if evidence["evidence_kind"] != "fixture_self_check":
        assert manifest is not None
        check_imported_receipt(evidence)
    segments = evidence["transcript"]
    assert isinstance(segments, list) and 0 < len(segments) <= 10000
    assert all(
        s["speaker_role"] in ("clinician", "patient", "other", "unknown")
        and isinstance(s["content"], str)
        for s in segments
    )
    fields = evidence["draft"]["fields"]
    assert isinstance(fields, dict) and all(
        isinstance(k, str) and isinstance(v, str) for k, v in fields.items()
    )
    normalized = Compose(
        [
            ToLowerCase(),
            RemovePunctuation(),
            RemoveMultipleSpaces(),
            Strip(),
            ReduceToListOfListOfWords(),
        ]
    )
    reference = " ".join(t["content"] for t in value["turns"])
    transcript = " ".join(s["content"] for s in segments)
    aligned = process_words(
        reference, transcript, reference_transform=normalized, hypothesis_transform=normalized
    )
    checks = [{"id": "transcript_wer", "pass": aligned.wer <= 0.15}]
    for marker, i in zip(value["markers"], ("early", "middle", "late"), strict=True):
        checks.append({"id": f"continuity_{i}", "pass": marker in transcript.casefold()})
    for fact in value["facts"]:
        # Patient echoes cannot replace clinician Plan evidence.
        spoken = " ".join(
            s["content"] for s in segments if s["speaker_role"] == fact["speaker_role"]
        )
        note = fields.get(fact["field"], "")
        checks.append(
            {
                "id": f"transcript_{fact['id']}",
                "pass": bool(re.search(fact["required"], spoken, re.I)),
            }
        )
        checks.append(
            {
                "id": f"note_{fact['id']}",
                "pass": bool(re.search(fact["required"], note, re.I))
                and not bool(re.search(fact["contradiction"], note, re.I)),
            }
        )
    checks.append(
        {"id": "silence_no_hallucination", "pass": evidence.get("silence_transcript") == []}
    )
    if manifest is not None:
        assert manifest["synthetic_only"] is True and manifest["case_id"] == value["case_id"]
        checks.append(
            {
                "id": "fixture_binding",
                "pass": evidence.get("truth_sha256")
                == manifest["truth_sha256"]
                == digest(TRUTH_PATH.read_bytes())
                and evidence.get("audio_sha256") == manifest["files"]["visit.wav"]
                and evidence.get("silence_audio_sha256") == manifest["files"]["silence.wav"],
            }
        )
    return {
        "schema_version": 1,
        "case_id": value["case_id"],
        "evidence_kind": evidence["evidence_kind"],
        "quality_checks_pass": all(c["pass"] for c in checks),
        "wer": round(aligned.wer, 6),
        "substitutions": aligned.substitutions,
        "deletions": aligned.deletions,
        "insertions": aligned.insertions,
        "checks": checks,
        "clinical_correctness_proven": False,
        "native_startup_measured": False,
        "scope": "fixed reference facts; semantic rubric/clinical calibration remain separate",
    }


def self_check() -> dict:
    value = truth()
    good = {
        "synthetic_only": True,
        "case_id": value["case_id"],
        "consent_record_id": value["consent_record_id"],
        "fixture_consent_record_id": value["consent_record_id"],
        "evidence_kind": "fixture_self_check",
        "transcript": value["turns"],
        "draft": {"fields": value["reference_note"]},
        "silence_transcript": [],
    }
    assert grade(good)["quality_checks_pass"]
    trials = {}
    for code, field, replacement in (
        ("missing_plan", "Plan", ""),
        (
            "contradictory_followup",
            "Plan",
            "Keep a sleep diary for fourteen days. No new medication. Follow up in six weeks.",
        ),
        ("reversed_negation", "Subjective", "Trouble sleeping for two nights. Reports fever."),
        ("uncorrected_duration", "Subjective", "Trouble sleeping for four nights. Denies fever."),
    ):
        bad = copy.deepcopy(good)
        bad["draft"]["fields"][field] = replacement
        trials[code] = not grade(bad)["quality_checks_pass"]
    bad = copy.deepcopy(good)
    bad["silence_transcript"] = ["Invented speech on silence"]
    trials["hallucinated_silence"] = not grade(bad)["quality_checks_pass"]
    bad = copy.deepcopy(good)
    bad["transcript"] = bad["transcript"][:-1]
    trials["lost_late_audio"] = not grade(bad)["quality_checks_pass"]
    # Exercise canonical receipt validation without labeling this generated receipt live.
    fields = value["reference_note"]
    payload = json.dumps(list(fields.items()), ensure_ascii=False, separators=(",", ":"))
    receipt = {
        "session_id": str(uuid.uuid4()),
        "scribe_source_id": str(uuid.uuid4()),
        "status": "draft",
        "review_required": True,
        "source_sha256": "a" * 64,
        "note_ref": "visit_note_01j00000000000000000000000",
        "fields": fields,
        "field_order": list(fields),
        "note_sha256": digest(payload.encode()),
    }
    receipt["reviewed_source"] = {
        "kind": "reviewed_english",
        "source_version": 1,
        "working_version": 1,
        "working_transcript_id": receipt["scribe_source_id"],
    }
    check_imported_receipt({"draft": receipt})
    altered = copy.deepcopy(receipt)
    altered["fields"]["Plan"] = "Altered synthetic saved result."
    try:
        check_imported_receipt({"draft": altered})
        trials["receipt_tamper"] = False
    except AssertionError:
        trials["receipt_tamper"] = True
    assert all(trials.values())
    return {
        "status": "fixture_self_checks_passed",
        "negative_cases": trials,
        "live_services_run": False,
        "clinical_correctness_proven": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("self-check", "fixtures", "grade"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args()
    try:
        if args.mode == "fixtures":
            assert args.output is not None
            report = fixtures(args.output)
        elif args.mode == "self-check":
            report = self_check()
        else:
            raw = sys.stdin.buffer.read(MAX_INPUT + 1)
            assert len(raw) <= MAX_INPUT
            report = grade(json.loads(raw), load_manifest(args.manifest) if args.manifest else None)
        if args.output and args.mode != "fixtures":
            write_json(args.output, report)
        print(json.dumps(report, separators=(",", ":")))
        return 0 if report.get("quality_checks_pass", True) else 1
    except Exception:
        print(
            '{"status":"evaluation_failed","failure_code":"invalid_input_or_dependency_or_fixture"}'
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
