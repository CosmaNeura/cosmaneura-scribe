"""Check invented desktop PCM golden bytes with exact rational arithmetic."""

import json
import struct
from fractions import Fraction
from pathlib import Path

# Explicit consent precedes this generated-audio processing path. No external
# recording, device, user content, credential or network input is accepted.
CONSENT = {"id": "desktop-mixer-invented-consent-v1", "all_parties_agreed": True}
ROOT = Path(__file__).resolve().parents[1]
FIXTURE = (
    ROOT
    / "apps/desktop-companion/native/ScribeDesktopAudio/Tests"
    / "ScribeDesktopAudioTests/Fixtures/host-aligned-area-v1.json"
)


def main() -> None:
    assert CONSENT["all_parties_agreed"] is True
    fixture = json.loads(FIXTURE.read_text())
    assert fixture["conversion_version"] == "host-aligned-area-v1"
    values = [
        Fraction(value)
        for (value,) in struct.iter_unpack("<f", bytes.fromhex(fixture["input_pcm_f32le_hex"]))
    ]
    for case in fixture["cases"]:
        counts, starts = case["frame_counts"], case["host_offsets_ns"]
        slope = Fraction(starts[-1] - starts[-2], counts[-2])
        end = starts[-1] + int(counts[-1] * slope + Fraction(1, 2))
        assert end == case["expected_end_offset_ns"]
        spans: list[tuple[Fraction, Fraction, Fraction]] = []
        offset = 0
        for low, high, count in zip(starts, starts[1:] + [end], counts, strict=True):
            for index in range(count):
                spans.append(
                    (
                        low + Fraction(index * (high - low), count),
                        low + Fraction((index + 1) * (high - low), count),
                        values[offset + index],
                    )
                )
            offset += count
        assert offset == len(values)
        output: list[int] = []
        for low in range(starts[0], end, 62_500):
            high = min(end, low + 62_500)
            area = sum(
                (max(Fraction(0), min(b, high) - max(a, low)) * v for a, b, v in spans),
                Fraction(0),
            )
            mean = area / (high - low)
            rounded = mean * (32768 if mean < 0 else 32767) + Fraction(1, 2)
            output.append(rounded.numerator // rounded.denominator)
        actual = b"".join(struct.pack("<h", value) for value in output).hex()
        assert actual == case["expected_pcm_s16le_hex"]
    print(f"{len(fixture['cases'])} exact-rational desktop mixer goldens verified")


if __name__ == "__main__":
    main()
